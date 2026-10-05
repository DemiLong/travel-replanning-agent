import assert from "node:assert/strict";

import { createStarterSnapshot } from "../data/session-defaults";
import {
  createAnalyticsService,
  type AnalyticsEvent,
} from "../services/analytics";
import {
  createBrowserSessionRepository,
  realSessionKey,
} from "../services/browser-session-repository";
import { createItineraryDraft } from "../services/itinerary-draft-store";
import { createPendingPlanStore } from "../services/pending-plan-store";
import { createSessionStore } from "../services/session-store";
import {
  ConfirmedDraftSchema,
  PendingPlanSchema,
  ParsedUserInputSchema,
  RealSessionSchema,
  ReplanningRequestSchema,
  SnapshotSchema,
  type RealSession,
} from "../types";

function createStorage() {
  const values = new Map<string, string>();
  const reads: string[] = [];
  return {
    values,
    reads,
    storage: {
      getItem: (key: string) => {
        reads.push(key);
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => values.set(key, value),
    },
  };
}

function session(): RealSession {
  const starter = createStarterSnapshot();
  const snapshot = SnapshotSchema.parse({
    ...starter,
    state: {
      ...starter.state,
      currentTime: "08:30",
      stateCapturedAt: "2020-01-01T00:00:00.000Z",
    },
    revision: 0,
  });
  return RealSessionSchema.parse({
    schemaVersion: 5,
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

  const original = session();
  repository.writeJson(realSessionKey, original);
  assert.deepEqual(createSessionStore(repository).loadPersisted(), original);

  const oldOnlyStorage = createStorage();
  const oldOnlyRepository = createBrowserSessionRepository(
    oldOnlyStorage.storage,
  );
  const oldKeys = [
    "travel-session-real-v4",
    "travel-session-real-v3",
    "travel-session-real-v2",
    "travel-snapshot-user",
    "travel-snapshot",
  ];
  for (const key of oldKeys)
    oldOnlyRepository.writeRaw(key, `old-value-${key}`);
  const oldV4Raw = `  ${JSON.stringify({ ...original, schemaVersion: 4 })}`;
  oldOnlyRepository.writeRaw(oldKeys[0], oldV4Raw);
  const fresh = createSessionStore(oldOnlyRepository).loadPersisted();
  assert.deepEqual(
    oldOnlyStorage.reads,
    [realSessionKey],
    "only the v5 key is read",
  );
  assert.equal(fresh.schemaVersion, 5);
  assert.equal(fresh.snapshot.trip.destination, "待确认城市");
  assert.equal(oldOnlyRepository.readRaw(oldKeys[0]), oldV4Raw);
  for (const key of oldKeys.slice(1)) {
    assert.equal(oldOnlyRepository.readRaw(key), `old-value-${key}`);
  }
  assert(oldOnlyRepository.readRaw(realSessionKey));

  const damagedStorage = createStorage();
  const damagedRepository = createBrowserSessionRepository(
    damagedStorage.storage,
  );
  damagedRepository.writeRaw(realSessionKey, "{");
  damagedRepository.writeRaw("travel-session-real-v4", "old-v4");
  const recovered = createSessionStore(damagedRepository).loadPersisted();
  assert.equal(recovered.schemaVersion, 5);
  assert.equal(recovered.snapshot.trip.destination, "待确认城市");
  assert.equal(damagedRepository.readRaw("travel-session-real-v4"), "old-v4");
  damagedRepository.writeJson(realSessionKey, {
    ...original,
    schemaVersion: 4,
  });
  assert.equal(
    createSessionStore(damagedRepository).loadPersisted().rawInput,
    "",
  );

  const repairStorage = createStorage();
  const repairRepository = createBrowserSessionRepository(
    repairStorage.storage,
  );
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
    (
      JSON.parse(
        repairRepository.readRaw(realSessionKey) ?? "null",
      ) as RealSession
    ).itineraryDraft,
    null,
  );

  const pendingStorage = createStorage();
  const pendingRepository = createBrowserSessionRepository(
    pendingStorage.storage,
  );
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
    snapshot: changedSnapshot,
    flowStage: "NEEDS_INPUT",
    pendingInput: {
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
  const currentPending = {
    parsedInput: parsed,
    confirmedDraft,
    missingFact: null,
    questionRawText: parsed.rawText,
    baseRevision: original.snapshot.revision,
  };
  pendingRepository.writeJson(realSessionKey, {
    ...original,
    pendingInput: currentPending,
  });
  const restoredPending = createSessionStore(pendingRepository).loadPersisted();
  assert.deepEqual(restoredPending.pendingInput, currentPending);

  const pendingPlanStorage = createStorage();
  const pendingPlanRepository = createBrowserSessionRepository(
    pendingPlanStorage.storage,
  );
  pendingPlanRepository.writeJson(realSessionKey, original);
  const pendingSessionStore = createSessionStore(pendingPlanRepository);
  const originalSnapshot = pendingSessionStore.loadPersisted().snapshot;
  const request = ReplanningRequestSchema.parse({
    reason: "weather",
    freeText: "下雨了",
    currentState: originalSnapshot.state,
    closedPlaceIds: [],
    variation: 0,
    activityFacts: [],
  });
  const pendingPlan = PendingPlanSchema.parse({
    base: originalSnapshot,
    request,
    result: {
      id: "plan",
      ok: false,
      plan: null,
      attempts: [],
      mode: "local",
      model: "test",
      message: "待处理方案",
      context: {
        profile: originalSnapshot.profile,
        trip: originalSnapshot.trip,
        state: originalSnapshot.state,
        stateSources: originalSnapshot.stateSources,
        activityFacts: [],
        remainingActivityFacts: [],
        protectedActivityFacts: [],
        disruption: request,
        places: [],
        travelMinutes: {},
      },
    },
  });
  const plans = createPendingPlanStore(pendingSessionStore);
  plans.savePendingPlan(pendingPlan, request);
  assert.deepEqual(
    pendingSessionStore.loadPersisted().snapshot,
    originalSnapshot,
  );
  assert.deepEqual(
    pendingSessionStore.loadPersisted().pendingPlan,
    pendingPlan,
  );
  plans.clearPendingPlan();
  assert.deepEqual(
    pendingSessionStore.loadPersisted().snapshot,
    originalSnapshot,
  );
  assert.equal(pendingSessionStore.loadPersisted().pendingPlan, null);

  const analyticsStorage = createStorage();
  const analyticsRepository = createBrowserSessionRepository(
    analyticsStorage.storage,
  );
  const analytics = createAnalyticsService(analyticsRepository);
  const existing: AnalyticsEvent[] = Array.from(
    { length: 1000 },
    (_, index) => ({
      id: `event-${index}`,
      name: "replan_started",
      created_at: "2020-01-01T00:00:00.000Z",
      properties: {},
    }),
  );
  analyticsRepository.writeRaw("travel-analytics", JSON.stringify(existing));
  assert.equal(
    await analytics.logEvent(
      "replan_accepted",
      { planId: "plan" },
      "new-event",
    ),
    true,
  );
  let storedAnalytics = JSON.parse(
    analyticsRepository.readRaw("travel-analytics") ?? "[]",
  ) as AnalyticsEvent[];
  assert.equal(storedAnalytics.length, 1000);
  assert.equal(storedAnalytics[0].id, "event-1");
  assert.equal(storedAnalytics.at(-1)?.id, "new-event");
  assert.equal(
    await analytics.logEvent(
      "replan_accepted",
      { planId: "plan" },
      "new-event",
    ),
    true,
  );
  storedAnalytics = JSON.parse(
    analyticsRepository.readRaw("travel-analytics") ?? "[]",
  ) as AnalyticsEvent[];
  assert.equal(storedAnalytics.length, 1000);

  console.log("Session repository and current-session tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
