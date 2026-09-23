import { addMinutesWithinDay, minutes } from "../lib/time";
import {
  ConfirmedDraftSchema,
  ParsedUserInputSchema,
  type ConfirmedDraft,
  type ParsedUserInput,
  type Snapshot,
  type ItineraryEvent,
} from "../types";

function activityNameKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^(?:原定|原本|计划|准备)?(?:要)?(?:去|到|前往|参观)/, "");
}

function sameActivityAtSameTime(
  event: ItineraryEvent,
  item: { name: string; startTime: string | null },
) {
  return Boolean(
    item.startTime &&
      event.startTime === item.startTime &&
      activityNameKey(event.name) === activityNameKey(item.name),
  );
}

export function confirmParsedInput(input: ParsedUserInput): ParsedUserInput {
  if (input.missingFacts.length) return { ...input, status: "needs_input" };
  return ParsedUserInputSchema.parse({ ...input, status: "confirmed" });
}

function materializeParsedTime(
  item: ParsedUserInput["existingPlans"][number],
  existing?: ItineraryEvent,
) {
  const suppliedEndTime = item.endTime !== null
    ? item.endTime
    : item.durationMinutes !== null
      ? addMinutesWithinDay(item.startTime, item.durationMinutes)
      : null;
  if (
    existing &&
    item.startTime === existing.startTime &&
    (suppliedEndTime === null || suppliedEndTime === existing.endTime)
  ) {
    return {
      endTime: existing.endTime,
      durationSource: existing.durationSource ?? "unknown" as const,
    };
  }
  if (suppliedEndTime !== null) return { endTime: suppliedEndTime, durationSource: "user" as const };
  return { endTime: item.startTime, durationSource: "unknown" as const };
}

export function parsedToEvent(item: ParsedUserInput["existingPlans"][number], snapshot: Snapshot): ItineraryEvent {
  const existing = snapshot.itinerary.find(
    (event) =>
      event.id === item.id ||
      sameActivityAtSameTime(event, item),
  );
  const timing = materializeParsedTime(item, existing);
  const locked = Boolean(existing?.locked || item.locked);
  const changedLocation = Boolean(existing && item.location.trim() !== existing.location.trim());
  return {
    ...(existing ?? {
      id: `event-${item.id}`,
      placeId: `custom-${item.id}`,
      category: "user activity",
      indoorOutdoor: "mixed" as const,
      openingTime: null,
      closingTime: null,
      travelTimeFromPrevious: null,
      reason: locked ? "这是用户确认需要保留的固定安排。" : "这是用户确认的原有安排。",
      constraint: locked ? "Locked plan" : "Original plan",
    }),
    id: existing?.id ?? `event-${item.id}`,
    placeId: changedLocation ? `draft-place-${existing!.id}` : existing?.placeId ?? `custom-${item.id}`,
    name: item.name,
    startTime: item.startTime,
    endTime: timing.endTime,
    durationSource: timing.durationSource,
    location: item.location,
    locked,
    status: locked ? "locked" : existing?.status === "completed" ? "completed" : "planned",
  };
}

