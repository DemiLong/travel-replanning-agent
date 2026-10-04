"use client";

import { z, ZodError } from "zod";
import { authenticatedJsonFetch } from "@/services/api-client";
import {
  AgentResultSchema,
  ConditionalAdviceSchema,
  ConfirmedDraftSchema,
  ImpactAnalysisSchema,
  MissingFactSchema,
  ParsedUserInputSchema,
  RAW_INPUT_TOO_LONG_MESSAGE,
  ReplanningRequestSchema,
  ResolutionStateSchema,
  SnapshotSchema,
  isRawInputWithinLimit,
  type ConditionalAdvice,
  type ImpactAnalysis,
  type MissingFact,
  type ParsedUserInput,
  type ReplanningRequest,
  type ResolutionState,
  type Snapshot,
} from "@/types";
import {
  RealWorldContextSchema,
  type RealWorldContext,
} from "@/types/world";
import {
  FailureEnvelopeSchema,
  type FailureInfo,
} from "@/types/failures";

export type AssistBody = {
  message?: string;
  failure?: FailureInfo;
  advice?: ConditionalAdvice;
  status?: "CONDITIONAL" | "READY" | "NEEDS_INPUT" | "OUT_OF_SCOPE" | "AUTH_REQUIRED" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "REQUEST_TIMEOUT" | "SYSTEM_ERROR" | "INVALID_REQUEST" | "NO_SAFE_PLAN";
  parsedInput?: ParsedUserInput;
  confirmedDraft?: z.infer<typeof ConfirmedDraftSchema>;
  missingFact?: MissingFact;
  resolutionState?: ResolutionState;
  ambiguities?: RealWorldContext["ambiguities"];
  result?: unknown;
  base?: unknown;
  request?: unknown;
  impactAnalysis?: ImpactAnalysis;
  world?: unknown;
};

const AssistNeedsInputSchema = z.object({
  status: z.literal("NEEDS_INPUT"),
  parsedInput: ParsedUserInputSchema,
  confirmedDraft: ConfirmedDraftSchema,
  missingFact: MissingFactSchema,
  resolutionState: ResolutionStateSchema,
  impactAnalysis: ImpactAnalysisSchema,
  ambiguities: RealWorldContextSchema.shape.ambiguities.optional(),
  world: RealWorldContextSchema.optional(),
}).passthrough();

const AssistReadySchema = z.object({
  status: z.literal("READY"),
  parsedInput: ParsedUserInputSchema,
  result: AgentResultSchema,
  base: SnapshotSchema,
  request: ReplanningRequestSchema,
  impactAnalysis: ImpactAnalysisSchema.optional(),
  resolutionState: ResolutionStateSchema.optional(),
}).passthrough();

const AssistTerminalSchema = z.object({
  status: z.enum(["OUT_OF_SCOPE", "NO_SAFE_PLAN", "CONDITIONAL"]),
  message: z.string().min(1),
  parsedInput: ParsedUserInputSchema.optional(),
  impactAnalysis: ImpactAnalysisSchema.optional(),
  resolutionState: ResolutionStateSchema.optional(),
}).passthrough();

const AssistFailureSchema = FailureEnvelopeSchema.extend({
  parsedInput: ParsedUserInputSchema.optional(),
  impactAnalysis: ImpactAnalysisSchema.optional(),
  resolutionState: ResolutionStateSchema.optional(),
}).passthrough();

const AssistConditionalSchema = z.object({
  status: z.literal("CONDITIONAL"),
  message: z.string().min(1),
  advice: ConditionalAdviceSchema,
  parsedInput: ParsedUserInputSchema,
  resolutionState: ResolutionStateSchema,
}).passthrough();

export const errorText = (error: unknown) => {
  if (error instanceof ZodError)
    return "服务暂时返回异常，你的输入已保留，请稍后重试。";
  if (error instanceof TypeError)
    return "服务暂时无法连接，你的输入已保留，请稍后重试。";
  if (!(error instanceof Error)) return "操作失败，请再试一次。";
  return error.message;
};

export async function readApiJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new Error("服务响应暂时无法读取，你的输入已保留，请稍后重试。");
  }
  if (!text.trim()) {
    throw new Error("服务暂时返回异常，你的输入已保留，请稍后重试。");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("服务暂时返回异常，你的输入已保留，请稍后重试。");
  }
}

export function parseAssistBody(
  value: unknown,
  responseOk: boolean,
): AssistBody {
  const objectValue = z.object({}).passthrough().parse(value);
  if (objectValue.status === "NEEDS_INPUT")
    return AssistNeedsInputSchema.parse(objectValue);
  if (objectValue.status === "READY")
    return AssistReadySchema.parse(objectValue);
  if (objectValue.status === "CONDITIONAL")
    return AssistConditionalSchema.parse(objectValue);
  if (["OUT_OF_SCOPE", "NO_SAFE_PLAN"].includes(String(objectValue.status)))
    return AssistTerminalSchema.parse(objectValue);
  if (["AUTH_REQUIRED", "RATE_LIMITED", "INVALID_REQUEST", "UPSTREAM_UNAVAILABLE", "REQUEST_TIMEOUT", "SYSTEM_ERROR"].includes(String(objectValue.status)))
    return AssistFailureSchema.parse(objectValue);
  if (!responseOk) return FailureEnvelopeSchema.parse(objectValue);
  throw new ZodError([
    {
      code: "custom",
      path: ["status"],
      message: "Unknown assist response status",
    },
  ]);
}

export async function readAssistResponse(response: Response) {
  return parseAssistBody(await readApiJson(response), response.ok);
}

export const userFacingPlanningMessage = (message: string) =>
  message
    .replaceAll("目前没有找到满足全部硬约束的方案。", "基于当前的安排，暂时无法组合出可行方案。")
    .replaceAll("当前安排之间暂时没有可执行的组合。", "基于当前的安排，暂时无法组合出可行方案。")
    .replaceAll("活动时长缺失或无效。", "这项安排没有足够的可执行停留时间。")
    .replaceAll("未知停留时长只能使用10–180分钟的方案建议，不能伪装成用户事实。", "这项活动的建议停留时间需要重新安排。")
    .replaceAll("活动时长", "停留安排")
    .replaceAll("硬约束", "固定安排")
    .replaceAll("Schema", "行程信息");

export async function parseWithModel(
  snapshot: Snapshot,
  rawText: string,
  hint?: ReplanningRequest["reason"],
) {
  if (!isRawInputWithinLimit(rawText))
    throw new Error(RAW_INPUT_TOO_LONG_MESSAGE);
  const response = await authenticatedJsonFetch("/api/parse", {
    json: { snapshot, rawText, hint },
  });
  const rawBody = await readApiJson(response);
  if (response.ok) return ParsedUserInputSchema.parse(rawBody);
  const body = FailureEnvelopeSchema.parse(rawBody);
  if (body.failure.code === "MODEL_NOT_CONFIGURED") {
    throw new Error("AI 解析未启用，请先配置服务端 DEEPSEEK_API_KEY。");
  }
  throw new Error(body.message);
}
