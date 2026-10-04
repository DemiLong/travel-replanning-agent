import assert from "node:assert/strict";
import { createAnalyticsService, type AnalyticsEvent } from "../services/analytics";
import {
  createBrowserSessionRepository,
  legacyFallbackSnapshotKey,
  legacyRealSessionBackupKey,
  legacyRealSessionKey,
  legacyRealSessionV3BackupKey,
  legacyRealSessionV3Key,
  legacySnapshotKey,
  realSessionKey,
} from "../services/browser-session-repository";
import { createItineraryDraft } from "../services/itinerary-draft-store";
import { createPendingPlanStore } from "../services/pending-plan-store";
import { createSessionStore } from "../services/session-store";
import { createStarterSnapshot } from "../data/session-defaults";
import {
  ConfirmedDraftSchema,
  ParsedUserInputSchema,
  RealSessionSchema,
  SnapshotSchema,
  type RealSession,
} from "../types";

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  };
}

function session(): RealSession {
  const snapshot = SnapshotSchema.parse({
    ...createStarterSnapshot(),
    state: {
      ...createStarterSnapshot().state,
      currentTime: "08:30",
      stateCapturedAt: "2020-01-01T00:00:00.000Z",
    },
    revision: 0,
  });
  return RealSessionSchema.parse({
    schemaVersion: 4,
    experienceMode: "real",
    flowStage: "NO_ITINERARY",
    snapshot,
    rawInput: "保留的输入",
    parsedInput: null,
    lastDisruption: null,
    pendingPlan: null,
    resolutionState: {
      currentBlockerKey: null,
      sameBlockerCount: 0,
      roundCount: 0,
      answeredFields: [],
      questionHistory: [],
    },
    updatedAt: "2020-01-01T00:00:00.000Z",
  });
}

function parsedInput(base: RealSession["snapshot"], rawText = "下雨了") {
  return ParsedUserInputSchema.parse({
    rawText,
    intent: "rescue",
    activityFacts: [],
    disruptions: [{ kind: "weather", label: "下雨", source: "user" }],
    constraints: [],
    context: base.state,
    contextSources: { ...base.stateSources, disruption: "user" },
    missingFacts: [],
    status: "confirmed",
    parser: "manual",
  });
}

