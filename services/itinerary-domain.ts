import { addMinutesWithinDay, minutes } from "../lib/time";
import {
  ActivityFactSchema,
  ConfirmedDraftSchema,
  EventSchema,
  ParsedUserInputSchema,
  SnapshotSchema,
  type ActivityFact,
  type ConfirmedDraft,
  type ItineraryEvent,
  type ParsedUserInput,
  type Snapshot,
} from "../types";
import { confirmedOriginals, reconcileActivityFacts } from "./activity-facts";
import { stationLevelLocation } from "./protection-policy";

export function confirmParsedInput(input: ParsedUserInput): ParsedUserInput {
  if (input.missingFacts.length) return { ...input, status: "needs_input" };
  return ParsedUserInputSchema.parse({ ...input, status: "confirmed" });
}

function materializeFactTime(fact: ActivityFact, existing?: ItineraryEvent) {
  const suppliedEndTime = fact.endTime ?? (fact.startTime && fact.durationMinutes
    ? addMinutesWithinDay(fact.startTime, fact.durationMinutes)
    : null);
  if (existing && fact.startTime === existing.startTime && suppliedEndTime === null) {
    return existing.durationSource === "unknown"
      ? { endTime: fact.startTime!, durationSource: "unknown" as const }
      : { endTime: existing.endTime, durationSource: existing.durationSource ?? "user" as const };
  }
  if (suppliedEndTime !== null) return { endTime: suppliedEndTime, durationSource: fact.durationSource };
  return { endTime: fact.startTime!, durationSource: "unknown" as const };
}

export function activityFactToEvent(fact: ActivityFact, snapshot: Snapshot): ItineraryEvent {
  if (fact.role !== "existing_plan" || !fact.startTime || !fact.placeQuery?.trim()) {
    throw new Error(`安排“${fact.name}”缺少正式写入所需的角色、时间或地点。`);
  }
  const existing = snapshot.itinerary.find(event => event.id === (fact.snapshotEventId ?? fact.id));
  const timing = materializeFactTime(fact, existing);
  const location = existing ? fact.placeQuery : stationLevelLocation(fact.placeQuery).location;
  const locked = fact.commitment !== "flexible";
  return EventSchema.parse({
    ...(existing ?? {
      category: "user activity",
      indoorOutdoor: "mixed",
      openingTime: null,
      closingTime: null,
      travelTimeFromPrevious: null,
      reason: locked ? "这是用户确认需要保留的固定安排。" : "这是用户确认的原有安排。",
      constraint: locked ? "Locked plan" : "Original plan",
    }),
    id: fact.id,
    placeId: fact.placeId,
    name: fact.name,
    startTime: fact.startTime,
    endTime: timing.endTime,
    startTimeSource: fact.startTimeSource === "not_provided" ? "suggested" : fact.startTimeSource,
    durationSource: timing.durationSource,
    location,
    locked,
    protectionPolicy: fact.protectionPolicy,
    status: fact.progress === "completed" ? "completed"
      : fact.progress === "missed" ? "missed"
        : locked ? "locked" : "planned",
  });
}

export function eventsFromActivityFacts(snapshot: Snapshot, facts: ActivityFact[]): ItineraryEvent[] {
  return facts
    .filter(fact => fact.role === "existing_plan" && fact.startTime !== null && fact.placeQuery?.trim())
    .map(fact => activityFactToEvent(fact, snapshot))
    .sort((left, right) => left.startTime.localeCompare(right.startTime));
}

export function normalizeParsed(parsed: ParsedUserInput, _baseItineraryCount: number, closedPlaceIds: string[] = []) {
  const missing = parsed.missingFacts.filter(field =>
    !field.startsWith("activity:") &&
    !["activityFacts", "disruptionOrOptimize", "currentLocation", "closedPlace", "activityDecision", "activityDetails"].includes(field),
  );
  if (!confirmedOriginals(parsed.activityFacts).length) missing.push("activityFacts");
  if (!parsed.disruptions.length && parsed.intent !== "optimize") missing.push("disruptionOrOptimize");
  if (!parsed.context.currentLocation?.trim()) missing.push("currentLocation");
  if (parsed.disruptions.some(item => item.kind === "closed") && !closedPlaceIds.length) missing.push("closedPlace");
  if (parsed.activityFacts.some(fact => fact.role === "uncertain")) missing.push("activityDecision");
  if (confirmedOriginals(parsed.activityFacts).some(fact => !fact.placeQuery?.trim())) missing.push("activityDetails");
  return ParsedUserInputSchema.parse({
    ...parsed,
    missingFacts: [...new Set(missing)],
    status: missing.length ? "needs_input" : "draft",
  });
}

