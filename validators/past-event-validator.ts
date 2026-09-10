import type { AgentContext, ProposedPlan, Violation } from "../types";
export function pastEventValidator(
  c: AgentContext,
  p: ProposedPlan,
): Violation[] {
  return p.events.flatMap((e) =>
    e.startTime < c.state.currentTime
      ? [
          {
            code: "past_event" as const,
            eventId: e.id,
            message: `${e.name} starts before current time ${c.state.currentTime}.`,
          },
        ]
      : [],
  );
}
