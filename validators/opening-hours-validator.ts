import type { AgentContext, ProposedPlan, Violation } from "../types";
export function openingHoursValidator(
  c: AgentContext,
  p: ProposedPlan,
): Violation[] {
  return p.events.flatMap((e) => {
    if(c.world) return c.disruption.closedPlaceIds.includes(e.placeId)?[{code:"opening_hours" as const,eventId:e.id,message:`用户明确报告 ${e.name} 已关闭。`}]:[];
    const place = c.places.find((p) => p.id === e.placeId);
    if (!place) return [];
    return c.disruption.closedPlaceIds.includes(e.placeId) ||
      e.startTime < place.openingTime ||
      e.endTime > place.closingTime
      ? [
          {
            code: "opening_hours" as const,
            eventId: e.id,
            message: `${place.name} 不可用，或不在营业时间 ${place.openingTime}–${place.closingTime} 内。`,
          },
        ]
      : [];
  });
}
