import { RealSessionSchema, SnapshotSchema, type ItineraryEvent } from "../types";
import { snapshotActivityFacts } from "../services/activity-facts";
import { createStarterSnapshot } from "../data/session-defaults";

export function planDetailsFixture() {
  const now = new Date().toISOString();
  const starter = createStarterSnapshot();
  const meal: ItineraryEvent = { id: "meal", placeId: "meal-poi", name: "虹桥天地（购物中心南区）餐饮区用餐", location: "虹桥天地购物中心南区", category: "user activity",
    startTime: "17:00", endTime: "17:00", startTimeSource: "user", durationSource: "unknown", status: "planned", locked: false,
    indoorOutdoor: "mixed", openingTime: null, closingTime: null, travelTimeFromPrevious: null, reason: "原定用餐安排", constraint: "弹性安排" };
  const theatre: ItineraryEvent = { ...meal, id: "theatre", placeId: "theatre-poi", name: "上海大剧院固定演出", location: "上海大剧院", startTime: "19:30", endTime: "21:00", durationSource: "user", status: "locked", locked: true,
    protectionPolicy: { source: "confirmed", kind: "ticketed_event", lockedFields: ["name", "startTime", "endTime", "duration", "location"], timeAnchor: "starts_at",
      durationPolicy: { mode: "fixed", defaultMinutes: 90, minMinutes: 90, maxMinutes: 90 }, allowedStartTimes: ["19:30"], locationGranularity: "venue", transportKind: null, arrivalBuffer: null, locationNote: null } };
  const shopping: ItineraryEvent = { ...meal, id: "shopping", placeId: "shopping-poi", name: "虹桥天地逛街", location: "虹桥天地", startTime: "18:00", endTime: "19:00", durationSource: "user" };
  const base = SnapshotSchema.parse({ ...starter, trip: { ...starter.trip, destination: "上海" }, state: { ...starter.state, currentTime: "16:00", currentLocation: "虹桥机场", stateCapturedAt: now },
    stateSources: { currentTime: "user", currentLocation: "user", weather: "unset", energyLevel: "unset", disruption: "user" }, itinerary: [meal, shopping, theatre], revision: 1 });
  const facts = snapshotActivityFacts(base);
  const request = { reason: "late", freeText: "晚到了，想保住19:30上海大剧院演出，先去虹桥天地吃饭，不逛街也行。", currentState: base.state, closedPlaceIds: [], variation: 0, stateSources: base.stateSources, activityFacts: facts };
  const makePlan = (alternative = false) => ({ summary: "建议安排", explanation: alternative ? "公共交通减少打车支出，但用餐安排更晚；仍优先保留固定演出。" : "优先保住固定演出，推荐打车前往用餐与演出地点。用餐停留为规划建议，取消逛街以留出更多衔接空间。代价是用餐节奏较紧，沿途临时情况可能影响衔接；建议出发前再确认入场要求及最新路况。",
    events: [{ ...meal, startTime: alternative ? "17:40" : "17:20", endTime: alternative ? "18:25" : "18:05", durationSource: "suggested", travelMode: alternative ? "TRANSIT" : "DRIVING", travelTimeFromPrevious: alternative ? 55 : 35,
      reason: alternative ? "公共交通适合更在意交通支出的选择，用餐需注意结束时间。" : "保留在虹桥天地用餐的意愿，建议简单吃一餐，再前往剧院。" },
    { ...theatre, travelMode: "DRIVING", travelTimeFromPrevious: 40, reason: "固定演出时间保留，出发前请留意路况与入场要求。" }],
    removedEvents: [{ eventId: shopping.id, name: shopping.name, reason: "减少额外停留，把时间留给用餐与赶往剧院。", constraint: "弹性安排" }], movedEvents: [] });
  const primary = makePlan(), alternative = makePlan(true);
  const context = { profile: base.profile, trip: base.trip, state: base.state, stateSources: base.stateSources, activityFacts: facts, remainingActivityFacts: facts, protectedActivityFacts: [facts[2]],
    disruption: request, places: [], travelMinutes: {} };
  return RealSessionSchema.parse({ schemaVersion: 5, experienceMode: "real", flowStage: "PLAN_READY", snapshot: base, rawInput: request.freeText, parsedInput: null, lastDisruption: request,
    pendingPlan: { base, request, result: { id: "details-preview", ok: true, plan: primary, attempts: [], mode: "live", model: "controlled-ui-fixture", message: "受控页面验收", context,
      candidatePlans: [{ id: "primary", title: "推荐方案", tradeOff: primary.explanation, feasible: true, plan: primary, conflicts: [] }, { id: "alternative", title: "备选方案", tradeOff: alternative.explanation, feasible: true, plan: alternative, conflicts: [] }] } },
    resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] }, updatedAt: now });
}
