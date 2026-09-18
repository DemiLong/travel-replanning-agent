import type { AgentContext, ProposedPlan, Violation } from "../types";
export function budgetValidator(c: AgentContext, p: ProposedPlan): Violation[] {
  if (c.state.remainingBudget === undefined) return [];
  const total = p.events.reduce(
    (sum, e) =>
      sum +
      Math.max(
        e.estimatedCost,
        c.places.find((p) => p.id === e.placeId)?.estimatedCost ?? 0,
      ),
    0,
  );
  return total > c.state.remainingBudget
    ? [
        {
          code: "budget",
          message: `剩余活动需要 ฿${total}，但当前只剩 ฿${c.state.remainingBudget}。`,
        },
      ]
    : [];
}
