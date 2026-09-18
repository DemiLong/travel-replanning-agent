import { ReplanInputSchema } from "@/types";
import { replan } from "@/agents/replanning-agent";
import { DemoPlanner } from "@/agents/demo-planner";
import { replanReal } from "@/agents/real-replanning-agent";
import { WorldServiceError } from "@/services/world/amap-client";
import { validateRealInput } from "@/services/world/world-context-service";
export const maxDuration = 90;
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 80000)
      return Response.json({ error: "请求内容过大。" }, { status: 413 });
    const raw = await request.text();
    if (raw.length > 80000)
      return Response.json({ error: "请求内容过大。" }, { status: 413 });
    const parsed = ReplanInputSchema.safeParse(JSON.parse(raw));
    if (!parsed.success)
      return Response.json(
        {
          error: "部分行程信息缺失或无效，请检查时间、日期和预算。",
        },
        { status: 400 },
      );
    const { mode } = parsed.data;
    if (mode !== "demo") {
      validateRealInput(parsed.data);
      const result=await replanReal(parsed.data);
      return Response.json(result,{status:"error" in result?422:200,headers:{"Cache-Control":"no-store"}});
    }
    if(parsed.data.snapshot.mode!=="demo")return Response.json({error:"真实行程不能使用示例规划器。"},{status:400});
    const result = await replan(parsed.data, new DemoPlanner(), mode);
    return Response.json(result);
  } catch (error) {
    if(error instanceof Error && error.message==="MODEL_NOT_CONFIGURED")return Response.json({error:"AI 规划未启用，请配置 DEEPSEEK_API_KEY。"},{status:503});
    if(error instanceof WorldServiceError)return Response.json({error:error.message,status:"unavailable"},{status:503});
    return Response.json(
      {
        error:
          error instanceof SyntaxError
            ? "请求无效。"
            : error instanceof Error
              ? error.message
              : "暂时无法重新规划，请检查行程信息后再试。",
      },
      { status: 400 },
    );
  }
}
