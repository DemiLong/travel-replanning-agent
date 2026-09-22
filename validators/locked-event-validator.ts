import type { AgentContext, ProposedPlan, Violation } from "../types";
import { MAX_SUGGESTED_DURATION, MIN_SUGGESTED_DURATION, minutes } from "../lib/time";
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
          "location",
        ] as const
      ).some((k) => n[k] !== old[k]) ||
      (!suggestedUnknownDuration && n.endTime !== old.endTime) ||
      (suggestedUnknownDuration && (minutes(n.endTime) - minutes(n.startTime) < MIN_SUGGESTED_DURATION || minutes(n.endTime) - minutes(n.startTime) > MAX_SUGGESTED_DURATION))
      ? [
          {
            code: "locked_event" as const,
            eventId: old.id,
            message: `请保留锁定安排 ${old.name} 的 ${old.startTime}–${old.endTime} 时间和地点身份。`,
          },
        ]
      : [];
  });
}
