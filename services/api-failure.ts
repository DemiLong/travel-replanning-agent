import type { FailureStage } from "../types/failures";
import {
  failureHttpStatus,
  failureInfo,
  failureMessage,
  failureStatus,
  normalizeFailure,
  type ServiceFailure,
} from "./failures";

export type FailureEnvelope = {
  status: ReturnType<typeof failureStatus>;
  message: string;
  failure: ReturnType<typeof failureInfo>;
};

export function failureEnvelope(
  error: unknown,
  options: { traceId: string; stage: FailureStage; message?: string },
): { body: FailureEnvelope; failure: ServiceFailure; httpStatus: number } {
  const failure = normalizeFailure(error, options.stage);
  return {
    body: {
      status: failureStatus(failure.code),
      message: options.message ?? (failure.code === "RATE_LIMITED" && failure.retryAfterSeconds
        ? `操作有些频繁，请在 ${failure.retryAfterSeconds} 秒后重试。`
        : failureMessage(failure.code)),
      failure: failureInfo(failure, options.traceId),
    },
    failure,
    httpStatus: failureHttpStatus(failure.code),
  };
}

export function failureResponse(
  error: unknown,
  options: {
    traceId: string;
    stage: FailureStage;
    message?: string;
  },
) {
  const mapped = failureEnvelope(error, options);
  const headers = {
    "Cache-Control": "no-store",
    "X-Trace-Id": options.traceId,
    ...(mapped.failure.retryAfterSeconds === undefined
      ? {}
      : { "Retry-After": String(mapped.failure.retryAfterSeconds) }),
  };
  if (mapped.failure.code === "REQUEST_CANCELLED") {
    return new Response(null, { status: 499, headers });
  }
  return Response.json(mapped.body, { status: mapped.httpStatus, headers });
}
