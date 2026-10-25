import assert from "node:assert/strict";
import { createStarterSnapshot } from "../data/session-defaults";
import { reconcileActivityFacts, snapshotActivityFacts } from "../services/activity-facts";
import { planningTimeConstraints } from "../services/activity-duration";
import { activityFactToEvent } from "../services/itinerary-domain";
import { materializeCandidate, UnknownDurationConflict, type PlanCandidate } from "../services/deepseek-planner";
import { buildPlanChanges } from "../services/plan-changes";
import { planNarrativeForDisplay } from "../services/plan-narrative";
import { protectionPolicyForActivity } from "../services/protection-policy";
import { normalizeSemanticExtraction } from "../services/semantic-parser";
import { buildRealContext } from "../agents/real-context-builder";
import { runAgentAssist } from "../agents/agent-orchestrator";
import { replanReal } from "../agents/real-replanning-agent";
import { validatePlan } from "../validators";
import { openingHoursValidator } from "../validators/opening-hours-validator";
import { ActivityFactSchema, EventSchema, ReplanningRequestSchema, SemanticExtractionSchema, SnapshotSchema, type ActivityFact } from "../types";
import type { RealWorldContext } from "../types/world";

const now = new Date().toISOString();
const starter = createStarterSnapshot();
const base = SnapshotSchema.parse({ ...starter, trip: { ...starter.trip, destination: "上海" },
  state: { ...starter.state, currentTime: "18:00", currentLocation: "人民广场", stateCapturedAt: now },
  stateSources: { currentTime: "user", currentLocation: "user", weather: "unset", energyLevel: "unset", disruption: "user" }, itinerary: [] });
const bund = ActivityFactSchema.parse({ id: "bund", placeId: "bund-poi", origin: "message", snapshotEventId: null,
  role: "existing_plan", progress: "not_started", name: "外滩散步", placeQuery: "外滩", startTime: "19:00", startTimeSource: "user",
  endTime: null, durationMinutes: null, durationSource: "unknown", commitment: "flexible", sourceText: "19点去外滩散步" });

function fixture(facts = [bund], timeConstraints?: NonNullable<typeof base.timeConstraints>, snapshot = base) {
  const current = { id: "current", longitude: 121.47, latitude: 31.23, coordinateSystem: "GCJ02" as const,
    source: "user" as const, capturedAt: now, city: "上海市", adcode: "310101" };
  const poi = (id: string, name: string) => ({ poiId: id, name, address: name, city: "上海市", district: "黄浦区", adcode: "310101",
    longitude: 121.49, latitude: 31.23, coordinateSystem: "GCJ02" as const, type: "景点", source: "amap" as const, fetchedAt: now, status: "available" as const });
  const alternatives = [poi("new-poi", "滨江步道")];
  const places = [...facts.map(fact => poi(fact.placeId, fact.placeQuery!)), ...alternatives];
  const points = [current, ...places.map(place => ({ ...place, id: place.poiId }))];
  const world: RealWorldContext = { status: "ready", currentTime: { value: snapshot.state.currentTime, date: snapshot.state.currentDate, source: "user", confirmedAt: now },
    currentLocation: current, resolvedPlaces: facts.map((fact, i) => ({ placeId: fact.placeId, poi: places[i] })), alternatives,
    routes: points.flatMap(origin => points.filter(destination => destination.id !== origin.id).map(destination => ({ origin, destination,
      travelMode: "WALKING" as const, durationSeconds: 600, distanceMeters: 600, source: "amap" as const, fetchedAt: now, status: "available" as const }))),
    weather: { condition: null, temperature: null, humidity: null, windDirection: null, windPower: null, forecast: [], source: "amap", fetchedAt: now, reportedAt: null, status: "unavailable" },
    dataFreshness: { groundedAt: now, routeMaxAgeSeconds: 120, locationMaxAgeSeconds: 600 }, missingWorldFacts: [], ambiguities: [], travelMode: "WALKING" };
  const request = ReplanningRequestSchema.parse({ reason: "optimize", freeText: "帮我优化行程", currentState: snapshot.state,
    stateSources: snapshot.stateSources, closedPlaceIds: [], variation: 0, activityFacts: facts, timeConstraints });
  return { snapshot, request, world, context: buildRealContext({ snapshot, request, mode: "live", confirmation: { status: "confirmed", confirmedAt: now } }, world) };
}
const step = (eventId: string | null = bund.id, durationMinutes: number | null = null, poiId: string | null = null) =>
  ({ eventId, poiId, durationMinutes, travelMode: "WALKING" as const, reason: "保留到访意愿，具体安排以现场情况为准。" });
