import { ReplanInputSchema, ProposedPlanSchema } from "@/types";
import { buildContext } from "@/agents/context-builder";
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
    if(parsed.mode==="demo"&&parsed.snapshot.mode!=="demo")return Response.json({ok:false,error:"真实行程不能使用示例校验。"},{status:400});
    const world=parsed.mode!=="demo"?await new WorldContextService().ground(parsed):null;
    if(world&&world.status!=="ready")return Response.json({ok:false,error:"真实数据尚未就绪，不能接受方案。",world},{status:422});
    const context = world ? buildRealContext(parsed,world) : buildContext(parsed);
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
