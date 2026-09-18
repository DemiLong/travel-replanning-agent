import { z } from "zod";
import { OpenAISemanticParser } from "@/services/semantic-parser";
import { SnapshotSchema, reasons } from "@/types";

export const maxDuration = 70;

const ParseRequestSchema = z.object({
  snapshot: SnapshotSchema,
  rawText: z.string().trim().min(1).max(4000),
  hint: z.enum(reasons).optional(),
});

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 50000) {
      return Response.json({ error: "请求内容过大。" }, { status: 413 });
    }
    const raw = await request.text();
    if (raw.length > 50000) return Response.json({ error: "请求内容过大。" }, { status: 413 });
    let decoded:unknown;
    try{decoded=JSON.parse(raw);}catch{return Response.json({error:"请求无效。"},{status:400});}
    const input = ParseRequestSchema.safeParse(decoded);
    if (!input.success) return Response.json({ error: "请提供有效的行程文字和当前行程。" }, { status: 400 });
    if(input.data.snapshot.mode!=="user")return Response.json({error:"示例数据不能进入真实解析。"},{status:400});
    const parser = new OpenAISemanticParser();
    const parsed = await parser.parse(input.data.snapshot, input.data.rawText, input.data.hint);
    return Response.json(parsed, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Only log an allowlist of diagnostic metadata, never SDK error objects or request headers.
    const diagnostic=error as {name?:string;status?:number;code?:string};
    console.error("DeepSeek parser failed",{name:diagnostic.name,status:diagnostic.status,code:diagnostic.code});
    if (error instanceof Error && error.message === "MODEL_NOT_CONFIGURED") {
      return Response.json(
        { code: "MODEL_NOT_CONFIGURED", error: "AI 语义解析尚未配置服务端密钥。" },
        { status: 503 },
      );
    }
    const connectionMessage = error instanceof Error ? `${error.message} ${(error as Error & { cause?: unknown }).cause instanceof Error ? (error as Error & { cause: Error }).cause.message : ""}` : "";
    if (/connection error|fetch failed|network/i.test(connectionMessage)) {
      return Response.json(
        { code: "MODEL_UPSTREAM_UNAVAILABLE", error: "AI 服务暂时无法连接，请稍后重试。" },
        { status: 503 },
      );
    }
    return Response.json(
      { code: "MODEL_PARSE_FAILED", error: "AI 没有返回可确认的结构化事实，请保留原文后重试。" },
      { status: 502 },
    );
  }
}
