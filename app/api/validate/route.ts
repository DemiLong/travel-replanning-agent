import { ReplanInputSchema, ProposedPlanSchema } from "@/types";
import { buildContext } from "@/agents/context-builder";
import { validatePlan } from "@/validators";
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 100000)
      return Response.json({ ok: false }, { status: 413 });
    const input = JSON.parse(raw);
    const context = buildContext(ReplanInputSchema.parse(input));
    const violations = validatePlan(
      context,
      ProposedPlanSchema.parse(input.plan),
    );
    return Response.json({ ok: !violations.length, violations });
  } catch {
    return Response.json(
      { ok: false, error: "Invalid or missing trip details." },
      { status: 400 },
    );
  }
}
