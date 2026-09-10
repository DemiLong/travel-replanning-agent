import { buildContext } from "./context-builder";
import { validatePlan } from "../validators";
import { ProposedPlanSchema, type AgentResult, type Violation } from "../types";
import type { Planner } from "../services/openai";
export type AgentLogger = (
  name: string,
  properties: Record<string, unknown>,
) => Promise<void>;
export async function replan(
  input: unknown,
  planner: Planner,
  mode: "demo" | "live",
  log: AgentLogger = async () => {},
): Promise<AgentResult> {
  const context = buildContext(input),
    id = crypto.randomUUID();
  const attempts: AgentResult["attempts"] = [];
  let feedback: Violation[] = [];
  const record = async (name: string, properties: Record<string, unknown>) => {
    try {
      await log(name, { planId: id, mode, model: planner.name, ...properties });
    } catch {
      /* Analytics must not interrupt planning. */
    }
  };
  await record("replan_started", {});
  // One original attempt + at most two regenerations. No hidden SDK retries.
  for (let i = 0; i < 3; i++) {
    if (i > 0) await record("replan_regenerated", { regenerationCount: i });
    const started = Date.now();
    let candidate: unknown;
    try {
      candidate = await planner.generate(context, feedback, i);
      feedback = validatePlan(context, candidate);
    } catch {
      feedback = [
        {
          code: "schema",
          message:
            "The planning service could not produce complete, valid structured output. Try again or use Demo mode.",
        },
      ];
    }
    attempts.push({
      attempt: i + 1,
      violations: feedback,
      durationMs: Date.now() - started,
    });
    if (!feedback.length) {
      const plan = ProposedPlanSchema.parse(candidate);
      await record("replan_generated", {
        regenerationCount: i,
        attemptCount: i + 1,
      });
      return {
        id,
        ok: true,
        plan,
        attempts,
        mode,
        model: planner.name,
        message: "All hard constraints passed.",
        context,
      };
    }
    await record("replan_validation_failed", {
      attempt: i + 1,
      violations: feedback,
    });
  }
  return {
    id,
    ok: false,
    plan: null,
    attempts,
    mode,
    model: planner.name,
    message:
      "Couldn't generate a fully valid plan. Please adjust one of the constraints.",
    context,
  };
}