export function hydrateParsedPlans(snapshot: Snapshot, parsed: ParsedUserInput): ParsedUserInput {
  const activityFacts = reconcileActivityFacts(snapshot, parsed.activityFacts);
  return ParsedUserInputSchema.parse({ ...parsed, activityFacts });
}

export function confirmedDraftFromParsed(
  snapshot: Snapshot,
  parsed: ParsedUserInput,
  closedPlaceIds = parsed.closedPlaceIds,
  removedLockedIds: string[] = [],
  removedEventIds: string[] = [],
): ConfirmedDraft {
  const hydrated = hydrateParsedPlans(snapshot, parsed);
  return ConfirmedDraftSchema.parse({
    rawText: hydrated.rawText,
    intent: hydrated.intent,
    activityFacts: hydrated.activityFacts,
    removedOriginalIds: [...new Set(removedEventIds)],
    disruptions: hydrated.disruptions,
    constraints: hydrated.constraints,
    context: hydrated.context,
    contextSources: hydrated.contextSources,
    closedPlaceIds,
    question: hydrated.question,
    worldOptions: hydrated.worldOptions,
    destination: hydrated.destinationDraft,
    removedLockedIds,
    baseRevision: snapshot.revision,
  });
}

export function retainedFactsFromDraft(base: Snapshot, draft: ConfirmedDraft): ActivityFact[] {
  if (draft.baseRevision !== base.revision) throw new Error("原行程版本已变化，请重新确认后再生成方案。");
  const removedLocked = new Set(draft.removedLockedIds);
  const removedOriginal = new Set(draft.removedOriginalIds);
  const incoming = new Map(draft.activityFacts.map(fact => [fact.snapshotEventId ?? fact.id, ActivityFactSchema.parse(fact)]));

  for (const id of removedOriginal) {
    if (!base.itinerary.some(event => event.id === id && event.status !== "completed")) {
      throw new Error("删除记录不属于当前未完成行程。");
    }
  }
  for (const id of removedLocked) {
    const event = base.itinerary.find(item => item.id === id);
    if (!event?.locked) throw new Error("removedLockedIds 只能包含当前行程中的固定安排。");
    if (incoming.has(id) && !removedOriginal.has(id)) throw new Error("固定安排不能同时保留并标记为删除。");
  }

  for (const old of base.itinerary.filter(event => event.status !== "completed")) {
    const fact = incoming.get(old.id);
    if (!fact || removedOriginal.has(old.id)) {
      if (!removedOriginal.has(old.id)) throw new Error(`原安排“${old.name}”不能被静默删除，请先明确确认。`);
      if (old.locked && !removedLocked.has(old.id)) throw new Error(`固定安排“${old.name}”不能被静默删除，请先明确确认。`);
      continue;
    }
    if (fact.progress === "completed") continue;
    const policy = fact.protectionPolicy;
    const protectedFields = new Set(policy?.lockedFields ?? []);
    const allowedTimes = policy?.allowedStartTimes ?? [];
    const changedProtectedField = Boolean(old.locked && fact.commitment === "flexible") || Boolean(policy && (
      (protectedFields.has("name") && fact.name !== old.name) ||
      (protectedFields.has("startTime") && fact.startTime !== old.startTime && (!fact.startTime || !allowedTimes.includes(fact.startTime))) ||
      (protectedFields.has("endTime") && fact.endTime !== old.endTime) ||
      (protectedFields.has("duration") && fact.durationMinutes !== Math.max(1, minutes(old.endTime) - minutes(old.startTime))) ||
      (protectedFields.has("location") && (fact.placeId !== old.placeId || stationLevelLocation(fact.placeQuery ?? "").location !== stationLevelLocation(old.location).location))
    ));
    if (changedProtectedField) throw new Error(`固定安排“${old.name}”的受保护关键时间或地点不能修改或超出已确认范围。`);
  }

  return draft.activityFacts.filter(fact => !removedOriginal.has(fact.snapshotEventId ?? fact.id));
}

export function planningSnapshotFromDraft(base: Snapshot, draft: ConfirmedDraft): Snapshot {
  retainedFactsFromDraft(base, draft);
  return SnapshotSchema.parse({
    ...base,
    state: { ...base.state, ...draft.context },
    stateSources: { ...base.stateSources, ...draft.contextSources },
    trip: { ...base.trip, destination: draft.destination || base.trip.destination },
  });
}
