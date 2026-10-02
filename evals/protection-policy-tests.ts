import assert from "node:assert/strict";
import { runAgentAssist } from "../agents/agent-orchestrator";
import { createStarterSnapshot } from "../data/session-defaults";
import { normalizeSemanticExtraction } from "../services/semantic-parser";
import { parsedToEvent } from "../services/itinerary-domain";
import {
  protectedArrivalDeadline,
  protectionPolicyForActivity,
  stationLevelLocation,
} from "../services/protection-policy";
import { stationLevelCandidates } from "../services/world/context-resolution";
import { EventSchema, ReplanningRequestSchema, SemanticExtractionSchema, SnapshotSchema, type AgentContext, type ItineraryEvent, type ProposedPlan } from "../types";
import { protectionPolicyValidator } from "../validators/protection-policy-validator";

async function main() {
const starter = createStarterSnapshot();
const snapshot = SnapshotSchema.parse({
  ...starter,
  trip: { ...starter.trip, destination: "上海" },
  state: { ...starter.state, currentLocation: "人民广场", currentTime: "09:00", stateCapturedAt: new Date().toISOString() },
  stateSources: { ...starter.stateSources, currentLocation: "user", currentTime: "user", disruption: "user" },
  itinerary: [],
});
const semanticContext = {
  currentTime: { value: null, sourceText: null },
  currentLocation: { value: null, sourceText: null },
  weather: { value: null, sourceText: null },
  energyLevel: { value: null, sourceText: null },
};

const text = "下雨了，18点可能预约了海棠餐厅，请帮我调整";
const uncertain = normalizeSemanticExtraction(snapshot, text, SemanticExtractionSchema.parse({
  intent: "rescue",
  activities: [{ role: "existing_plan", name: "海棠餐厅晚餐", startTime: "18:00", startTimeEvidence: "18点", endTime: null, durationMinutes: null, location: "海棠餐厅", locked: "no", sourceText: "18点可能预约了海棠餐厅", progress: "not_started" }],
  disruptions: [{ kind: "weather", label: "下雨", sourceText: "下雨" }],
  constraints: [],
  context: semanticContext,
  question: null,
  ambiguities: [],
}), "test-model");
assert.equal(uncertain.activityFacts.find(fact => fact.origin === "message")?.commitment, "uncertain");
assert.equal(uncertain.existingPlans[0].locked, true);
assert.deepEqual(uncertain.existingPlans[0].protectionPolicy?.lockedFields, ["startTime", "location"]);
assert.deepEqual(uncertain.existingPlans[0].protectionPolicy?.durationPolicy, { mode: "suggested", defaultMinutes: 90, minMinutes: 60, maxMinutes: 150 });
const uncertainAssist = await runAgentAssist(
  { snapshot, rawText: text },
  undefined,
  { parse: async () => uncertain, ground: async () => { throw new Error("grounding reached"); } },
);
assert.equal(uncertainAssist.status, "UPSTREAM_UNAVAILABLE", "固定性不明确不得触发 NEEDS_INPUT");

function contextFor(event: ItineraryEvent): AgentContext {
  return {
    profile: snapshot.profile,
    trip: snapshot.trip,
    state: snapshot.state,
    stateSources: snapshot.stateSources,
    existingItinerary: [event],
    remainingEvents: [event],
    lockedEvents: [event],
    disruption: ReplanningRequestSchema.parse({ reason: "optimize", freeText: "优化", currentState: snapshot.state, closedPlaceIds: [], variation: 0 }),
    places: [],
    travelMinutes: {},
  };
}
function planWith(event: ItineraryEvent): ProposedPlan {
  return { summary: "测试", explanation: "测试", events: [event], movedEvents: [], removedEvents: [] };
}

const restaurant = parsedToEvent(uncertain.existingPlans[0], snapshot);
const suggestedDinner = EventSchema.parse({ ...restaurant, endTime: "19:30", durationSource: "suggested" });
assert.deepEqual(protectionPolicyValidator(contextFor(restaurant), planWith(suggestedDinner)), []);
assert(protectionPolicyValidator(contextFor(restaurant), planWith(EventSchema.parse({ ...suggestedDinner, endTime: "18:30" }))).length > 0);
assert(protectionPolicyValidator(contextFor(restaurant), planWith(EventSchema.parse({ ...suggestedDinner, startTime: "18:30", endTime: "20:00" }))).length > 0);
assert.deepEqual(protectionPolicyValidator(contextFor(restaurant), planWith(EventSchema.parse({ ...suggestedDinner, name: "晚餐" }))), []);

const movie = protectionPolicyForActivity({ name: "电影", location: "百丽宫影城", sourceText: "20点电影票", startTime: "20:00", endTime: "22:00", durationMinutes: 120, commitment: "fixed" });
assert.deepEqual(movie?.lockedFields, ["name", "startTime", "endTime", "duration", "location"]);
const movieEvent = EventSchema.parse({ ...restaurant, id: "movie", name: "电影", location: "百丽宫影城", startTime: "20:00", endTime: "22:00", durationSource: "user", protectionPolicy: movie });
assert(protectionPolicyValidator(contextFor(movieEvent), planWith(EventSchema.parse({ ...movieEvent, endTime: "21:30" }))).length > 0);

const meeting = protectionPolicyForActivity({ name: "和朋友集合", location: "人民广场地铁站 A 口", sourceText: "18点前和朋友集合", startTime: "18:00", durationMinutes: null, commitment: "fixed" });
assert.equal(meeting?.timeAnchor, "arrive_by");
assert.deepEqual(meeting?.durationPolicy, { mode: "suggested", defaultMinutes: 60, minMinutes: 30, maxMinutes: 120 });
assert.deepEqual(stationLevelLocation("人民广场地铁站 A 口"), { location: "人民广场地铁站", note: "人民广场地铁站 A 口" });

const flightPolicy = protectionPolicyForActivity({ name: "航班", location: "浦东国际机场 2号航站楼", sourceText: "20点国际航班", startTime: "20:00", durationMinutes: null, commitment: "fixed" });
const flight = EventSchema.parse({
  id: "flight", placeId: "airport", name: "航班", category: "transport",
  startTime: "20:00", endTime: "20:00", durationSource: "unknown", location: "浦东国际机场 2号航站楼",
  status: "locked", locked: true, protectionPolicy: flightPolicy, indoorOutdoor: "mixed",
  openingTime: null, closingTime: null, travelTimeFromPrevious: null, reason: "固定航班", constraint: "交通时间",
});
assert.equal(flightPolicy?.arrivalBuffer?.recommendedMinutes, 180);
assert.equal(protectedArrivalDeadline(flight), 17 * 60);

const arriveByTrain = protectionPolicyForActivity({ name: "到广州东站", location: "广州东站", sourceText: "下午5点到广州东站", startTime: "17:00", durationMinutes: null, commitment: "fixed" });
assert.equal(arriveByTrain?.timeAnchor, "arrive_by");
assert.equal(arriveByTrain?.arrivalBuffer, null);

const rebookable = protectionPolicyForActivity({ name: "体检预约", location: "市民医院", sourceText: "原定10点，可改签到下午2点或16:00", startTime: "10:00", durationMinutes: 60, commitment: "fixed" });
assert.deepEqual(rebookable?.allowedStartTimes, ["10:00", "14:00", "16:00"]);
const rebookEvent = EventSchema.parse({ ...restaurant, id: "checkup", name: "体检预约", location: "市民医院", startTime: "10:00", endTime: "11:00", durationSource: "user", protectionPolicy: rebookable });
assert.deepEqual(protectionPolicyValidator(contextFor(rebookEvent), planWith(EventSchema.parse({ ...rebookEvent, startTime: "14:00", endTime: "15:00" }))), []);
assert(protectionPolicyValidator(contextFor(rebookEvent), planWith(EventSchema.parse({ ...rebookEvent, startTime: "15:00", endTime: "16:00" }))).length > 0);

const candidates = stationLevelCandidates([
  { poiId: "a", name: "人民广场地铁站A口", address: "A口", city: "上海市", district: "黄浦区", adcode: "310101", longitude: 121.47, latitude: 31.23, coordinateSystem: "GCJ02", type: "地铁站出入口", source: "amap", fetchedAt: new Date().toISOString(), status: "available" },
  { poiId: "b", name: "人民广场地铁站B口", address: "B口", city: "上海市", district: "黄浦区", adcode: "310101", longitude: 121.47, latitude: 31.23, coordinateSystem: "GCJ02", type: "地铁站出入口", source: "amap", fetchedAt: new Date().toISOString(), status: "available" },
], "人民广场地铁站");
assert.equal(candidates.length, 1);
assert.equal(candidates[0].displayName, "人民广场地铁站");

console.log("PASS protection policy: uncertain defaults, field rules, transport buffers, rebooking, station granularity");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