export function mergePlans(snapshot: Snapshot, parsed: ParsedUserInput): ItineraryEvent[] {
  const next = [...snapshot.itinerary];
  for (const item of parsed.existingPlans) {
    const converted = parsedToEvent(item, snapshot);
    const index = next.findIndex((event) => event.id === converted.id);
    if (index >= 0) next[index] = converted;
    else next.push(converted);
  }
  return next.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export function normalizeParsed(parsed: ParsedUserInput, baseItineraryCount: number, closedPlaceIds: string[] = []) {
  const missing = parsed.missingFacts.filter(
    (field) =>
      !field.startsWith("activity:") &&
      !["existingPlans", "disruptionOrOptimize", "currentLocation", "closedPlace", "activityDecision", "activityDetails"].includes(field),
  );
  if (baseItineraryCount + parsed.existingPlans.length + parsed.activityMentions.length === 0) missing.push("existingPlans");
  if (!parsed.disruptions.length && parsed.intent !== "optimize") missing.push("disruptionOrOptimize");
  if (!parsed.context.currentLocation?.trim()) missing.push("currentLocation");
  if (parsed.disruptions.some((item) => item.kind === "closed") && closedPlaceIds.length === 0) missing.push("closedPlace");
  if (parsed.activityMentions.length) missing.push("activityDecision");
  for (const mention of parsed.activityMentions) {
    if (!mention.location) missing.push(`activity:${mention.id}:location`);
    if (!mention.startTime) missing.push(`activity:${mention.id}:startTime`);
  }
  if (parsed.existingPlans.some((item) => !item.location.trim())) missing.push("activityDetails");
  return ParsedUserInputSchema.parse({
    ...parsed,
    missingFacts: [...new Set(missing)],
    status: missing.length ? "needs_input" : "draft",
  });
}

export function hydrateParsedPlans(snapshot: Snapshot, parsed: ParsedUserInput): ParsedUserInput {
  const promotedMentionIds = new Set<string>();
  const matchedSavedMentionIds = new Set<string>();
  const promotedPlans: ParsedUserInput["existingPlans"] = [];
  for (const mention of parsed.activityMentions) {
    const savedMatches = snapshot.itinerary.filter(
      (event) => event.status !== "completed" && sameActivityAtSameTime(event, mention),
    );
    if (mention.role === "existing_plan" && savedMatches.length === 1) {
      matchedSavedMentionIds.add(mention.id);
      continue;
    }
    if (
      mention.role !== "existing_plan" ||
      !mention.name.trim() ||
      !mention.startTime ||
      !mention.location?.trim()
    ) continue;
    promotedMentionIds.add(mention.id);
    promotedPlans.push({
      id: mention.id,
      name: mention.name.trim(),
      startTime: mention.startTime,
      endTime: mention.endTime,
      durationMinutes: mention.durationMinutes,
      location: mention.location.trim(),
      locked: mention.locked === "yes",
      source: "user",
    });
  }
  const used = new Set<string>();
  const plans = [...parsed.existingPlans, ...promotedPlans].map((item) => {
    const match = snapshot.itinerary.find((event) =>
      !used.has(event.id) && event.status !== "completed" &&
      (event.id === item.id || sameActivityAtSameTime(event, item)),
    );
    if (!match) return item;
    used.add(match.id);
    return { ...item, id: match.id };
  });
  for (const event of snapshot.itinerary.filter((item) => item.status !== "completed" && !used.has(item.id))) {
    plans.push({
      id: event.id,
      name: event.name,
      startTime: event.startTime,
      endTime: event.durationSource === "unknown" ? null : event.endTime,
      durationMinutes: event.durationSource === "unknown" ? null : Math.max(1, minutes(event.endTime) - minutes(event.startTime)),
      location: event.location,
      locked: event.locked,
      source: "user",
    });
  }
  return ParsedUserInputSchema.parse({
    ...parsed,
    existingPlans: plans,
    activityMentions: parsed.activityMentions.filter(
      (mention) =>
        !promotedMentionIds.has(mention.id) &&
        !matchedSavedMentionIds.has(mention.id),
    ),
  });
}

export function confirmedDraftFromParsed(
  snapshot: Snapshot,
  parsed: ParsedUserInput,
  closedPlaceIds = parsed.closedPlaceIds,
  removedLockedIds: string[] = [],
  removedEventIds: string[] = [],
): ConfirmedDraft {
  const hydrated = hydrateParsedPlans(snapshot, parsed);
  const removed = new Set(removedEventIds);
  const merged = mergePlans(snapshot, hydrated).filter(event => !removed.has(event.id));
  return ConfirmedDraftSchema.parse({
    rawText: hydrated.rawText,
    intent: hydrated.intent,
    existingPlans: merged
      .filter((event) => event.status !== "completed")
      .map((event) => ({
        id: event.id,
        placeId: event.placeId,
        name: event.name,
        startTime: event.startTime,
        endTime: event.durationSource === "unknown" ? null : event.endTime,
        durationMinutes: event.durationSource === "unknown" ? null : Math.max(1, minutes(event.endTime) - minutes(event.startTime)),
        durationSource: event.durationSource ?? "unknown",
        location: event.location,
        locked: event.locked,
      })),
    activityMentions: hydrated.activityMentions,
    disruptions: hydrated.disruptions,
    constraints: hydrated.constraints,
    context: hydrated.context,
    contextSources: hydrated.contextSources,
    closedPlaceIds,
    question: hydrated.question,
    worldOptions: hydrated.worldOptions,
    removedLockedIds,
    baseRevision: snapshot.revision,
  });
}
