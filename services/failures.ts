import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "openai";
import { ZodError } from "zod";
import type { FailureCode, FailureInfo, FailureStage, FailureStatus } from "../types/failures";
export type { FailureStatus } from "../types/failures";

export class ServiceFailure extends Error {
  readonly code: FailureCode;
  readonly stage: FailureStage;
  readonly retryable: boolean;
  readonly provider?: "deepseek" | "amap" | "supabase";
  readonly attempt?: number;
  readonly detail?: string;
  readonly retryAfterSeconds?: number;
  readonly rateLimitScope?: "user" | "global";

  constructor(
    code: FailureCode,
    stage: FailureStage,
    options: {
      retryable: boolean;
      provider?: "deepseek" | "amap" | "supabase";
      attempt?: number;
      detail?: string;
      retryAfterSeconds?: number;
      rateLimitScope?: "user" | "global";
      cause?: unknown;
    },
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ServiceFailure";
    this.code = code;
    this.stage = stage;
    this.retryable = options.retryable;
    this.provider = options.provider;
    this.attempt = options.attempt;
    this.detail = options.detail;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.rateLimitScope = options.rateLimitScope;
  }
}

export function requestCancelled(stage: FailureStage, cause?: unknown) {
  return new ServiceFailure("REQUEST_CANCELLED", stage, {
    retryable: false,
    cause,
  });
}

export function requestDeadlineExceeded(stage: FailureStage = "REQUEST", cause?: unknown) {
  return new ServiceFailure("REQUEST_DEADLINE_EXCEEDED", stage, {
    retryable: true,
    cause,
  });
}

export function modelInvalidOutput(stage: "PARSER" | "PLANNER", attempt?: number, cause?: unknown) {
  return new ServiceFailure("MODEL_INVALID_OUTPUT", stage, {
    retryable: true,
    provider: "deepseek",
    attempt,
    cause,
  });
}

export function normalizeModelFailure(
  error: unknown,
  stage: "PARSER" | "PLANNER",
  options: { externalSignal?: AbortSignal; providerTimedOut?: boolean } = {},
): ServiceFailure {
  if (error instanceof ServiceFailure) return error;
  if (options.externalSignal?.aborted) {
    return options.externalSignal.reason instanceof ServiceFailure
      ? options.externalSignal.reason
      : requestCancelled(stage, error);
  }
  if (options.providerTimedOut) {
    return new ServiceFailure("MODEL_TIMEOUT", stage, {
      retryable: true,
      provider: "deepseek",
      cause: error,
    });
  }
  if (error instanceof APIUserAbortError) return requestCancelled(stage, error);
  if (error instanceof APIConnectionTimeoutError) {
    return new ServiceFailure("MODEL_TIMEOUT", stage, {
      retryable: true,
      provider: "deepseek",
      cause: error,
    });
  }
  if (error instanceof APIConnectionError) {
    return new ServiceFailure("MODEL_NETWORK_ERROR", stage, {
      retryable: true,
      provider: "deepseek",
      cause: error,
    });
  }
  if (error instanceof SyntaxError || error instanceof ZodError) {
    return modelInvalidOutput(stage, undefined, error);
  }
  return new ServiceFailure("INTERNAL_ERROR", stage, {
    retryable: true,
    cause: error,
  });
}

export function normalizeFailure(error: unknown, stage: FailureStage): ServiceFailure {
  if (error instanceof ServiceFailure) return error;
  if (error instanceof SyntaxError || error instanceof ZodError) {
    return new ServiceFailure("INVALID_REQUEST", stage, {
      retryable: false,
      cause: error,
    });
  }
  return new ServiceFailure("INTERNAL_ERROR", stage, {
    retryable: true,
    cause: error,
  });
}

export function failureHttpStatus(code: FailureCode) {
  switch (code) {
    case "AUTH_REQUIRED":
    case "AUTH_INVALID": return 401;
    case "RATE_LIMITED": return 429;
    case "REQUEST_CANCELLED": return 499;
    case "INVALID_REQUEST": return 400;
    case "MODEL_INVALID_OUTPUT":
    case "MAP_INVALID_RESPONSE":
    case "MAP_HTTP_ERROR":
    case "MAP_PROVIDER_ERROR": return 502;
    case "MODEL_NOT_CONFIGURED":
    case "MODEL_NETWORK_ERROR":
    case "MAP_NOT_CONFIGURED":
    case "MAP_NETWORK_ERROR":
    case "AUTH_NOT_CONFIGURED":
    case "AUTH_PROVIDER_ERROR":
    case "RATE_LIMITER_ERROR": return 503;
    case "REQUEST_DEADLINE_EXCEEDED":
    case "MODEL_TIMEOUT":
    case "MAP_TIMEOUT":
    case "AUTH_TIMEOUT":
    case "RATE_LIMITER_TIMEOUT": return 504;
    case "INTERNAL_ERROR": return 500;
  }
}

export function failureStatus(code: FailureCode): FailureStatus {
  if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") return "AUTH_REQUIRED";
  if (code === "RATE_LIMITED") return "RATE_LIMITED";
  if (code === "INVALID_REQUEST") return "INVALID_REQUEST";
  if (code === "REQUEST_DEADLINE_EXCEEDED") return "REQUEST_TIMEOUT";
  if (code === "INTERNAL_ERROR") return "SYSTEM_ERROR";
  return "UPSTREAM_UNAVAILABLE";
}

export function failureMessage(code: FailureCode) {
  switch (code) {
    case "AUTH_NOT_CONFIGURED":
      return "身份服务尚未配置，请联系维护者。";
    case "AUTH_REQUIRED":
    case "AUTH_INVALID":
      return "会话验证失败，请刷新后重试。";
    case "AUTH_TIMEOUT":
    case "AUTH_PROVIDER_ERROR":
      return "会话服务暂时不可用，请稍后重试。";
    case "RATE_LIMITED":
      return "操作有些频繁，请稍后重试。";
    case "RATE_LIMITER_TIMEOUT":
    case "RATE_LIMITER_ERROR":
      return "请求保护服务暂时不可用，请稍后重试。";
    case "REQUEST_DEADLINE_EXCEEDED":
    case "MODEL_TIMEOUT":
    case "MAP_TIMEOUT":
      return "本次处理时间较长，请重试。";
    case "MODEL_INVALID_OUTPUT":
    case "MAP_INVALID_RESPONSE":
      return "服务暂时未能生成有效结果，请重试。";
    case "MODEL_NOT_CONFIGURED":
      return "AI 服务尚未配置，请联系维护者。";
    case "MAP_NOT_CONFIGURED":
      return "地点与路线服务尚未配置，请联系维护者。";
    case "MODEL_NETWORK_ERROR":
      return "AI 服务暂时无法连接，请重试。";
    case "MAP_NETWORK_ERROR":
    case "MAP_HTTP_ERROR":
    case "MAP_PROVIDER_ERROR":
      return "地点与路线服务暂时不可用，请重试。";
    case "INVALID_REQUEST":
      return "请求内容无效，请检查后重试。";
    case "INTERNAL_ERROR":
      return "服务暂时出现异常，请重试。";
    case "REQUEST_CANCELLED":
      return "请求已取消。";
  }
}

export function failureInfo(failure: ServiceFailure, traceId: string): FailureInfo {
  return {
    code: failure.code,
    stage: failure.stage,
    retryable: failure.retryable,
    traceId,
    ...(failure.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: failure.retryAfterSeconds }),
  };
}
