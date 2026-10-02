import { ImpactAnalysisSchema, type ImpactAnalysis, type Snapshot, type ReplanningRequest } from "../types";
import type { RealWorldContext } from "../types/world";
import { minutes, time } from "../lib/time";
import { protectedArrivalDeadline } from "./protection-policy";

function activityExposure(name: string, place: string, sourceText: string | null, rawText: string) {
  const clauses = rawText.split(/[。；;，,\n]/).filter(clause => [name, place].filter(Boolean).some(label => clause.includes(label)));
  const description = [name, sourceText ?? "", ...clauses].join(" ");
  const outdoor = description.match(/散步|徒步|步行游览|骑行|跑步|登山|露营|户外|露天/);
  const indoor = description.match(/室内|馆内|店内|在店里/);
  if (outdoor && !indoor) return { exposure: "outdoor" as const, evidence: `用户描述包含“${outdoor[0]}”。` };
  if (indoor && !outdoor) return { exposure: "indoor" as const, evidence: `用户描述包含“${indoor[0]}”。` };
  return { exposure: "unknown" as const, evidence: outdoor && indoor ? "室内外描述互相冲突。" : "用户描述未说明室内外活动方式。" };
}

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
  const remaining = [
    ...snapshot.itinerary.filter((event) => event.status !== "completed").map(event => ({
      id: event.id, name: event.name, placeId: event.placeId, location: event.location,
      locked: event.locked, startTime: event.startTime as string | null, sourceText: null as string | null,
      arrivalDeadline: protectedArrivalDeadline(event),
    })),
    ...(request.unscheduledOriginals ?? []).filter(fact => fact.role === "existing_plan" && fact.progress !== "completed").map(fact => ({
      id: fact.id, name: fact.name, placeId: `custom-${fact.id}`, location: fact.placeQuery ?? "",
      locked: fact.commitment !== "flexible", startTime: fact.startTime as string | null, sourceText: fact.sourceText,
      arrivalDeadline: fact.startTime ? minutes(fact.startTime) : null,
    })),
  ];
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

  const activityWeatherJudgments = remaining.map(event => {
    const judgment = activityExposure(event.name, event.location, event.sourceText, request.freeText);
    return { id: event.id, name: event.name, ...judgment, affected: request.reason === "weather" && judgment.exposure === "outdoor" };
  });
  for (const event of remaining) {
    const outdoorWeather = activityWeatherJudgments.some(item => item.id === event.id && item.affected);
    const isClosed = closed.has(event.placeId);
    const isLate = request.reason === "late" && event.startTime !== null && minutes(event.startTime) <= now;
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
    .filter(event => event.startTime !== null)
    .map((event) => event.arrivalDeadline ?? minutes(event.startTime!))
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
        constraints: locked.filter((event) => event.startTime !== null && (event.arrivalDeadline ?? minutes(event.startTime)) === start).map((event) => `${time(start)} 前需抵达 ${event.name}`),
      });
    }
    const fixed = snapshot.itinerary.find((event) => event.locked && protectedArrivalDeadline(event) === start);
    // Unknown duration is not a question for the traveler. If another fixed
    // appointment follows, keep the gap open so the planner can suggest a
    // stay length and validate whether that appointment remains reachable. If
    // this is the last fixed appointment, do not invent a post-appointment
    // window that would imply its unknown end time.
    const hasLaterFixed = fixedStarts.some((value) => value > start);
    cursor = fixed?.durationSource === "unknown"
      ? hasLaterFixed ? start : 1440
      : Math.max(cursor, fixed ? minutes(fixed.endTime) : start);
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
    activityWeatherJudgments,
    availableTimeWindows: windows,
  };
  return ImpactAnalysisSchema.parse(result);
}
