import { z } from "zod";

export const FailureStageSchema = z.enum([
  "AUTH",
  "REQUEST",
  "PARSER",
  "GROUNDING",
  "PLANNER",
  "VALIDATOR",
]);

export const FailureCodeSchema = z.enum([
  "AUTH_NOT_CONFIGURED",
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "AUTH_TIMEOUT",
  "AUTH_PROVIDER_ERROR",
  "RATE_LIMITED",
  "RATE_LIMITER_TIMEOUT",
  "RATE_LIMITER_ERROR",
  "REQUEST_CANCELLED",
  "REQUEST_DEADLINE_EXCEEDED",
  "INVALID_REQUEST",
  "MODEL_NOT_CONFIGURED",
  "MODEL_TIMEOUT",
  "MODEL_NETWORK_ERROR",
  "MODEL_INVALID_OUTPUT",
  "MAP_NOT_CONFIGURED",
  "MAP_TIMEOUT",
  "MAP_NETWORK_ERROR",
  "MAP_HTTP_ERROR",
  "MAP_PROVIDER_ERROR",
  "MAP_INVALID_RESPONSE",
  "INTERNAL_ERROR",
]);

export const FailureInfoSchema = z.object({
  code: FailureCodeSchema,
  stage: FailureStageSchema,
  retryable: z.boolean(),
  traceId: z.string().min(1),
  retryAfterSeconds: z.number().int().min(1).optional(),
});

export const FailureStatusSchema = z.enum([
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "UPSTREAM_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "SYSTEM_ERROR",
]);

export const FailureEnvelopeSchema = z.object({
  status: FailureStatusSchema,
  message: z.string().min(1),
  failure: FailureInfoSchema,
}).passthrough();

export type FailureStage = z.infer<typeof FailureStageSchema>;
export type FailureCode = z.infer<typeof FailureCodeSchema>;
export type FailureInfo = z.infer<typeof FailureInfoSchema>;
export type FailureStatus = z.infer<typeof FailureStatusSchema>;
export type FailureEnvelope = z.infer<typeof FailureEnvelopeSchema>;
