import { ReplanInputSchema, ProposedPlanSchema } from "@/types";
import { validatePlan } from "@/validators";
import { WorldContextService } from "@/services/world/world-context-service";
import { buildRealContext } from "@/agents/real-context-builder";
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 100000)
      return Response.json({ ok: false }, { status: 413 });
    const input = JSON.parse(raw);
    const parsed=ReplanInputSchema.parse(input);
    if(parsed.mode!=="live"||parsed.snapshot.mode!=="user")return Response.json({ok:false,error:"只接受正式行程的实时复验。"},{status:400});
    const world=await new WorldContextService().ground(parsed);
    if(world.status!=="ready")return Response.json({ok:false,error:"真实数据尚未就绪，不能接受方案。",world},{status:422});
    const context = buildRealContext(parsed,world);
    const violations = validatePlan(
      context,
      ProposedPlanSchema.parse(input.plan),
    );
    return Response.json({ ok: !violations.length, violations });
  } catch {
    return Response.json(
      { ok: false, error: "行程信息无效或缺失。" },
      { status: 400 },
    );
  }
}