const candidate = (steps = [step()]): PlanCandidate => ({ title: "建议", tradeOff: "保留到访意愿，营业与入场情况尚未核实。", steps, removed: [] });
function checked(f: ReturnType<typeof fixture>, c = candidate()) {
  const plan = materializeCandidate(f.context, c, f.snapshot);
  assert.deepEqual(validatePlan(f.context, plan), []);
  return plan;
}

// Model defaults must not survive the final-stop policy.
for (const duration of [null, 60, 120]) {
  const plan = checked(fixture(), candidate([step(bund.id, duration)]));
  assert.equal(plan.events[0].endTime, "19:00");
  assert.equal(plan.events[0].durationSource, "unknown");
  assert(!buildPlanChanges([bund], plan, base)[0].rows.some(row => row.label === "停留"));
}
const noStart = { ...bund, startTime: null, startTimeSource: "not_provided" as const };
assert.equal(checked(fixture([noStart])).events[0].startTime, "18:10");

const knownHour = { ...bund, durationSource: "user" as const, durationMinutes: 60, endTime: "20:00" };
const knownPlan = checked(fixture([knownHour]));
assert.equal(knownPlan.events[0].endTime, "20:00");
assert(validatePlan(fixture([knownHour]).context, { ...knownPlan, events: [{ ...knownPlan.events[0], endTime: "19:00", durationSource: "unknown" }] }).some(v => v.code === "duration"));
assert.equal(checked(fixture([{ ...knownHour, durationMinutes: 10, endTime: "19:10" }])).events[0].endTime, "19:10", "已知短时长不能被15分钟建议下限覆盖");

const endOnly = { ...noStart, durationSource: "user" as const, endTime: "21:00", endTimeFixed: true };
const endOnlyPlan = checked(fixture([endOnly]));
assert.equal(endOnlyPlan.events[0].endTime, "21:00", "仅提供结束时刻也必须保留");
const endOnlySaved = SnapshotSchema.parse({ ...base, state: { ...base.state, currentTime: "20:00" }, itinerary: endOnlyPlan.events });
const endOnlyFacts = snapshotActivityFacts(endOnlySaved);
assert.equal(endOnlyFacts[0].durationMinutes, null, "不能把推算出的停留长度存成用户时长");
assert.equal(checked(fixture(endOnlyFacts, undefined, endOnlySaved)).events[0].endTime, "21:00", "保存后重新规划仍保留结束时刻");
assert.equal(reconcileActivityFacts(endOnlySaved, [{ ...endOnlyFacts[0], origin: "message", startTime: "20:00", endTime: null, sourceText: "改到20点去外滩" }])[0].endTime, "21:00");
const moviePolicy = protectionPolicyForActivity({ name: "电影", location: "电影院", sourceText: "19点电影票，21点结束", startTime: "19:00", endTime: "21:00", durationMinutes: 120, commitment: "fixed" });
const movie: ActivityFact = { ...knownHour, name: "电影", endTime: "21:00", durationMinutes: 120, commitment: "fixed", protectionPolicy: moviePolicy };
assert.equal(checked(fixture([movie])).events[0].endTime, "21:00");

const newCandidate = { ...candidate([step(null, null, "new-poi")]), removed: [{ eventId: bund.id, reason: "建议改去滨江步道。" }] };
const newPlan = checked(fixture(), newCandidate);
assert.equal(newPlan.events[0].durationSource, "unknown");
assert.equal(newPlan.events[0].startTime, newPlan.events[0].endTime);
assert(!buildPlanChanges([bund], newPlan)[0].rows.some(row => row.label === "停留"));

