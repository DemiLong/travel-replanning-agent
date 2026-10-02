import type { AgentContext, ProposedPlan, Violation } from "../types";
import { MAX_SUGGESTED_DURATION, MIN_SUGGESTED_DURATION, minutes } from "../lib/time";
import { effectiveProtectionPolicy } from "../services/protection-policy";

export function protectionPolicyValidator(
  context: AgentContext,
  plan: ProposedPlan,
): Violation[] {
  return context.lockedEvents.flatMap((old) => {
    const next = plan.events.find((event) => event.id === old.id);
    const policy = effectiveProtectionPolicy(old);
    if (!next || !next.locked || next.status !== "locked" || !policy) {
      return [{
        code: "locked_event" as const,
        eventId: old.id,
        message: `受保护安排“${old.name}”不能被删除或解除保护。`,
      }];
    }

    const fields = new Set(policy.lockedFields);
    const violations: string[] = [];
    if (fields.has("name") && next.name !== old.name) violations.push("名称");
    if (fields.has("location") && (next.placeId !== old.placeId || next.location !== old.location)) violations.push("地点");
    if (fields.has("startTime")) {
      const allowed = policy.allowedStartTimes.length ? policy.allowedStartTimes : [old.startTime];
      if (!allowed.includes(next.startTime)) violations.push("开始时间");
    }
    if (fields.has("endTime") && next.endTime !== old.endTime) violations.push("结束时间");
    if (fields.has("duration") && minutes(next.endTime) - minutes(next.startTime) !== minutes(old.endTime) - minutes(old.startTime)) {
      violations.push("时长");
    }

    const duration = minutes(next.endTime) - minutes(next.startTime);
    if (old.durationSource === "unknown" && next.durationSource === "suggested") {
      if (policy.durationPolicy.mode !== "suggested") {
        violations.push("未经允许的建议时长");
      } else {
        const min = policy.durationPolicy.minMinutes ?? MIN_SUGGESTED_DURATION;
        const max = policy.durationPolicy.maxMinutes ?? MAX_SUGGESTED_DURATION;
        if (duration < min || duration > max) violations.push(`建议时长（应为 ${min}–${max} 分钟）`);
      }
    }

    return violations.length ? [{
      code: "locked_event" as const,
      eventId: old.id,
      message: `受保护安排“${old.name}”改动了：${[...new Set(violations)].join("、")}。`,
    }] : [];
  });
}
