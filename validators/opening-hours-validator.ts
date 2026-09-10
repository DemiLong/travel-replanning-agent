import type { AgentContext, ProposedPlan, Violation } from "../types";
export function openingHoursValidator(
  c: AgentContext,
  p: ProposedPlan,
): Violation[] {
  return p.events.flatMap((e) => {
    const place = c.places.find((p) => p.id === e.placeId);
    if (!place) return [];
    return c.disruption.closedPlaceIds.includes(e.placeId) ||
      e.startTime < place.openingTime ||
      e.endTime > place.closingTime
      ? [
          {
            code: "opening_hours" as const,
            eventId: e.id,
            message: `${place.name} is unavailable, or outside ${place.openingTime}–${place.closingTime}.`,
          },
        ]
      : [];
  });
}