async function main() {
  const repositoryStorage = createStorage();
  const repository = createBrowserSessionRepository(repositoryStorage.storage);
  repository.writeJson("json", { value: 1 });
  assert.deepEqual(repository.readJson("json"), { value: 1 });
  repository.writeRaw("invalid", "{");
  assert.throws(() => repository.readJson("invalid"), SyntaxError);

  const v2Storage = createStorage();
  const v2Repository = createBrowserSessionRepository(v2Storage.storage);
  const original = session();
  const v3Storage=createStorage();
  const v3Repository=createBrowserSessionRepository(v3Storage.storage);
  const v3Raw=`  ${JSON.stringify({...original,schemaVersion:3})}`;
  v3Repository.writeRaw(legacyRealSessionV3Key,v3Raw);
  const migratedV3=createSessionStore(v3Repository).loadPersisted();
  assert.equal(v3Repository.readRaw(legacyRealSessionV3BackupKey),v3Raw);
  assert.equal(migratedV3.schemaVersion,4);

  const nestedV3Storage=createStorage();
  const nestedV3Repository=createBrowserSessionRepository(nestedV3Storage.storage);
  const legacyPlan={
    id:"old-plan",
    name:"旧草稿活动",
    startTime:"10:00",
    endTime:null,
    durationMinutes:30,
    location:"旧地点",
    locked:false,
    source:"user",
  };
  const currentParsed=parsedInput(original.snapshot,"旧版解析原文");
  const legacyParsed={...currentParsed,activityFacts:undefined,existingPlans:[legacyPlan],activityMentions:[]};
  const currentDraft=createItineraryDraft(original);
  const legacyDraft={...currentDraft,activityFacts:undefined,items:[legacyPlan]};
  const legacyConfirmed={
    rawText:legacyParsed.rawText,
    intent:legacyParsed.intent,
    existingPlans:[legacyPlan],
    activityMentions:[],
    disruptions:legacyParsed.disruptions,
    constraints:legacyParsed.constraints,
    context:legacyParsed.context,
    contextSources:legacyParsed.contextSources,
    closedPlaceIds:[],
    baseRevision:original.snapshot.revision,
  };
  const legacyRequest={
    reason:"weather",
    freeText:legacyParsed.rawText,
    currentState:original.snapshot.state,
    closedPlaceIds:[],
    variation:0,
    stateSources:original.snapshot.stateSources,
  };
  const legacyPendingPlan={
    result:{
      id:"legacy-plan",
      ok:false,
      plan:null,
      attempts:[],
      mode:"local",
      model:"legacy-test",
      message:"旧方案",
      context:{
        profile:original.snapshot.profile,
        trip:original.snapshot.trip,
        state:original.snapshot.state,
        stateSources:original.snapshot.stateSources,
        existingItinerary:[],
        lockedEvents:[],
        remainingEvents:[],
        disruption:legacyRequest,
        places:[],
        travelMinutes:{},
      },
    },
    base:original.snapshot,
    request:legacyRequest,
    accepted:false,
    parsedInput:legacyParsed,
  };
  const nestedV3Raw=JSON.stringify({
    ...original,
    schemaVersion:3,
    parsedInput:legacyParsed,
    itineraryDraft:legacyDraft,
    pendingInput:{
      stage:"follow_up",
      parsedInput:legacyParsed,
      confirmedDraft:legacyConfirmed,
      missingFact:null,
      questionRawText:legacyParsed.rawText,
      baseRevision:original.snapshot.revision,
    },
    pendingPlan:legacyPendingPlan,
  });
  nestedV3Repository.writeRaw(legacyRealSessionV3Key,nestedV3Raw);
  const migratedNestedV3=createSessionStore(nestedV3Repository).loadPersisted();
  assert.equal(nestedV3Repository.readRaw(legacyRealSessionV3BackupKey),nestedV3Raw);
  assert.equal(migratedNestedV3.parsedInput?.activityFacts[0].id,"old-plan");
  assert.equal(migratedNestedV3.parsedInput?.activityFacts[0].placeId,"custom-old-plan");
  assert.equal(migratedNestedV3.parsedInput?.activityFacts[0].endTime,"10:30");
  assert.equal(migratedNestedV3.parsedInput?.activityFacts[0].durationSource,"user");
  assert.equal(migratedNestedV3.itineraryDraft?.activityFacts[0].id,"old-plan");
  assert.equal(migratedNestedV3.pendingInput?.parsedInput.activityFacts[0].id,"old-plan");
  assert.equal(migratedNestedV3.pendingInput?.confirmedDraft.activityFacts[0].id,"old-plan");
  assert.equal(migratedNestedV3.pendingPlan?.request.activityFacts[0].id,"old-plan");
  assert.equal(migratedNestedV3.pendingPlan?.result.context.activityFacts[0].id,"old-plan");

  const v2Raw = `  ${JSON.stringify({ schemaVersion: 2, rawInput: "v2 原文", snapshot: original.snapshot })}`;
  v2Repository.writeRaw(legacyRealSessionKey, v2Raw);
  const v2Store = createSessionStore(v2Repository);
  const migratedV2 = v2Store.loadPersisted();
  assert.equal(v2Repository.readRaw(legacyRealSessionBackupKey), v2Raw);
  assert.equal(migratedV2.schemaVersion, 4);
  assert.equal(migratedV2.rawInput, "v2 原文");
  assert.equal(migratedV2.snapshot.revision, original.snapshot.revision);

  const legacyStorage = createStorage();
  const legacyRepository = createBrowserSessionRepository(legacyStorage.storage);
  legacyRepository.writeJson(legacySnapshotKey, {
    ...original.snapshot,
    trip: { ...original.snapshot.trip, destination: "旧城市" },
  });
  const migratedLegacy = createSessionStore(legacyRepository).loadPersisted();
  assert.equal(migratedLegacy.snapshot.trip.destination, "旧城市");
  assert(legacyRepository.readRaw(realSessionKey));

  const demoStorage = createStorage();
  const demoRepository = createBrowserSessionRepository(demoStorage.storage);
  demoRepository.writeJson(legacySnapshotKey, {
    ...original.snapshot,
    mode: "demo",
    trip: { ...original.snapshot.trip, destination: "演示城市" },
  });
  const demoFallback = createSessionStore(demoRepository).loadPersisted();
  assert.equal(demoFallback.snapshot.mode, "user");
  assert.equal(demoFallback.snapshot.trip.destination, "待确认城市");

  const damagedStorage = createStorage();
  const damagedRepository = createBrowserSessionRepository(damagedStorage.storage);
  damagedRepository.writeRaw(realSessionKey, "{");
  damagedRepository.writeJson(legacyFallbackSnapshotKey, {
    ...original.snapshot,
    trip: { ...original.snapshot.trip, destination: "损坏后回退城市" },
  });
  const recovered = createSessionStore(damagedRepository).loadPersisted();
  assert.equal(recovered.snapshot.trip.destination, "损坏后回退城市");

  const protectedStorage = createStorage();
  const protectedRepository = createBrowserSessionRepository(protectedStorage.storage);
  const lockedSnapshot = SnapshotSchema.parse({
    ...original.snapshot,
    itinerary: [{
      id: "locked-event",
      placeId: "locked-place",
      name: "固定预约",
      category: "user activity",
      startTime: "10:00",
      endTime: "11:00",
      durationSource: "user",
      location: "固定地点",
      status: "locked",
      locked: true,
      indoorOutdoor: "mixed",
      openingTime: null,
      closingTime: null,
      travelTimeFromPrevious: null,
      reason: "用户固定安排",
      constraint: "固定预约",
    }],
  });
  protectedRepository.writeJson(legacyRealSessionV3Key, {
    ...original,
    schemaVersion:3,
    snapshot: lockedSnapshot,
  });
  const protectedLoaded = createSessionStore(protectedRepository).loadPersisted();
  assert(protectedLoaded.snapshot.itinerary[0].protectionPolicy);
  const rawProtected = JSON.parse(protectedRepository.readRaw(legacyRealSessionV3BackupKey) ?? "null") as RealSession;
  assert.equal(rawProtected.snapshot.itinerary[0].protectionPolicy, undefined);

  const repairStorage = createStorage();
  const repairRepository = createBrowserSessionRepository(repairStorage.storage);
  const changedSnapshot = SnapshotSchema.parse({
    ...original.snapshot,
    revision: 1,
  });
  repairRepository.writeJson(realSessionKey, {
    ...original,
    snapshot: changedSnapshot,
    itineraryDraft: createItineraryDraft(original),
  });
  const repairedDraft = createSessionStore(repairRepository).loadPersisted();
  assert.equal(repairedDraft.itineraryDraft, null);
  assert.equal(
    (JSON.parse(repairRepository.readRaw(realSessionKey) ?? "null") as RealSession).itineraryDraft,
    null,
  );

  const pendingStorage = createStorage();
  const pendingRepository = createBrowserSessionRepository(pendingStorage.storage);
  const parsed = parsedInput(original.snapshot, "需要保留的补问原文");
  const confirmedDraft = ConfirmedDraftSchema.parse({
    rawText: parsed.rawText,
    intent: parsed.intent,
    activityFacts: parsed.activityFacts,
    disruptions: parsed.disruptions,
    constraints: parsed.constraints,
    context: parsed.context,
    contextSources: parsed.contextSources,
    baseRevision: original.snapshot.revision,
  });
  pendingRepository.writeJson(realSessionKey, {
    ...original,
    rawInput: "",
    parsedInput: parsed,
    flowStage: "NEEDS_INPUT",
    pendingInput: {
      stage: "review",
      parsedInput: parsed,
      confirmedDraft,
      missingFact: null,
      questionRawText: parsed.rawText,
      baseRevision: original.snapshot.revision,
    },
    resolutionState: {
      currentBlockerKey: "location",
      sameBlockerCount: 1,
      roundCount: 1,
      answeredFields: [],
      questionHistory: ["location"],
    },
  });
  const repairedPending = createSessionStore(pendingRepository).loadPersisted();
  assert.equal(repairedPending.pendingInput, null);
  assert.equal(repairedPending.parsedInput, null);
  assert.equal(repairedPending.rawInput, parsed.rawText);
  assert.equal(repairedPending.resolutionState.roundCount, 0);

  const pendingPlanStorage = createStorage();
  const pendingPlanRepository = createBrowserSessionRepository(pendingPlanStorage.storage);
  pendingPlanRepository.writeJson(realSessionKey, original);
  const pendingSessionStore = createSessionStore(pendingPlanRepository);
  const originalSnapshot = pendingSessionStore.loadPersisted().snapshot;
  createPendingPlanStore(pendingSessionStore).clearPendingPlan();
  assert.deepEqual(pendingSessionStore.loadPersisted().snapshot, originalSnapshot);

  const analyticsStorage = createStorage();
  const analyticsRepository = createBrowserSessionRepository(analyticsStorage.storage);
  const analytics = createAnalyticsService(analyticsRepository);
  const existing: AnalyticsEvent[] = Array.from({ length: 1000 }, (_, index) => ({
    id: `event-${index}`,
    name: "replan_started",
    created_at: "2020-01-01T00:00:00.000Z",
    properties: {},
  }));
  analyticsRepository.writeRaw("travel-analytics", JSON.stringify(existing));
  assert.equal(await analytics.logEvent("replan_accepted", { planId: "plan" }, "new-event"), true);
  let storedAnalytics = JSON.parse(analyticsRepository.readRaw("travel-analytics") ?? "[]") as AnalyticsEvent[];
  assert.equal(storedAnalytics.length, 1000);
  assert.equal(storedAnalytics[0].id, "event-1");
  assert.equal(storedAnalytics.at(-1)?.id, "new-event");
  assert.equal(await analytics.logEvent("replan_accepted", { planId: "plan" }, "new-event"), true);
  storedAnalytics = JSON.parse(analyticsRepository.readRaw("travel-analytics") ?? "[]") as AnalyticsEvent[];
  assert.equal(storedAnalytics.length, 1000);

  console.log("Session repository and migration tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
