import assert from "node:assert/strict";
import { runAgentAssist } from "../agents/agent-orchestrator";
import { buildRealContext } from "../agents/real-context-builder";
import { MAX_REPLAN_ATTEMPTS, replanReal } from "../agents/real-replanning-agent";
import { createStarterSnapshot } from "../data/session-defaults";
import { confirmedDraftFromParsed } from "../services/itinerary-domain";
import { normalizeSemanticExtraction, SEMANTIC_PARSER_PROMPT } from "../services/semantic-parser";
import { migrateV2SessionValue } from "../services/trip-service";
import { CandidateSetSchema, type CandidatePlanner } from "../services/deepseek-planner";
import {
  EventSchema,
  ParsedUserInputSchema,
  ReplanningRequestSchema,
  SemanticExtractionSchema,
  SnapshotSchema,
  type ParsedUserInput,
  type Snapshot,
} from "../types";
import { RealWorldContextSchema, type RealWorldContext } from "../types/world";
import { genericLocation } from "../services/world/context-resolution";
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
  assert.equal(genericLocation("地铁站附近"), true);
  assert.equal(genericLocation("人民广场(地铁站)"), false);

  // A1: a saved fixed activity has a known duration. Re-stating only its
  // start time must not erase the saved end time before or after a follow-up.
  const savedFixedBase = SnapshotSchema.parse({
    ...snapshot(),
    itinerary: [EventSchema.parse({
      ...snapshot().itinerary[0],
      id: "saved-fixed-ifc",
      placeId: "saved-fixed-ifc-poi",
      name: "上海国金中心",
      startTime: "18:00",
      endTime: "19:00",
      durationSource: "user",
      location: "上海国金中心",
      locked: true,
      status: "locked",
    })],
  });
  const restatedFixed = await runAgentAssist(
    { snapshot: savedFixedBase, rawText: "下雨了，18点去上海国金中心的预约请保留。" },
    undefined,
    {
      parse: async () => ParsedUserInputSchema.parse({
        ...parsed("下雨了，18点去上海国金中心的预约请保留。"),
        existingPlans: [{ id: "restated-ifc", name: "上海国金中心", startTime: "18:00", endTime: null, durationMinutes: null, location: "上海国金中心", locked: true, source: "user" }],
      }),
      ground: async () => world("needs_input"),
    },
  );
  assert.equal(restatedFixed.status, "NEEDS_INPUT");
  if (restatedFixed.status !== "NEEDS_INPUT") throw new Error("expected A1 location follow-up");
  assert.deepEqual(
    restatedFixed.confirmedDraft.existingPlans.map((item) => [item.id, item.placeId, item.startTime, item.endTime, item.durationMinutes]),
    [["saved-fixed-ifc", "saved-fixed-ifc-poi", "18:00", "19:00", 60]],
  );
  let capturedRestatedFixed: unknown;
  const restatedFixedAnswered = await runAgentAssist(
    {
      snapshot: savedFixedBase,
      confirmedDraft: restatedFixed.confirmedDraft,
      answer: { kind: "text", field: restatedFixed.missingFact.key, value: "人民广场地铁站" },
      resolutionState: restatedFixed.resolutionState,
    },
    undefined,
    { ground: async (raw) => { capturedRestatedFixed = raw; return world("unavailable"); } },
  );
  assert.equal(restatedFixedAnswered.status, "UPSTREAM_UNAVAILABLE");
  assert.deepEqual(
    (capturedRestatedFixed as ReturnType<typeof input>).snapshot.itinerary.map((item) => [item.id, item.placeId, item.startTime, item.endTime, item.durationSource, item.locked]),
    [["saved-fixed-ifc", "saved-fixed-ifc-poi", "18:00", "19:00", "user", true]],
  );

  // A2: ordinary activities keep the same known duration as well.
  const savedOrdinaryDurationBase = SnapshotSchema.parse({
    ...savedFixedBase,
    itinerary: [EventSchema.parse({
      ...savedFixedBase.itinerary[0],
      id: "saved-ordinary-ifc",
      placeId: "saved-ordinary-ifc-poi",
      locked: false,
      status: "planned",
    })],
  });
  let capturedOrdinaryDuration: unknown;
  const restatedOrdinary = await runAgentAssist(
    { snapshot: savedOrdinaryDurationBase, rawText: "下雨了，原定18点去上海国金中心，请调整。" },
    undefined,
    {
      parse: async () => ParsedUserInputSchema.parse({
        ...parsed("下雨了，原定18点去上海国金中心，请调整。"),
        existingPlans: [{ id: "ordinary-restatement", name: "上海国金中心", startTime: "18:00", endTime: null, durationMinutes: null, location: "上海国金中心", locked: false, source: "user" }],
      }),
      ground: async (raw) => { capturedOrdinaryDuration = raw; return world("unavailable"); },
    },
  );
  assert.equal(restatedOrdinary.status, "UPSTREAM_UNAVAILABLE");
  assert.deepEqual(
    (capturedOrdinaryDuration as ReturnType<typeof input>).snapshot.itinerary.map((item) => [item.id, item.endTime, item.durationSource, item.locked]),
    [["saved-ordinary-ifc", "19:00", "user", false]],
  );

  // A4: an explicit fixed-time change remains a protected conflict.
  await assert.rejects(
    () => runAgentAssist(
      { snapshot: savedFixedBase, rawText: "下雨了，固定预约改到18点半结束。" },
      undefined,
      {
        parse: async () => ParsedUserInputSchema.parse({
          ...parsed("下雨了，固定预约改到18点半结束。"),
          existingPlans: [{ id: "saved-fixed-ifc", name: "上海国金中心", startTime: "18:00", endTime: "18:30", durationMinutes: 30, location: "上海国金中心", locked: true, source: "user" }],
          disruptions: [{ kind: "changed_mind", label: "修改固定预约", source: "user" }],
        }),
      },
    ),
    /固定安排.*不能修改/,
  );

  // A5: draft round-trips do not upgrade suggested/unknown duration sources.
  for (const durationSource of ["suggested", "unknown"] as const) {
    const endTime = durationSource === "unknown" ? "18:00" : "19:00";
    const sourceBase = SnapshotSchema.parse({
      ...savedOrdinaryDurationBase,
      itinerary: [EventSchema.parse({
        ...savedOrdinaryDurationBase.itinerary[0],
        id: `source-${durationSource}`,
        placeId: `source-${durationSource}-poi`,
        endTime,
        durationSource,
      })],
    });
    const sourceDraft = confirmedDraftFromParsed(sourceBase, ParsedUserInputSchema.parse({
      ...parsed("下雨了，请调整今天剩下的安排。"),
      context: sourceBase.state,
      contextSources: sourceBase.stateSources,
    }));
    assert.equal(sourceDraft.existingPlans[0].durationSource, durationSource);
    let capturedSourceRoundTrip: unknown;
    const sourceResult = await runAgentAssist(
      { snapshot: sourceBase, confirmedDraft: sourceDraft, resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] } },
      undefined,
      { ground: async (raw) => { capturedSourceRoundTrip = raw; return world("unavailable"); } },
    );
    assert.equal(sourceResult.status, "UPSTREAM_UNAVAILABLE");
    assert.deepEqual(
      (capturedSourceRoundTrip as ReturnType<typeof input>).snapshot.itinerary.map((item) => [item.id, item.endTime, item.durationSource]),
      [[`source-${durationSource}`, endTime, durationSource]],
    );
  }

  async function assertSavedActivitySurvivesFollowUp(locked: boolean) {
    const original = snapshot();
    const event = EventSchema.parse({
      ...original.itinerary[0],
      id: locked ? "saved-locked" : "saved-normal",
      placeId: locked ? "saved-locked-poi" : "saved-normal-poi",
      name: locked ? "固定晚餐" : "普通晚餐",
      location: locked ? "固定晚餐地点" : "普通晚餐地点",
      locked,
      status: locked ? "locked" : "planned",
      constraint: locked ? "固定预约" : "原计划",
    });
    const base = SnapshotSchema.parse({ ...original, itinerary: [event] });
    const first = await runAgentAssist(
      { snapshot: base, rawText: "下雨了，请调整今天剩下的安排" },
      undefined,
      {
        parse: async () => ParsedUserInputSchema.parse({ ...parsed("下雨了，请调整今天剩下的安排"), existingPlans: [] }),
        ground: async () => world("needs_input"),
      },
    );
    assert.equal(first.status, "NEEDS_INPUT");
    if (first.status !== "NEEDS_INPUT") throw new Error("expected first follow-up");
    assert.deepEqual(first.confirmedDraft.existingPlans.map((item) => item.id), [event.id]);
    let capturedRoundTrip: unknown;
    const second = await runAgentAssist(
      {
        snapshot: base,
        confirmedDraft: first.confirmedDraft,
        answer: { kind: "text", field: first.missingFact.key, value: "人民广场地铁站" },
        resolutionState: first.resolutionState,
      },
      undefined,
      { ground: async (raw) => { capturedRoundTrip = raw; return world("unavailable"); } },
    );
    assert.equal(second.status, "UPSTREAM_UNAVAILABLE");
    const roundTripSnapshot = (capturedRoundTrip as ReturnType<typeof input>).snapshot;
    assert.deepEqual(
      roundTripSnapshot.itinerary.map((item) => [item.id, item.placeId, item.startTime, item.locked]),
      [[event.id, event.placeId, event.startTime, event.locked]],
    );
  }

  await assertSavedActivitySurvivesFollowUp(false);
  await assertSavedActivitySurvivesFollowUp(true);

  const savedOrdinaryBase = SnapshotSchema.parse({
    ...snapshot(),
    itinerary: [EventSchema.parse({
      ...snapshot().itinerary[0],
      id: "saved-museum",
      placeId: "saved-museum-poi",
      name: "美术馆",
      locked: false,
      status: "planned",
    })],
  });
  const savedMention = await runAgentAssist(
    { snapshot: savedOrdinaryBase, rawText: "下雨了，我原本10点去美术馆，请调整" },
    undefined,
    {
      parse: async () => ParsedUserInputSchema.parse({
        ...parsed("下雨了，我原本10点去美术馆，请调整"),
        activityMentions: [{ id: "mention-saved-museum", role: "existing_plan", name: "去美术馆", startTime: "10:00", endTime: null, durationMinutes: null, location: null, locked: "no", sourceText: "原本10点去美术馆" }],
      }),
      ground: async () => world("needs_input"),
    },
  );
  assert.equal(savedMention.status, "NEEDS_INPUT");
  if (savedMention.status !== "NEEDS_INPUT") throw new Error("expected saved activity follow-up");
  assert.deepEqual(savedMention.confirmedDraft.existingPlans.map((item) => item.id), ["saved-museum"]);
  assert.equal(savedMention.confirmedDraft.activityMentions.length, 0, "同一时间且规范名相同的已存活动不应重复补问");

  const emptyBase = SnapshotSchema.parse({ ...snapshot(), itinerary: [], revision: 0 });
  const incompleteActivity = (overrides: Record<string, unknown>) => ParsedUserInputSchema.parse({
    ...parsed("现在下雨了，我原定回酒店，请帮我调整"),
    existingPlans: [],
    activityMentions: [{
      id: "mention-hotel",
      role: "existing_plan",
      name: "回酒店",
      startTime: "15:00",
      endTime: null,
      durationMinutes: null,
      location: null,
      locked: "no",
      sourceText: "我原定回酒店",
      ...overrides,
    }],
  });
  let incompleteGroundCalls = 0;
  const missingLocation = await runAgentAssist(
    { snapshot: emptyBase, rawText: "现在下雨了，我原定回酒店，请帮我调整" },
    undefined,
    {
      parse: async () => incompleteActivity({}),
      ground: async () => { incompleteGroundCalls += 1; return world(); },
    },
  );
  assert.equal(missingLocation.status, "NEEDS_INPUT");
  assert.equal(incompleteGroundCalls, 0, "活动自身字段缺失时不应提前调用地图服务");
  if (missingLocation.status !== "NEEDS_INPUT") throw new Error("expected missing location");
  assert.equal(missingLocation.missingFact.key, "activity:mention-hotel:location");
  assert.equal(missingLocation.confirmedDraft.activityMentions[0].id, "mention-hotel");
  let capturedPromotedLocation: unknown;
  const locationAnswered = await runAgentAssist(
    {
      snapshot: emptyBase,
      confirmedDraft: missingLocation.confirmedDraft,
      answer: { kind: "text", field: missingLocation.missingFact.key, value: "上海和平饭店" },
      resolutionState: missingLocation.resolutionState,
    },
    undefined,
    { ground: async (raw) => { capturedPromotedLocation = raw; return world("unavailable"); } },
  );
  assert.equal(locationAnswered.status, "UPSTREAM_UNAVAILABLE");
  const promotedLocationSnapshot = (capturedPromotedLocation as ReturnType<typeof input>).snapshot;
  assert.deepEqual(
    promotedLocationSnapshot.itinerary.map((item) => [item.id, item.location]),
    [["mention-hotel", "上海和平饭店"]],
  );

  const hotelMeetingText = "原定15点在酒店集合，现在下雨了";
  let hotelMeetingGroundCalls = 0;
  const missingExistingPlanLocation = await runAgentAssist(
    { snapshot: emptyBase, rawText: hotelMeetingText },
    undefined,
    {
      parse: async () => ParsedUserInputSchema.parse({
        ...parsed(hotelMeetingText),
        existingPlans: [{ id: "hotel-meeting", name: "酒店集合", startTime: "15:00", endTime: "16:00", durationMinutes: 60, location: "", locked: true, source: "user" }],
      }),
      ground: async () => { hotelMeetingGroundCalls += 1; return world(); },
    },
  );
  assert.equal(missingExistingPlanLocation.status, "NEEDS_INPUT");
  assert.equal(hotelMeetingGroundCalls, 0, "existingPlans 地点为空时应先补问，不应提前调用地图服务");
  if (missingExistingPlanLocation.status !== "NEEDS_INPUT") throw new Error("expected existing plan location follow-up");
  assert.equal(missingExistingPlanLocation.missingFact.key, "activity:event-hotel-meeting:location");
  let capturedHotelMeeting: unknown;
  const answeredExistingPlanLocation = await runAgentAssist(
    {
      snapshot: emptyBase,
      confirmedDraft: missingExistingPlanLocation.confirmedDraft,
      answer: { kind: "text", field: missingExistingPlanLocation.missingFact.key, value: "上海和平饭店" },
      resolutionState: missingExistingPlanLocation.resolutionState,
    },
    undefined,
    { ground: async (raw) => { capturedHotelMeeting = raw; return world("unavailable"); } },
  );
  assert.equal(answeredExistingPlanLocation.status, "UPSTREAM_UNAVAILABLE");
  const hotelMeetingSnapshot = (capturedHotelMeeting as ReturnType<typeof input>).snapshot;
  assert.deepEqual(
    hotelMeetingSnapshot.itinerary.map((item) => [item.id, item.location, item.startTime, item.endTime, item.locked]),
    [["event-hotel-meeting", "上海和平饭店", "15:00", "16:00", true]],
  );

  const vagueHotelBase = SnapshotSchema.parse({
    ...snapshot(),
    itinerary: [
      EventSchema.parse({ ...snapshot().itinerary[0], id: "hotel-stop", placeId: "hotel-place", name: "酒店集合", startTime: "15:00", endTime: "16:00", location: "酒店", locked: false, status: "planned" }),
      EventSchema.parse({ ...snapshot().itinerary[0], id: "dinner-stop", placeId: "dinner-place", name: "晚餐", startTime: "18:00", endTime: "19:00", location: "上海餐厅", locked: true, status: "locked" }),
    ],
  });
  const hotelWorldQuestion = RealWorldContextSchema.parse({
    ...world("needs_input"),
    missingWorldFacts: [{ kind: "user", field: "hotel-place", message: "“酒店”具体在哪里？告诉我名称或定位即可。" }],
    ambiguities: [],
  });
  const mappedWorldQuestion = await runAgentAssist(
    { snapshot: vagueHotelBase, rawText: "现在下雨了，请调整原定安排" },
    undefined,
    { parse: async () => parsed("现在下雨了，请调整原定安排"), ground: async () => hotelWorldQuestion },
  );
  assert.equal(mappedWorldQuestion.status, "NEEDS_INPUT");
  if (mappedWorldQuestion.status !== "NEEDS_INPUT") throw new Error("expected mapped world location follow-up");
  assert.equal(mappedWorldQuestion.missingFact.key, "activity:hotel-stop:location");
  let capturedMappedHotel: unknown;
  const answeredMappedWorldQuestion = await runAgentAssist(
    {
      snapshot: vagueHotelBase,
      confirmedDraft: mappedWorldQuestion.confirmedDraft,
      answer: { kind: "text", field: mappedWorldQuestion.missingFact.key, value: "上海和平饭店" },
      resolutionState: mappedWorldQuestion.resolutionState,
    },
    undefined,
    { ground: async (raw) => { capturedMappedHotel = raw; return world("unavailable"); } },
  );
  assert.equal(answeredMappedWorldQuestion.status, "UPSTREAM_UNAVAILABLE");
  const mappedHotelSnapshot = (capturedMappedHotel as ReturnType<typeof input>).snapshot;
  assert.deepEqual(
    mappedHotelSnapshot.itinerary.map((item) => [item.id, item.location, item.startTime, item.locked]),
    [
      ["hotel-stop", "上海和平饭店", "15:00", false],
      ["dinner-stop", "上海餐厅", "18:00", true],
    ],
  );

  for (const unsafeMapping of [
    { name: "无匹配", base: vagueHotelBase, field: "unknown-place" },
    {
      name: "多个匹配",
      base: SnapshotSchema.parse({
        ...vagueHotelBase,
        itinerary: vagueHotelBase.itinerary.map((event) => EventSchema.parse({ ...event, placeId: "shared-place", location: "酒店" })),
      }),
      field: "shared-place",
    },
  ]) {
    const unsafeWorldQuestion = RealWorldContextSchema.parse({
      ...world("needs_input"),
      missingWorldFacts: [{ kind: "user", field: unsafeMapping.field, message: "请补充具体活动地点。" }],
      ambiguities: [],
    });
    const unsafeResult = await runAgentAssist(
      { snapshot: unsafeMapping.base, rawText: "现在下雨了，请调整原定安排" },
      undefined,
      { parse: async () => parsed("现在下雨了，请调整原定安排"), ground: async () => unsafeWorldQuestion },
    );
    assert.equal(unsafeResult.status, "UPSTREAM_UNAVAILABLE", `${unsafeMapping.name}时必须受控失败`);
    assert.match(unsafeResult.error, /无法安全对应到唯一活动/);
  }

  const missingTime = await runAgentAssist(
    { snapshot: emptyBase, rawText: "现在下雨了，我原定去外滩，请帮我调整" },
    undefined,
    {
      parse: async () => incompleteActivity({ id: "mention-bund", name: "去外滩", startTime: null, location: "上海外滩", sourceText: "我原定去外滩" }),
      ground: async () => { throw new Error("活动时间补齐前不应调用地图服务"); },
    },
  );
  assert.equal(missingTime.status, "NEEDS_INPUT");
  if (missingTime.status !== "NEEDS_INPUT") throw new Error("expected missing time");
  assert.equal(missingTime.missingFact.key, "activity:mention-bund:startTime");
  let capturedPromotedTime: unknown;
  const timeAnswered = await runAgentAssist(
    {
      snapshot: emptyBase,
      confirmedDraft: missingTime.confirmedDraft,
      answer: { kind: "time", field: missingTime.missingFact.key, value: "18:00" },
      resolutionState: missingTime.resolutionState,
    },
    undefined,
    { ground: async (raw) => { capturedPromotedTime = raw; return world("unavailable"); } },
  );
  assert.equal(timeAnswered.status, "UPSTREAM_UNAVAILABLE");
  const promotedTimeSnapshot = (capturedPromotedTime as ReturnType<typeof input>).snapshot;
  assert.deepEqual(
    promotedTimeSnapshot.itinerary.map((item) => [item.id, item.startTime, item.location]),
    [["mention-bund", "18:00", "上海外滩"]],
  );

  let capturedNewPlan: unknown;
  const newPlanResult = await runAgentAssist(
    { snapshot: emptyBase, rawText: "现在下雨了，我原定15点去上海国金中心，请帮我调整" },
    undefined,
    {
      parse: async () => ParsedUserInputSchema.parse({
        ...parsed("现在下雨了，我原定15点去上海国金中心，请帮我调整"),
        existingPlans: [{ id: "new-ifc", name: "上海国金中心", startTime: "15:00", endTime: null, durationMinutes: null, location: "上海国金中心", locked: false, source: "user" }],
      }),
      ground: async (raw) => { capturedNewPlan = raw; return world("unavailable"); },
    },
  );
  assert.equal(newPlanResult.status, "UPSTREAM_UNAVAILABLE");
  assert.deepEqual(
    (capturedNewPlan as ReturnType<typeof input>).snapshot.itinerary.map((item) => [item.name, item.endTime, item.durationSource]),
    [["上海国金中心", "15:00", "unknown"]],
  );

  const invalidParserResult = await runAgentAssist(
    { snapshot: snapshot(), rawText: "下雨了，请调整" },
    undefined,
    { parse: async () => { throw new SyntaxError("Unexpected token < in JSON"); } },
  );
  assert.equal(invalidParserResult.status, "UPSTREAM_UNAVAILABLE");
  assert.equal(invalidParserResult.error, "服务暂时未能生成有效结果，你的输入已保留，请重试。");
  assert(!invalidParserResult.error.includes("Unexpected token"));

  const emptyCandidatePlanner: CandidatePlanner = {
    name: "empty-candidate-test",
    generateCandidates: async () => [],
  };
  const noSafePlan = await runAgentAssist(
    { snapshot: snapshot(), rawText: "下雨了，把今天的行程调整一下" },
    undefined,
    {
      parse: async () => parsed(),
      ground: async () => world(),
      replan: (raw, _planner, worldService, impactAnalysis, signal) =>
        replanReal(raw, emptyCandidatePlanner, worldService, impactAnalysis, signal),
    },
  );
  assert.equal(noSafePlan.status, "NO_SAFE_PLAN", "Planner 没有可执行方案时不得伪装成 READY");
  assert.equal(noSafePlan.result?.ok, false);

  const semanticContext = {
    currentTime: { value: null, sourceText: null },
    currentLocation: { value: null, sourceText: null },
    weather: { value: null, sourceText: null },
    energyLevel: { value: null, sourceText: null },
  };
  const plannedQuestionText = "原定15点去上海国金中心，现在还去吗";
  const plannedQuestion = normalizeSemanticExtraction(
    emptyBase,
    plannedQuestionText,
    SemanticExtractionSchema.parse({
      intent: "rescue",
      activities: [{ role: "existing_plan", name: "上海国金中心", startTime: "15:00", endTime: null, durationMinutes: null, location: "上海国金中心", locked: "no", sourceText: "原定15点去上海国金中心" }],
      disruptions: [{ kind: "changed_mind", label: "询问是否保留原计划", sourceText: "现在还去吗" }],
      constraints: [],
      context: semanticContext,
      question: "现在还去吗",
      ambiguities: [],
    }),
    "test-model",
  );
  assert.equal(plannedQuestion.existingPlans.length, 1);
  assert.equal(plannedQuestion.disruptions[0].kind, "changed_mind");
  const cancelQuestionText = "原定18点去B，现在下雨，要不要取消B？";
  const cancelQuestion = normalizeSemanticExtraction(
    emptyBase,
    cancelQuestionText,
    SemanticExtractionSchema.parse({
      intent: "rescue",
      activities: [{ role: "existing_plan", name: "B", startTime: "18:00", endTime: null, durationMinutes: null, location: "B", locked: "no", sourceText: "原定18点去B" }],
      disruptions: [{ kind: "weather", label: "下雨", sourceText: "下雨" }, { kind: "changed_mind", label: "询问是否取消B", sourceText: "要不要取消B" }],
      constraints: [],
      context: semanticContext,
      question: "要不要取消B",
      ambiguities: [],
    }),
    "test-model",
  );
  assert.equal(cancelQuestion.existingPlans.length, 1);
  assert(cancelQuestion.disruptions.some((item) => item.kind === "changed_mind"));
  const consideringText = "我在考虑15点去上海博物馆东馆还是上海国金中心，还没决定";
  const considering = normalizeSemanticExtraction(
    emptyBase,
    consideringText,
    SemanticExtractionSchema.parse({
      intent: "create",
      activities: [
        { role: "considering", name: "上海博物馆东馆", startTime: "15:00", endTime: null, durationMinutes: null, location: "上海博物馆东馆", locked: "no", sourceText: "15点去上海博物馆东馆" },
        { role: "considering", name: "上海国金中心", startTime: "15:00", endTime: null, durationMinutes: null, location: "上海国金中心", locked: "no", sourceText: "上海国金中心" },
      ],
      disruptions: [],
      constraints: [],
      context: semanticContext,
      question: null,
      ambiguities: ["两个地点尚未决定"],
    }),
    "test-model",
  );
  assert.equal(considering.existingPlans.length, 0);
  assert.equal(considering.activityMentions.filter((item) => item.role === "considering").length, 2);
  const uncertainSequenceText = "我还不确定是否去，正在考虑15点去A，然后18点去B，来得及吗？";
  const uncertainSequence = normalizeSemanticExtraction(
    emptyBase,
    uncertainSequenceText,
    SemanticExtractionSchema.parse({
      intent: "create",
      activities: [
        { role: "considering", name: "去A", startTime: "15:00", endTime: null, durationMinutes: null, location: "A", locked: "no", sourceText: "考虑15点去A" },
        { role: "considering", name: "去B", startTime: "18:00", endTime: null, durationMinutes: null, location: "B", locked: "no", sourceText: "然后18点去B" },
      ],
      disruptions: [],
      constraints: [],
      context: semanticContext,
      question: "来得及吗",
      ambiguities: ["尚未决定是否执行"],
    }),
    "test-model",
  );
  assert.equal(uncertainSequence.existingPlans.length, 0, "B2 明确考虑中的活动不能被规范化代码升级为原计划");
  assert.equal(uncertainSequence.activityMentions.filter((item) => item.role === "considering").length, 2);
  const originalButFeasibilityUncertainText = "我原定15点去A、18点去B，但现在不确定赶不赶得上";
  const originalButFeasibilityUncertain = normalizeSemanticExtraction(
    emptyBase,
    originalButFeasibilityUncertainText,
    SemanticExtractionSchema.parse({
      intent: "rescue",
      activities: [
        { role: "existing_plan", name: "去A", startTime: "15:00", endTime: null, durationMinutes: null, location: "A", locked: "no", sourceText: "原定15点去A" },
        { role: "existing_plan", name: "去B", startTime: "18:00", endTime: null, durationMinutes: null, location: "B", locked: "no", sourceText: "18点去B" },
      ],
      disruptions: [{ kind: "late", label: "不确定是否赶得上", sourceText: "不确定赶不赶得上" }],
      constraints: [],
      context: semanticContext,
      question: "不确定赶不赶得上",
      ambiguities: [],
    }),
    "test-model",
  );
  assert.deepEqual(originalButFeasibilityUncertain.existingPlans.map((item) => item.startTime), ["15:00", "18:00"]);
  const mixedDecisionText = "已确定15点去A，晚上还在考虑18点去B，全部来得及吗？";
  const mixedDecision = normalizeSemanticExtraction(
    emptyBase,
    mixedDecisionText,
    SemanticExtractionSchema.parse({
      intent: "create",
      activities: [
        { role: "existing_plan", name: "去A", startTime: "15:00", endTime: null, durationMinutes: null, location: null, locked: "no", sourceText: "已确定15点去A" },
        { role: "considering", name: "去B", startTime: "18:00", endTime: null, durationMinutes: null, location: "B", locked: "no", sourceText: "考虑18点去B" },
      ],
      disruptions: [],
      constraints: [],
      context: semanticContext,
      question: "全部来得及吗",
      ambiguities: [],
    }),
    "test-model",
  );
  assert.deepEqual(mixedDecision.existingPlans.map((item) => item.startTime), ["15:00"]);
  assert.equal(mixedDecision.existingPlans[0]?.location, "", "B6 模型已明确为 existing_plan 时，缺地点只触发补充，不应把它降级成未决活动");
  assert(mixedDecision.missingFacts.includes("activityDetails"));
  assert.deepEqual(mixedDecision.activityMentions.map((item) => [item.role, item.startTime]), [["considering", "18:00"]]);
  const feasibilitySequenceText = "现在下雨了，我想3点去A，然后6点去B，晚上8点去C，还来得及全部做这些事吗？";
  const feasibilitySequence = normalizeSemanticExtraction(
    emptyBase,
    feasibilitySequenceText,
    SemanticExtractionSchema.parse({
      intent: "rescue",
      activities: [
        { role: "existing_plan", name: "去A", startTime: "15:00", endTime: null, durationMinutes: null, location: "A", locked: "no", sourceText: "3点去A" },
        { role: "existing_plan", name: "去B", startTime: "18:00", endTime: null, durationMinutes: null, location: "B", locked: "no", sourceText: "6点去B" },
        { role: "existing_plan", name: "去C", startTime: "20:00", endTime: null, durationMinutes: null, location: "C", locked: "no", sourceText: "晚上8点去C" },
      ],
      disruptions: [{ kind: "weather", label: "下雨", sourceText: "下雨了" }],
      constraints: [],
      context: semanticContext,
      question: "还来得及全部做这些事吗",
      ambiguities: [],
    }),
    "test-model",
  );
  assert.deepEqual(feasibilitySequence.existingPlans.map((item) => item.startTime), ["15:00", "18:00", "20:00"]);
  assert(SEMANTIC_PARSER_PROMPT.includes("asks whether to keep or cancel an activity that was already planned"));
  assert(SEMANTIC_PARSER_PROMPT.includes("Never promote B"));

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

  console.log("PASS reliability: migration, input gate, complete draft round-trip, partial activity answers, semantic boundaries, safe errors, loop/planner bounds, locked-event validation");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