// A former last stop must acquire a bounded suggestion before a later anchor.
const hotel: ActivityFact = { ...bund, id: "hotel", placeId: "hotel-poi", name: "回酒店", placeQuery: "上海和平饭店", startTime: "22:00",
  sourceText: "22点前回酒店", commitment: "fixed", protectionPolicy: protectionPolicyForActivity({ name: "回酒店", location: "上海和平饭店",
    sourceText: "22点前回酒店", startTime: "22:00", durationMinutes: null, commitment: "fixed" }) };
const withHotel = fixture([bund, hotel], [{ value: "22点前回酒店", sourceText: hotel.sourceText!, activityIds: [hotel.id] }]);
const connected = checked(withHotel, candidate([step(), step(hotel.id)]));
assert.equal(connected.events[0].durationSource, "suggested");
assert.equal(connected.events[0].endTime, "20:00");
assert.equal(connected.events[1].durationSource, "unknown");
const unsafeAppend = { ...connected, events: [{ ...connected.events[0], endTime: "19:00", durationSource: "unknown" as const }, connected.events[1]] };
assert(validatePlan(withHotel.context, unsafeAppend).some(v => v.conflict?.kind === "unknown_duration_window"));

const deadline = [{ value: "19:30前结束全部行程", sourceText: "19:30前结束全部行程", endByTime: "19:30" }];
assert.equal(checked(fixture([bund], deadline)).events[0].endTime, "19:30");
const newBounded = checked(fixture([bund], [{ ...deadline[0], endByTime: "18:40" }]), newCandidate);
assert.equal(newBounded.events[0].endTime, "18:40");
assert.equal(newBounded.events[0].durationSource, "suggested");
assert(validatePlan(fixture([knownHour], deadline).context, knownPlan).some(v => v.code === "time_conflict"));
assert.throws(() => materializeCandidate(fixture([bund], [{ ...deadline[0], endByTime: "19:05" }]).context, candidate(), base), UnknownDurationConflict);
const lastBus = fixture([bund], [{ value: "还要赶末班车", sourceText: "还要赶末班车", endByTime: null }]);
assert.throws(() => materializeCandidate(lastBus.context, candidate(), base), UnknownDurationConflict, "未落实的后续限制不能被当作没有限制");

const late = fixture([{ ...bund, startTime: "23:55" }], undefined, SnapshotSchema.parse({ ...base, state: { ...base.state, currentTime: "23:40" } }));
assert.equal(checked(late).events[0].endTime, "23:55", "末站结束未知不能因默认时长跨日而被拒绝");

// Accepted/reloaded unknown ends stay unknown, even if a saved suggestion exists.
const suggestedEvent = EventSchema.parse({ ...activityFactToEvent(knownHour, base), durationSource: "suggested" });
const savedSuggested = SnapshotSchema.parse({ ...base, itinerary: [suggestedEvent] });
const oldSuggestedFact = snapshotActivityFacts(savedSuggested)[0];
const cleared = checked(fixture([oldSuggestedFact], undefined, savedSuggested));
assert.equal(cleared.events[0].durationSource, "unknown");
assert.equal(cleared.events[0].endTime, "19:00");
const saved = SnapshotSchema.parse(JSON.parse(JSON.stringify({ ...base, itinerary: cleared.events, timeConstraints: deadline })));
const roundTrip = snapshotActivityFacts(saved)[0];
assert.equal(roundTrip.endTime, null);
assert.equal(roundTrip.durationMinutes, null);
assert.equal(activityFactToEvent(roundTrip, saved).endTime, "19:00");
assert.equal(planningTimeConstraints(saved, [], [roundTrip])[0].endByTime, "19:30");
const persistedLimits = planningTimeConstraints(base, [{ kind: "time", source: "user", value: "19:30前结束", endByTime: "19:30" }], [bund]);
assert.equal(planningTimeConstraints({ ...saved, timeConstraints: persistedLimits }, [], [roundTrip])[0].endByTime, "19:30", "空activityIds不能导致全程截止丢失");
assert.deepEqual(planningTimeConstraints(saved, [{ kind: "time", source: "user", value: "取消结束限制", timeScope: "clear_itinerary_end" }], [roundTrip]), []);
assert.deepEqual(planningTimeConstraints(base, [{ kind: "time", source: "user", value: "慢慢逛", timeScope: "preference" }], [bund]), [], "节奏偏好不能变成硬截止");
assert.equal(planningTimeConstraints(base, [{ kind: "time", source: "user", value: "酒店时间不能改", activityIds: [hotel.id] }], [bund, hotel])[0].activityIds?.[0], hotel.id);
assert.equal(fixture([roundTrip], undefined, saved).context.disruption.timeConstraints?.[0].endByTime, "19:30");
const extended = fixture([roundTrip, hotel]);
assert.equal(checked(extended, candidate([step(), step(hotel.id)])).events[0].durationSource, "suggested");

