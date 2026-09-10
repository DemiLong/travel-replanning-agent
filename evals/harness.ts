import { cases, violationCodes } from "./cases";
import { replan } from "../agents/replanning-agent";
import { validatePlan } from "../validators";
import type { Planner } from "../services/openai";
export async function runEvals(planner: Planner, mode: "demo" | "live") {
  const results = [];
  for (const c of cases) {
    const started = Date.now();
    const result = await replan(
      { snapshot: c.snapshot, request: c.disruption, mode },
      planner,
      mode,
    );
    const finalViolations = result.plan
      ? validatePlan(result.context, result.plan)
      : (result.attempts.at(-1)?.violations ?? []);
    const correct =
      result.ok === c.expected.feasible &&
      (!result.ok || finalViolations.length === 0);
    results.push({
      id: c.id,
      name: c.name,
      expectedFeasible: c.expected.feasible,
      pass: correct,
      validPlan: result.ok,
      attempts: result.attempts,
      durationMs: Date.now() - started,
      violations: finalViolations,
    });
  }
  const attempts = results.flatMap((r) => r.attempts);
  const feasible = results.filter((r) => r.expectedFeasible);
  return {
    generatedAt: new Date().toISOString(),
    mode,
    model: planner.name,
    total: results.length,
    scenarioPassRate: results.filter((r) => r.pass).length / results.length,
    hardConstraintPassRate:
      results.filter((r) => r.validPlan).length / results.length,
    feasibleCasePassRate:
      feasible.filter((r) => r.validPlan).length / feasible.length,
    attemptHardConstraintPassRate:
      attempts.filter((a) => !a.violations.length).length / attempts.length,
    averageRegenerationCount:
      results.reduce((s, r) => s + r.attempts.length - 1, 0) / results.length,
    violationRates: Object.fromEntries(
      violationCodes.map((code) => [
        code,
        attempts.filter((a) => a.violations.some((v) => v.code === code))
          .length / attempts.length,
      ]),
    ),
    results,
  };
}
