import { ImpactAnalysisSchema, type ImpactAnalysis, type Snapshot, type ReplanningRequest } from "../types";
import type { RealWorldContext } from "../types/world";
import { minutes, time } from "../lib/time";

/**
 * Summarises facts and time windows for the planner. It deliberately does not
 * decide whether a window should contain rest, free time, or a new activity.
 */
export function analyzeImpact(
  snapshot: Snapshot,
  request: ReplanningRequest,
  world?: RealWorldContext,
): ImpactAnalysis {
  const now = minutes(request.currentState.currentTime);
  const remaining = snapshot.itinerary.filter((event) => event.status !== "completed");
  const completed = snapshot.itinerary.filter(
    (event) => event.status === "completed",
  );
  const locked = remaining.filter((event) => event.locked);
  const closed = new Set(request.closedPlaceIds);
  const affected = new Set<string>();
  const removed = new Set<string>();
  const risk = new Set<string>();
  const modified = new Set<string>();
  const disruptionKinds = new Set(
    (request.stateSources?.disruption === "user" ? [request.reason] : [request.reason]).filter(Boolean),
  );

  for (const event of remaining) {
    const outdoorWeather = request.reason === "weather" && event.indoorOutdoor === "outdoor";
    const isClosed = closed.has(event.placeId);
    const isLate = request.reason === "late" && minutes(event.startTime) <= now;
    const isTired = request.reason === "tired" && !event.locked;
    if (isClosed) {
      affected.add(event.id);
      removed.add(event.id);
    } else if (outdoorWeather || isLate || isTired) {
      affected.add(event.id);
      if (event.locked) risk.add(event.id);
      else modified.add(event.id);
    }
  }

  const preserved = remaining.filter((event) => !affected.has(event.id) || event.locked);
  const fixedStarts = locked
    .map((event) => minutes(event.startTime))
    .filter((value) => value > now)
    .sort((a, b) => a - b);
  const windows: ImpactAnalysis["availableTimeWindows"] = [];
  let cursor = now;
  for (const start of fixedStarts) {
    if (start > cursor) {
      windows.push({
        startTime: time(cursor),
        endTime: time(start),
        cause: disruptionKinds.size ? "当前变化与固定安排之间的剩余时间" : "固定安排之间的剩余时间",
        constraints: locked.filter((event) => minutes(event.startTime) === start).map((event) => `${event.startTime} 前需抵达 ${event.name}`),
      });
    }
    const fixed = locked.find((event) => minutes(event.startTime) === start);
    cursor = fixed?.durationSource==="unknown" ? 1440 : Math.max(cursor, fixed ? minutes(fixed.endTime) : start);
  }
  if (cursor < 24 * 60) {
    windows.push({
      startTime: time(cursor),
      endTime: "23:59",
      cause: "当天结束前的剩余时间",
      constraints: [],
    });
  }

  const result = {
    completedActivities: completed.map((event) => event.id),
    preservedActivities: preserved.map((event) => event.id),
    affectedActivities: [...affected],
    modifiedActivities: [...modified],
    removedActivities: [...removed],
    riskActivities: [...risk],
    lockedActivities: locked.map((event) => event.id),
    replacementCandidates: world?.alternatives.map((poi) => poi.poiId) ?? [],
    availableTimeWindows: windows,
  };
  return ImpactAnalysisSchema.parse(result);
}
