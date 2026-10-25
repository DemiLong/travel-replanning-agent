import { minutes } from "../lib/time";
import type { ActivityFact, AgentContext, ItineraryEvent, ParsedUserInput, Snapshot } from "../types";

/** Keep deadlines through acceptance/replanning, including limits without a card. */
export function planningTimeConstraints(snapshot: Snapshot, constraints: ParsedUserInput["constraints"], facts: ActivityFact[]) {
  const clearedEnd = constraints.some(item => item.kind === "time" && item.timeScope === "clear_itinerary_end");
  const incoming = constraints.filter(item => item.kind === "time" && item.timeScope !== "clear_itinerary_end" && (item.timeScope !== "preference" || item.endByTime)).map(item => ({
    value: item.value,
    sourceText: item.sourceText,
    endByTime: item.endByTime ?? null,
    activityIds: item.endByTime ? [] : item.activityIds?.length ? item.activityIds : facts.filter(fact => fact.sourceText && item.sourceText &&
      fact.sourceText.includes(item.sourceText)).map(fact => fact.id),
  }));
  const replacesEnd = incoming.some(item => item.endByTime);
  const retained = (snapshot.timeConstraints ?? []).filter(item =>
    !((replacesEnd || clearedEnd) && item.endByTime) && !incoming.some(next => next.value === item.value) &&
    // retainedFactsFromDraft has already checked explicit removals. A deleted
    // anchor's constraint must not become an unresolvable ghost on the next run.
    !(item.activityIds?.length && item.activityIds.every(id => snapshot.itinerary.some(event => event.id === id) &&
      !facts.some(fact => fact.id === id || fact.snapshotEventId === id))));
  return [...retained, ...incoming].map(item => ({ ...item,
    activityIds: item.activityIds?.map(id => facts.find(fact => fact.id === id || fact.snapshotEventId === id)?.id ?? id),
  }));
}

export function scheduleEndLimit(context: AgentContext) {
  const limits = (context.disruption.timeConstraints ?? []).flatMap(item => item.endByTime ? [minutes(item.endByTime)] : []);
  return limits.length ? Math.min(...limits) : null;
}

export function unresolvedTimeConstraints(context: AgentContext) {
  return (context.disruption.timeConstraints ?? []).filter(item => !item.endByTime &&
    !(item.activityIds?.length && item.activityIds.every(id => context.activityFacts.some(fact =>
      (fact.id === id || fact.snapshotEventId === id) && fact.startTime !== null))));
}

export function hasConfirmedDuration(fact: ActivityFact) {
  return fact.durationSource === "user";
}

export function canLeaveEndUnknown(context: AgentContext, fact?: ActivityFact) {
  if (fact && hasConfirmedDuration(fact)) return false;
  // A fixed policy with a known duration remains authoritative even when old
  // saved data labelled that duration as a suggestion.
  if (fact?.protectionPolicy?.durationPolicy.mode === "fixed") return false;
  return scheduleEndLimit(context) === null && !unresolvedTimeConstraints(context).length;
}

export function hasUnknownEnd(event: ItineraryEvent) {
  return event.durationSource === "unknown" && event.endTime === event.startTime;
}
