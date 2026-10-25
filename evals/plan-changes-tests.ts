import assert from "node:assert/strict";
import { createStarterSnapshot } from "../data/session-defaults";
import { snapshotActivityFacts } from "../services/activity-facts";
import { buildPlanChanges, changePresentation } from "../services/plan-changes";
import { planNarrativeForDisplay, summarizeVerifiedPlan } from "../services/plan-narrative";
import { replanReal } from "../agents/real-replanning-agent";
import { EventSchema, SnapshotSchema, type AgentContext, type ProposedPlan } from "../types";
import type { RealWorldContext } from "../types/world";

async function main() {
  const event = EventSchema.parse({ id: "bund", placeId: "bund-poi", name: "外滩散步", category: "user activity",
    startTime: "13:20", endTime: "14:20", startTimeSource: "user", durationSource: "user", location: "外滩",
    status: "planned", locked: false, indoorOutdoor: "mixed", openingTime: null, closingTime: null,
    travelTimeFromPrevious: 10, travelMode: "WALKING", reason: "保留原安排并提示天气风险。", constraint: "原安排" });
  const starter = createStarterSnapshot();
  const base = SnapshotSchema.parse({ ...starter, trip: { ...starter.trip, destination: "上海" }, state: { ...starter.state, currentTime: "13:00", currentLocation: "人民广场", weather: "rain" },
    stateSources: { currentTime: "user", currentLocation: "user", weather: "user", energyLevel: "unset", disruption: "user" }, itinerary: [event] });
  const facts = snapshotActivityFacts(base);
  const plan = (events = [event], removedEvents: ProposedPlan["removedEvents"] = []): ProposedPlan => ({ summary: "候选", explanation: "保留外滩散步，提示雨天风险。", events, removedEvents, movedEvents: [] });
  const kinds = (value: ReturnType<typeof buildPlanChanges>[number]) => value.tags.map(tag => tag.kind);

  const delayed = buildPlanChanges(facts, plan([{ ...event, startTime: "14:00", endTime: "15:00", travelMode: undefined }]), base)[0];
  assert.equal(delayed.label, "时间调整");
  assert.deepEqual(delayed.rows[0], { label: "时间", before: "13:20–14:20", after: "14:00–15:00" });
  assert(!kinds(delayed).includes("duration"), "开始时间顺延不等于压缩停留");

  const unknown = { ...facts[0], origin: "message" as const, snapshotEventId: null, startTime: null, startTimeSource: "not_provided" as const, endTime: null, durationMinutes: null, durationSource: "unknown" as const };
  const suggested = buildPlanChanges([unknown], plan([{ ...event, startTimeSource: "suggested", endTime: "14:05", durationSource: "suggested" }]), base)[0];
  assert(kinds(suggested).includes("start_suggestion"));
  assert(kinds(suggested).includes("duration_suggestion"));
  assert(!suggested.rows.some(row => row.before), "工作快照的补时不能冒充用户原时间");
  assert(suggested.rows.some(row => row.after === "建议 45 分钟"));

  const alias = { ...facts[0], id: "parsed-bund", snapshotEventId: event.id };
  assert(!kinds(buildPlanChanges([alias], plan(), base)[0]).includes("added"));
  assert.equal(buildPlanChanges([{ ...facts[0], progress: "completed" }], plan([], []), base).length, 0);

  const first = { ...event, id: "first", placeId: "first-poi", name: "前一站", startTime: "11:00", endTime: "12:00", travelMode: undefined };
  const transportBase = SnapshotSchema.parse({ ...base, itinerary: [first, { ...event, travelMode: "TRANSIT" }] });
  const transportFacts = snapshotActivityFacts(transportBase);
  const taxi = buildPlanChanges(transportFacts, plan([first, { ...event, travelMode: "DRIVING" }]), transportBase)[1];
  assert(kinds(taxi).includes("transport"));
  assert(taxi.rows.some(row => row.before === "公共交通" && row.after === "打车"));
  const newOrigin = { ...first, id: "new-origin", placeId: "other-poi" };
  const differentLeg = buildPlanChanges(transportFacts, plan([newOrigin, { ...event, travelMode: "DRIVING" }]), transportBase)[1];
  assert(!kinds(differentLeg).includes("transport"));
  assert(kinds(differentLeg).includes("transport_suggestion"));
  assert(kinds(buildPlanChanges(facts, plan(), base)[0]).includes("transport_suggestion"), "首段原出发地不明，不能宣称换了交通方式");

  const removed = { eventId: event.id, name: event.name, reason: "建议取消外滩散步。", constraint: "弹性安排" };
  const added = { ...event, id: "new-museum", placeId: "museum-poi", name: "博物馆", location: "博物馆" };
  const removedAndAdded = buildPlanChanges(facts, plan([added], [removed]), base);
  assert.equal(removedAndAdded[0].label, "建议新增");
  assert.equal(removedAndAdded[1].label, "建议取消");
  assert.equal(changePresentation(removedAndAdded[0], true).label, "新增");
  assert(!summarizeVerifiedPlan({ remainingActivityFacts: facts } as AgentContext, plan([added], [removed])).includes("替换"));

  const unchanged = buildPlanChanges(facts, plan([{ ...event, travelMode: undefined }]), base)[0];
  assert.deepEqual(unchanged.tags, []);
  assert.equal(unchanged.label, "时间、地点未变");
  const noVisitLength = buildPlanChanges([{ ...facts[0], durationMinutes: null, endTime: null, durationSource: "unknown" }], plan([{ ...event, endTime: event.startTime, durationSource: "unknown", travelMode: undefined }]), base)[0];
  assert(!kinds(noVisitLength).includes("duration_suggestion"), "结束待定不能显示0分钟停留建议");

  const reversed = buildPlanChanges(transportFacts, plan([{ ...event, startTime: "10:00", endTime: "11:00" }, { ...first, startTime: "12:00", endTime: "13:00" }]), transportBase);
  assert(reversed.every(item => kinds(item).includes("order")));
  assert(!buildPlanChanges(transportFacts, plan([event]), transportBase).some(item => kinds(item).includes("order")), "删掉前一站不能误算为顺序调整");

  const context = { profile: base.profile, trip: base.trip, state: base.state, stateSources: base.stateSources,
    activityFacts: facts, remainingActivityFacts: facts, protectedActivityFacts: [], places: [], travelMinutes: {} } as unknown as AgentContext;
  const contradiction = { ...plan(), explanation: "外滩散步改为博物馆参观。" };
  assert.equal(planNarrativeForDisplay(context, contradiction).overview, null);
  assert.equal(planNarrativeForDisplay(context, contradiction).reasons.get(event.id), event.reason);
  const unknownContext = { ...context, activityFacts: [unknown], remainingActivityFacts: [unknown] };
  assert(!planNarrativeForDisplay(unknownContext, plan([{ ...event, reason: "缩短外滩散步的停留时间。" }])).reasons.has(event.id));

  const now = new Date().toISOString();
  const current = { id: "current", longitude: 121.47, latitude: 31.23, coordinateSystem: "GCJ02" as const, source: "user" as const, capturedAt: now, city: "上海市", adcode: "310101" };
  const poi = { poiId: event.placeId, name: "外滩", address: "外滩", city: "上海市", district: "黄浦区", adcode: "310101", longitude: 121.49, latitude: 31.23, coordinateSystem: "GCJ02" as const, type: "景点", source: "amap" as const, fetchedAt: now, status: "available" as const };
  const world: RealWorldContext = { status: "ready", currentTime: { value: "13:00", date: base.state.currentDate, source: "user", confirmedAt: now },
    currentLocation: current, resolvedPlaces: [{ placeId: event.placeId, poi }], alternatives: [],
    routes: [{ origin: current, destination: { ...poi, id: event.placeId }, travelMode: "WALKING", distanceMeters: 500, durationSeconds: 600, source: "amap", fetchedAt: now, status: "available" }],
    weather: { condition: "小雨", temperature: 20, humidity: 80, windDirection: null, windPower: null, forecast: [], source: "amap", fetchedAt: now, reportedAt: now, status: "available" },
    dataFreshness: { groundedAt: now, routeMaxAgeSeconds: 120, locationMaxAgeSeconds: 600 }, missingWorldFacts: [], ambiguities: [], travelMode: "WALKING" };
  const request = { reason: "weather", freeText: "下雨了", currentState: base.state, closedPlaceIds: [], variation: 0, stateSources: base.stateSources, activityFacts: facts };
  let calls = 0;
  const result = await replanReal({ snapshot: base, request, mode: "live", confirmation: { status: "confirmed", confirmedAt: now } }, { name: "controlled", generateCandidates: async () => {
    calls++;
    return [{ title: "不使用模型标题", tradeOff: contradiction.explanation, steps: [{ eventId: event.id, poiId: null, durationMinutes: null, travelMode: "WALKING", reason: event.reason }], removed: [] }];
  } }, { ground: async () => world });
  assert("ok" in result && result.ok, "说明风险不能淘汰通过硬校验的行程");
  assert.equal(calls, 1, "说明风险不能额外重调规划模型");
  console.log("Plan changes: provenance, transport legs, ordering, narrative fallback and planner integration passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
