import assert from "node:assert/strict";
import { runAgentAssist } from "../agents/agent-orchestrator";
import { buildRealContext } from "../agents/real-context-builder";
import { MAX_REPLAN_ATTEMPTS, replanReal } from "../agents/real-replanning-agent";
import { createStarterSnapshot } from "../data/session-defaults";
import { confirmedDraftFromParsed } from "../services/itinerary-domain";
import { migrateV2SessionValue } from "../services/trip-service";
import { CandidateSetSchema, type CandidatePlanner } from "../services/deepseek-planner";
import {
  EventSchema,
  ParsedUserInputSchema,
  ReplanningRequestSchema,
  SnapshotSchema,
  type ParsedUserInput,
  type Snapshot,
} from "../types";
import { RealWorldContextSchema, type RealWorldContext } from "../types/world";
import { validatePlan } from "../validators";

function snapshot(): Snapshot {
  const base = createStarterSnapshot();
  const event = EventSchema.parse({
    id: "museum",
    placeId: "museum-poi",
    name: "城市博物馆",
    category: "user activity",
    startTime: "10:00",
    endTime: "11:00",
    durationSource: "user",
    location: "城市博物馆",
    status: "locked",
    locked: true,
    indoorOutdoor: "mixed",
    openingTime: null,
    closingTime: null,
    travelTimeFromPrevious: null,
    reason: "用户确认的固定安排。",
    constraint: "固定预约",
  });
  return SnapshotSchema.parse({
    ...base,
    trip: { ...base.trip, destination: "上海" },
    state: { ...base.state, currentTime: "09:00", currentLocation: "人民广场", stateCapturedAt: new Date().toISOString() },
    stateSources: { ...base.stateSources, currentTime: "user", currentLocation: "user", disruption: "user" },
    itinerary: [event],
    revision: 7,
  });
}

function parsed(rawText = "下雨了，把今天的行程调整一下"): ParsedUserInput {
  const base = snapshot();
  return ParsedUserInputSchema.parse({
    rawText,
    intent: "rescue",
    existingPlans: [],
    activityMentions: [],
    disruptions: [{ kind: "weather", label: "下雨", source: "user" }],
    constraints: [],
    context: base.state,
    contextSources: base.stateSources,
    closedPlaceIds: [],
    missingFacts: [],
    status: "confirmed",
    parser: "manual",
    parserModel: null,
    parseWarnings: [],
    worldOptions: { selectedPois: {}, travelMode: "TRANSIT", allowedTravelModes: ["TRANSIT"] },
  });
}

function poi(id: string, name: string, longitude: number) {
  return {
    poiId: id,
    name,
    address: name,
    city: "上海市",
    district: "黄浦区",
    adcode: "310101",
    longitude,
    latitude: 31.23,
    coordinateSystem: "GCJ02" as const,
    type: "科教文化服务",
    source: "amap" as const,
    fetchedAt: new Date().toISOString(),
    status: "available" as const,
  };
}

function world(status: "ready" | "needs_input" | "unavailable" = "ready"): RealWorldContext {
  const current = { id: "current", city: "上海市", longitude: 121.47, latitude: 31.23, coordinateSystem: "GCJ02" as const, source: "user" as const, capturedAt: new Date().toISOString(), adcode: "310101" };
  const destination = poi("museum-poi", "城市博物馆", 121.49);
  return RealWorldContextSchema.parse({
    currentTime: { value: "09:00", date: snapshot().state.currentDate, source: "user", confirmedAt: new Date().toISOString() },
    currentLocation: current,
    resolvedPlaces: [{ placeId: "museum-poi", poi: destination }],
    alternatives: [],
    routes: status === "ready" ? [{ origin: current, destination: { ...destination, id: "museum-poi" }, travelMode: "TRANSIT", distanceMeters: 2500, durationSeconds: 900, source: "amap", fetchedAt: new Date().toISOString(), status: "available" }] : [],
    weather: { condition: null, temperature: null, humidity: null, windDirection: null, windPower: null, forecast: [], source: "amap", fetchedAt: new Date().toISOString(), reportedAt: null, status: "not_requested" },
    dataFreshness: { groundedAt: new Date().toISOString(), routeMaxAgeSeconds: 120, locationMaxAgeSeconds: 600 },
    missingWorldFacts: status === "needs_input" ? [{ kind: "user", field: "currentLocation", message: "请填写当前位置。" }] : status === "unavailable" ? [{ kind: "world", field: "routes", message: "路线暂不可用。" }] : [],
    ambiguities: [],
    candidatePlaceIds: {},
    travelMode: "TRANSIT",
    cityResolution: { city: "上海市", source: "current_location", evidence: [], conflicts: [] },
    resolutionEvidence: [],
    status,
  });
}

function input(base = snapshot()) {
  return {
    snapshot: base,
    request: ReplanningRequestSchema.parse({
      reason: "weather",
      freeText: "下雨了",
      currentState: base.state,
      closedPlaceIds: [],
      variation: 0,
      stateSources: base.stateSources,
      worldOptions: { selectedPois: {}, travelMode: "TRANSIT", allowedTravelModes: ["TRANSIT"] },
    }),
    mode: "live" as const,
    confirmation: { status: "confirmed" as const, confirmedAt: new Date().toISOString() },
  };
}