const raw = "请优化，外滩散步21点结束，全程21点前结束";
const parsed = normalizeSemanticExtraction(base, raw, SemanticExtractionSchema.parse({ intent: "optimize", activities: [{ role: "existing_plan", name: bund.name,
  location: "外滩", startTime: null, endTime: "21:00", durationMinutes: null, locked: "no", sourceText: "外滩散步21点结束" }],
  disruptions: [], constraints: [{ kind: "time", value: "21点前全程结束", sourceText: "全程21点前结束", endByTime: "21:00" }],
  context: { currentTime: { value: null, sourceText: null }, currentLocation: { value: null, sourceText: null }, weather: { value: null, sourceText: null }, energyLevel: { value: null, sourceText: null } },
  question: null, ambiguities: [] }), "controlled");
assert.equal(parsed.activityFacts[0].endTime, "21:00");
assert.equal(parsed.activityFacts[0].durationSource, "user");
assert.equal(planningTimeConstraints(base, parsed.constraints, parsed.activityFacts)[0].endByTime, "21:00");

const open = checked(fixture());
assert(validatePlan(fixture().context, { ...open, events: [{ ...open.events[0], endTime: "20:00", durationSource: "suggested" }] }).some(v => v.code === "duration"), "旧候选不能在复验时带回默认停留");
assert(!planNarrativeForDisplay(fixture().context, { ...open, events: [{ ...open.events[0], reason: "外滩散步停留60分钟再离开。" }] }).reasons.has(bund.id));
assert.equal(planNarrativeForDisplay(fixture().context, { ...open, explanation: "外滩散步停留一小时。" }).overview, null);
const closedContext = fixture().context;
closedContext.disruption.closedPlaceIds = [bund.placeId];
assert(validatePlan(closedContext, open).some(v => v.code === "opening_hours"));
const offline = { ...fixture().context, world: undefined, places: [{ id: bund.placeId, name: bund.name, category: "景点", district: "黄浦区", latitude: 31.23, longitude: 121.49,
  openingTime: "09:00", closingTime: "19:00", indoorOutdoor: "outdoor" as const, averageDuration: 60, tags: [] }] };
assert(openingHoursValidator(offline, open).length > 0, "结束未知不能绕过停止入场/闭馆时刻");

async function requestPropagation() {
  let plannerCalls = 0;
  const result = await runAgentAssist({ snapshot: base, rawText: raw }, undefined, {
    parse: async () => parsed,
    ground: async () => fixture(parsed.activityFacts).world,
    replan: (input, _planner, worldService, impact, signal, execution) => replanReal(input, { name: "controlled",
      generateCandidates: async () => { plannerCalls++; return [candidate([step(parsed.activityFacts[0].id)])]; },
    }, worldService, impact, signal, execution),
  });
  assert.equal(result.status, "READY", JSON.stringify(result));
  if (result.status === "READY") {
    assert.equal(result.request.timeConstraints?.[0].endByTime, "21:00", "完整请求链不能丢失结束限制");
    assert.equal(result.result.plan?.events[0].endTime, "21:00");
  }
  assert.equal(plannerCalls, 1, "末站规则不增加模型调用");
  console.log("PASS final activity: open ends, confirmed times, new POIs, following anchors/deadlines, midnight, persistence, prose and request propagation");
}
requestPropagation().catch(error => { console.error(error); process.exitCode = 1; });
