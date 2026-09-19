import type { AgentContext, ProposedPlan, Violation } from "../types";
export function timeConflictValidator(
  _c: AgentContext,
  p: ProposedPlan,
): Violation[] {
  const sorted = [...p.events].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );
  const errors: Violation[] = [];
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++)
      if (sorted[i].endTime > sorted[j].startTime)
        errors.push({
          code: "time_conflict",
          eventId: sorted[j].id,
          message: `${sorted[i].name} 与 ${sorted[j].name} 时间重叠。`,
          ...(sorted[i].locked&&sorted[j].locked?{conflict:{kind:"locked_schedule_conflict" as const,eventId:sorted[i].id,nextAnchorEventId:sorted[j].id,message:`${sorted[i].name} 与 ${sorted[j].name} 的时间发生重叠。`}}:{}),
        });
  return errors;
}
