import { addMinutesWithinDay, minutes } from "../lib/time";
import {
  ConfirmedDraftSchema,
  ParsedUserInputSchema,
  type ConfirmedDraft,
  type ParsedUserInput,
  type Snapshot,
  type ItineraryEvent,
} from "../types";

function materializeParsedTime(item: ParsedUserInput["existingPlans"][number]) {
  if (item.endTime) return { endTime: item.endTime, durationSource: "user" as const };
  if (item.durationMinutes !== null)
    return { endTime: addMinutesWithinDay(item.startTime, item.durationMinutes), durationSource: "user" as const };
  return { endTime: item.startTime, durationSource: "unknown" as const };
}

export function parsedToEvent(item: ParsedUserInput["existingPlans"][number], snapshot: Snapshot): ItineraryEvent {
  const existing = snapshot.itinerary.find(
    (event) =>
      event.id === item.id ||
      (event.startTime === item.startTime && event.name.trim().toLowerCase() === item.name.trim().toLowerCase()),
  );
  const timing = materializeParsedTime(item);
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
    estimatedCost: item.estimatedCost,
    estimatedCostKnown: item.estimatedCostKnown,
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
  const used = new Set<string>();
  const plans = parsed.existingPlans.map((item) => {
    const match = snapshot.itinerary.find((event) =>
      !used.has(event.id) && event.status !== "completed" &&
      (event.id === item.id || (event.startTime === item.startTime && event.name.trim().toLowerCase() === item.name.trim().toLowerCase())),
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
      estimatedCost: event.estimatedCost,
      estimatedCostKnown: event.estimatedCostKnown,
      locked: event.locked,
      source: "user",
    });
  }
  return ParsedUserInputSchema.parse({ ...parsed, existingPlans: plans });
}

export function confirmedDraftFromParsed(
  snapshot: Snapshot,
  parsed: ParsedUserInput,
  closedPlaceIds = parsed.closedPlaceIds,
  removedLockedIds: string[] = [],
): ConfirmedDraft {
  const merged = mergePlans(snapshot, parsed);
  return ConfirmedDraftSchema.parse({
    rawText: parsed.rawText,
    intent: parsed.intent,
    existingPlans: merged
      .filter((event) => event.status !== "completed")
      .map((event) => ({
        id: event.id,
        placeId: event.placeId,
        name: event.name,
        startTime: event.startTime,
        endTime: event.durationSource === "unknown" ? null : event.endTime,
        durationMinutes: event.durationSource === "unknown" ? null : Math.max(1, minutes(event.endTime) - minutes(event.startTime)),
        location: event.location,
        estimatedCost: event.estimatedCost,
        estimatedCostKnown: event.estimatedCostKnown,
        locked: event.locked,
      })),
    activityMentions: parsed.activityMentions,
    disruptions: parsed.disruptions,
    constraints: parsed.constraints,
    context: parsed.context,
    contextSources: parsed.contextSources,
    closedPlaceIds,
    question: parsed.question,
    worldOptions: parsed.worldOptions,
    removedLockedIds,
    baseRevision: snapshot.revision,
  });
}