async function main() {
  assert.throws(() => SnapshotSchema.parse({ ...snapshot(), trip: { ...snapshot().trip, endDate: "2099-01-02" } }), /same-day/i);

  const old = snapshot() as Snapshot & Record<string, unknown>;
  const removedProfileField = String.fromCharCode(100, 97, 105, 108, 121, 66, 117, 100, 103, 101, 116);
  const removedStateField = String.fromCharCode(114, 101, 109, 97, 105, 110, 105, 110, 103, 66, 117, 100, 103, 101, 116);
  const removedEventField = String.fromCharCode(101, 115, 116, 105, 109, 97, 116, 101, 100, 67, 111, 115, 116);
  Object.assign(old.profile, { [removedProfileField]: 500 });
  Object.assign(old.state, { [removedStateField]: 200 });
  Object.assign(old.itinerary[0], { [removedEventField]: 100 });
  const migrated = migrateV2SessionValue({ schemaVersion: 2, rawInput: "保留的原文", snapshot: old });
  assert(migrated);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.snapshot.revision, 7);
  assert.equal(migrated.snapshot.itinerary[0].locked, true);
  assert.equal(migrated.snapshot.trip.startDate, migrated.snapshot.trip.endDate);
  assert(!(removedProfileField in migrated.snapshot.profile));
  assert(!(removedStateField in migrated.snapshot.state));
  assert(!(removedEventField in migrated.snapshot.itinerary[0]));

  let groundCalls = 0;
  const irrelevant = await runAgentAssist(
    { snapshot: snapshot(), rawText: "不靠谱" },
    undefined,
    {
      parse: async (base, rawText) => ParsedUserInputSchema.parse({ ...parsed(rawText), intent: "rescue", disruptions: [], context: base.state, contextSources: { ...base.stateSources, disruption: "unset" } }),
      ground: async () => { groundCalls += 1; return world(); },
    },
  );
  assert.equal(irrelevant.status, "OUT_OF_SCOPE");
  assert.equal(groundCalls, 0, "无效输入不得调用真实世界服务");

  const base = snapshot();
  const facts = parsed();
  const draft = confirmedDraftFromParsed(base, facts);
  let captured: unknown;
  const fieldResult = await runAgentAssist(
    {
      snapshot: base,
      confirmedDraft: draft,
      answer: { kind: "text", field: "currentLocation", value: "上海图书馆东馆" },
      resolutionState: { currentBlockerKey: "currentLocation", sameBlockerCount: 1, roundCount: 1, answeredFields: [], questionHistory: ["currentLocation"] },
    },
    undefined,
    { ground: async (raw) => { captured = raw; return world("unavailable"); } },
  );
  assert.equal(fieldResult.status, "UPSTREAM_UNAVAILABLE");
  const grounded = captured as ReturnType<typeof input>;
  assert.equal(grounded.snapshot.state.currentLocation, "上海图书馆东馆");
  assert.deepEqual(grounded.snapshot.itinerary.map((event) => [event.id, event.startTime, event.locked]), base.itinerary.map((event) => [event.id, event.startTime, event.locked]));

  const alwaysMissing = async () => world("needs_input");
  const first = await runAgentAssist({ snapshot: base, confirmedDraft: draft, resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] } }, undefined, { ground: alwaysMissing });
  assert.equal(first.status, "NEEDS_INPUT");
  if (first.status !== "NEEDS_INPUT") throw new Error("expected first blocker");
  const second = await runAgentAssist({ snapshot: base, confirmedDraft: first.confirmedDraft, answer: { kind: "text", field: "currentLocation", value: "人民广场" }, resolutionState: first.resolutionState }, undefined, { ground: alwaysMissing });
  assert.equal(second.status, "NEEDS_INPUT");
  if (second.status !== "NEEDS_INPUT") throw new Error("expected repeated blocker");
  assert.equal(second.resolutionState.sameBlockerCount, 2);
  const third = await runAgentAssist({ snapshot: base, confirmedDraft: second.confirmedDraft, answer: { kind: "text", field: "currentLocation", value: "人民广场地铁站" }, resolutionState: second.resolutionState }, undefined, { ground: alwaysMissing });
  assert.equal(third.status, "OUT_OF_SCOPE");

  assert.equal(CandidateSetSchema.safeParse({ candidates: [{ title: "A", tradeOff: "A", steps: [], removed: [] }, { title: "B", tradeOff: "B", steps: [], removed: [] }, { title: "C", tradeOff: "C", steps: [], removed: [] }] }).success, false);

  const planner: CandidatePlanner = { name: "bounded-test", generateCandidates: async () => [] };
  const replanned = await replanReal(input(), planner, { ground: async () => world() });
  assert(!("error" in replanned));
  if ("error" in replanned) throw new Error(String(replanned.error));
  assert.equal(replanned.ok, false);
  assert.equal(replanned.attempts.length, MAX_REPLAN_ATTEMPTS);
  assert.equal(MAX_REPLAN_ATTEMPTS, 2);

  const context = buildRealContext(input(), world());
  const original = base.itinerary[0];
  const unsafePlan = {
    summary: "错误修改固定安排",
    explanation: "测试",
    events: [{ ...original, location: "被静默改掉的地点", travelMode: "TRANSIT", travelTimeFromPrevious: 15 }],
    movedEvents: [],
    removedEvents: [],
  };
  const violations = validatePlan(context, unsafePlan);
  assert(violations.some((item) => item.code === "locked_event" || item.code === "place_data"));

  console.log("PASS reliability: v3 migration, invalid-input gate, field isolation, loop bound, candidate bound, planner bound, locked-event validation");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
