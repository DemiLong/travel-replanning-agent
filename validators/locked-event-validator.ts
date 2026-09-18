import type { AgentContext, ProposedPlan, Violation } from "../types";
export function lockedEventValidator(
  c: AgentContext,
  p: ProposedPlan,
): Violation[] {
  return c.lockedEvents.flatMap((old) => {
    const n = p.events.find((e) => e.id === old.id);
    return !n ||
      !n.locked ||
      n.status !== "locked" ||
      (
        [
          "placeId",
          "name",
          "startTime",
          "endTime",
          "estimatedCost",
          "location",
        ] as const
      ).some((k) => n[k] !== old[k])
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
