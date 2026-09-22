import { AssistRequestSchema, runAgentAssist } from "@/agents/agent-orchestrator";
import { WorldServiceError } from "@/services/world/amap-client";

export const maxDuration = 35;

function isModelUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /connection error|fetch failed|network|timed out|timeout|econn|enotfound|socket/i.test(message);
}

export async function POST(request: Request) {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(new Error("ASSIST_DEADLINE_EXCEEDED")), 30000);
  try {
    const raw = await request.text();
    if (raw.length > 80000) return Response.json({ error: "请求内容过大。" }, { status: 413 });
    const input = AssistRequestSchema.parse(JSON.parse(raw));
    const result = await runAgentAssist(input, deadline.signal);
    return Response.json(result, { status: result.status === "UPSTREAM_UNAVAILABLE" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (deadline.signal.aborted) return Response.json({ status: "UPSTREAM_UNAVAILABLE", failedStage: "PLANNER", retryable: true, error: "本次处理已达到 30 秒上限，原行程没有改变。你可以稍后重试。" }, { status: 503 });
    if (error instanceof WorldServiceError) return Response.json({ status: "UPSTREAM_UNAVAILABLE", failedStage: "GROUNDING", retryable: true, error: error.message }, { status: 503 });
    if (error instanceof SyntaxError) return Response.json({ error: "请求无效。" }, { status: 400 });
    if (error instanceof Error && error.message === "MODEL_NOT_CONFIGURED") {
      return Response.json({ status: "UPSTREAM_UNAVAILABLE", failedStage: "PARSER", retryable: true, code: "MODEL_NOT_CONFIGURED", error: "AI 解析未启用，请配置服务端 DEEPSEEK_API_KEY。" }, { status: 503 });
    }
    if (isModelUnavailable(error)) {
      return Response.json({ status: "UPSTREAM_UNAVAILABLE", failedStage: "PARSER", retryable: true, code: "MODEL_UPSTREAM_UNAVAILABLE", error: "AI 服务暂时无法连接，请稍后重试。" }, { status: 503 });
    }
    return Response.json({ error: error instanceof Error ? error.message : "暂时无法接住这次变化，请稍后重试。" }, { status: 400 });
  } finally {
    clearTimeout(timeout);
  }
}
