import { ActivityFactSchema, type ActivityFact, type Snapshot } from "../types";
import { addMinutesWithinDay, minutes } from "../lib/time";

const key = (value: string) => value.trim().toLocaleLowerCase().replace(/^(?:去|到|前往|参观|游览)/u, "").replace(/\s+/g, "");

function snapshotMatch(
  facts: ActivityFact[],
  incoming: ActivityFact,
): { saved: ActivityFact | null; ambiguous: boolean } {
  if (incoming.role !== "existing_plan") return { saved: null, ambiguous: false };

  const candidates = facts.filter(fact => fact.origin === "snapshot" && fact.progress !== "completed");
  if (incoming.snapshotEventId) {
    return {
      saved: candidates.find(fact => fact.id === incoming.snapshotEventId) ?? null,
      ambiguous: false,
    };
  }

  const nameMatches = candidates.filter(fact => key(fact.name) === key(incoming.name));
  if (nameMatches.length <= 1) {
    return { saved: nameMatches[0] ?? null, ambiguous: false };
  }

  const incomingPlace = incoming.placeQuery?.trim();
  if (incomingPlace) {
    const placeMatches = nameMatches.filter(fact => {
      const savedPlace = fact.placeQuery?.trim();
      return savedPlace ? key(savedPlace) === key(incomingPlace) : false;
    });
    if (placeMatches.length === 1) return { saved: placeMatches[0], ambiguous: false };
  }

  if (incoming.startTime) {
    const timeMatches = nameMatches.filter(fact => fact.startTime === incoming.startTime);
    if (timeMatches.length === 1) return { saved: timeMatches[0], ambiguous: false };
  }

  return { saved: null, ambiguous: true };
}

function shiftedTiming(saved: ActivityFact, incoming: ActivityFact) {
  const startTime = incoming.startTime ?? saved.startTime;
  const startChanged = incoming.startTime !== null && incoming.startTime !== saved.startTime;
  if (!startChanged) {
    return {
      startTime,
      endTime: incoming.endTime ?? saved.endTime,
      durationMinutes: incoming.durationMinutes ?? saved.durationMinutes,
      durationSource: incoming.endTime !== null || incoming.durationMinutes !== null
        ? incoming.durationSource
        : saved.durationSource,
    };
  }

  if (incoming.endTime !== null) {
    const durationMinutes = incoming.durationMinutes ?? Math.max(1, minutes(incoming.endTime) - minutes(startTime!));
    return { startTime, endTime: incoming.endTime, durationMinutes, durationSource: incoming.durationSource };
  }

  const durationMinutes = incoming.durationMinutes ?? saved.durationMinutes;
  if (startTime && durationMinutes) {
    try {
      return {
        startTime,
        endTime: addMinutesWithinDay(startTime, durationMinutes),
        durationMinutes,
        durationSource: incoming.durationMinutes !== null ? incoming.durationSource : saved.durationSource,
      };
    } catch {
      // The single-day model cannot represent an activity shifted past midnight.
    }
  }
  return { startTime, endTime: null, durationMinutes: null, durationSource: "unknown" as const };
}

export function snapshotActivityFacts(snapshot: Snapshot): ActivityFact[] {
  return snapshot.itinerary.map(event => ActivityFactSchema.parse({
    id: event.id,
    placeId: event.placeId,
    origin: "snapshot",
    snapshotEventId: event.id,
    role: "existing_plan",
    progress: event.status === "completed" ? "completed" : event.status === "missed" ? "missed" : "not_started",
    name: event.name,
    placeQuery: event.location.trim() || event.name,
    startTime: event.startTime,
    startTimeSource: "snapshot",
    endTime: event.durationSource === "unknown" ? null : event.endTime,
    durationMinutes: event.durationSource === "unknown" ? null : Math.max(1, minutes(event.endTime) - minutes(event.startTime)),
    durationSource: event.durationSource ?? "user",
    commitment: event.locked
      ? event.protectionPolicy?.source === "possible" ? "uncertain" : "fixed"
      : "flexible",
    protectionPolicy: event.protectionPolicy,
    sourceText: null,
  }));
}

export function mergeActivityFacts(current: ActivityFact[], incoming: ActivityFact[]): ActivityFact[] {
  const merged = new Map(current.map(fact => [fact.snapshotEventId ?? fact.id, fact]));
  for (const fact of incoming) {
    const identity = fact.snapshotEventId ?? fact.id;
    const existing = merged.get(identity);
    merged.set(identity, ActivityFactSchema.parse(existing ? {
      ...existing,
      ...fact,
      id: existing.id,
      placeId: existing.origin === "snapshot" ? existing.placeId : fact.placeId,
      origin: existing.origin === "snapshot" ? "snapshot" : fact.origin,
      snapshotEventId: existing.snapshotEventId ?? fact.snapshotEventId,
    } : fact));
  }
  return [...merged.values()];
}

export function reconcileActivityFacts(
  snapshot: Snapshot,
  incoming: ActivityFact[],
  onAmbiguousMatch?: (fact: ActivityFact) => void,
): ActivityFact[] {
  const facts = snapshotActivityFacts(snapshot);
  for (const fact of incoming) {
    const match = snapshotMatch(facts, fact);
    if (match.saved) {
      const saved = match.saved;
      const index = facts.findIndex(item => item.id === saved.id);
      const explicitSnapshotEdit = fact.origin === "snapshot";
      const commitment = explicitSnapshotEdit
        ? fact.commitment
        : fact.commitment === "flexible" ? saved.commitment : fact.commitment;
      const timing = explicitSnapshotEdit ? {
        startTime: fact.startTime,
        endTime: fact.endTime,
        durationMinutes: fact.durationMinutes,
        durationSource: fact.durationSource,
      } : shiftedTiming(saved, fact);
      facts[index] = ActivityFactSchema.parse({
        ...saved,
        progress: fact.progress,
        name: fact.name.trim() || saved.name,
        ...timing,
        placeQuery: explicitSnapshotEdit ? fact.placeQuery : fact.placeQuery?.trim() ? fact.placeQuery : saved.placeQuery,
        commitment,
        protectionPolicy: commitment === "flexible" ? undefined : fact.protectionPolicy ?? saved.protectionPolicy,
        sourceText: fact.sourceText,
      });
    } else if (match.ambiguous) {
      onAmbiguousMatch?.(fact);
    } else if (!facts.some(item => item.id === fact.id)) {
      facts.push(ActivityFactSchema.parse(fact));
    }
  }
  return facts;
}

export function confirmedOriginals(facts: ActivityFact[]) {
  return facts.filter(fact => fact.role === "existing_plan" && fact.progress !== "completed");
}
