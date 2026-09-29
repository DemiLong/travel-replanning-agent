import { ActivityFactSchema, type ActivityFact, type ParsedUserInput, type Snapshot } from "../types";
import { minutes } from "../lib/time";

const key = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, "");

export function snapshotActivityFacts(snapshot: Snapshot): ActivityFact[] {
  return snapshot.itinerary.map(event => ActivityFactSchema.parse({
    id: event.id,
    origin: "snapshot",
    snapshotEventId: event.id,
    role: "existing_plan",
    progress: event.status === "completed" ? "completed" : event.status === "missed" ? "missed" : "not_started",
    name: event.name,
    placeQuery: event.location.trim() || event.name,
    startTime: event.startTime,
    startTimeSource: "snapshot",
    durationMinutes: event.durationSource === "unknown" ? null : Math.max(1, minutes(event.endTime) - minutes(event.startTime)),
    commitment: event.locked ? "fixed" : "flexible",
    sourceText: null,
  }));
}

export function reconcileActivityFacts(snapshot: Snapshot, incoming: ActivityFact[]): ActivityFact[] {
  const facts = snapshotActivityFacts(snapshot);
  for (const fact of incoming) {
    const matching = fact.role === "existing_plan" ? facts.filter(saved =>
      saved.origin === "snapshot" && saved.progress !== "completed" &&
      (fact.snapshotEventId === saved.id ||
        (key(saved.name) === key(fact.name) && (!fact.startTime || fact.startTime === saved.startTime))),
    ) : [];
    if (matching.length === 1) {
      const saved = matching[0];
      const index = facts.findIndex(item => item.id === saved.id);
      facts[index] = ActivityFactSchema.parse({
        ...saved,
        progress: fact.progress,
        sourceText: fact.sourceText,
      });
    } else if (!facts.some(item => item.id === fact.id)) {
      facts.push(ActivityFactSchema.parse(fact));
    }
  }
  return facts;
}

// Compatibility fields are projections of activityFacts. They never decide
// whether an original exists; null start time remains a valid original fact.
export function legacyActivitiesFromFacts(facts: ActivityFact[]): Pick<ParsedUserInput, "existingPlans" | "activityMentions"> {
  return {
    existingPlans: facts.filter(fact => fact.role === "existing_plan" && fact.progress !== "completed" && fact.startTime !== null).map(fact => ({
      id: fact.id,
      name: fact.name,
      startTime: fact.startTime!,
      endTime: null,
      durationMinutes: fact.durationMinutes,
      location: fact.placeQuery ?? "",
      locked: fact.commitment === "fixed",
      source: fact.origin === "snapshot" ? "system" : "user",
    })),
    activityMentions: facts.filter(fact => fact.origin === "message" && (fact.role !== "existing_plan" || fact.startTime === null)).map(fact => ({
      id: fact.id,
      role: fact.role,
      progress: fact.progress,
      name: fact.name,
      startTime: fact.startTime,
      startTimeEvidence: null,
      endTime: null,
      durationMinutes: fact.durationMinutes,
      location: fact.placeQuery,
      locked: fact.commitment === "fixed" ? "yes" : fact.commitment === "flexible" ? "no" : "uncertain",
      sourceText: fact.sourceText ?? "",
    })),
  };
}

export function confirmedOriginals(facts: ActivityFact[]) {
  return facts.filter(fact => fact.role === "existing_plan" && fact.progress !== "completed");
}
