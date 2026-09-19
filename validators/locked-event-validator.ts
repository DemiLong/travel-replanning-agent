import type { AgentContext, ProposedPlan, Violation } from "../types";
export function lockedEventValidator(
  c: AgentContext,
  p: ProposedPlan,
): Violation[] {
  return c.lockedEvents.flatMap((old) => {
    const n = p.events.find((e) => e.id === old.id);
    const suggestedUnknownDuration = old.durationSource === "unknown" && n?.durationSource === "suggested";
    return !n ||
      !n.locked ||
      n.status !== "locked" ||
      (
        [
          "placeId",
          "name",
          "startTime",
          "estimatedCost",
          "location",
        ] as const
      ).some((k) => n[k] !== old[k]) ||
      (!suggestedUnknownDuration && n.endTime !== old.endTime) ||
      (suggestedUnknownDuration && (n.endTime <= n.startTime || Number(n.endTime.slice(0, 2)) * 60 + Number(n.endTime.slice(3)) - (Number(n.startTime.slice(0, 2)) * 60 + Number(n.startTime.slice(3)) ) > 180))
      ? [
          {
            code: "locked_event" as const,
            eventId: old.id,
            message: `请保留锁定安排 ${old.name} 的 ${old.startTime}–${old.endTime} 时间、地点身份和费用。`,
          },
        ]
      : [];
  });
}
