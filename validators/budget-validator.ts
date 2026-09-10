import type { AgentContext, ProposedPlan, Violation } from "../types";
export function budgetValidator(c: AgentContext, p: ProposedPlan): Violation[] {
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
          message: `Remaining activities cost ฿${total}; only ฿${c.state.remainingBudget} remains.`,
        },
      ]
    : [];
}
