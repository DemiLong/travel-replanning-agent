import type { FailureStage } from "../types/failures";
import { requestCancelled, requestDeadlineExceeded, type ServiceFailure } from "./failures";

type ProviderName = "deepseek" | "amap";
type StageDurations = Record<FailureStage, number>;
type ProviderMetrics = Record<ProviderName, {
  requestCount: number;
  cacheHitCount: number;
  queueWaitMs: number;
  networkMs: number;
}>;

export type RequestOutcome = "success" | "business" | "failure" | "cancelled" | "timeout";

export function outcomeForFailure(failure: ServiceFailure): RequestOutcome {
  if (failure.code === "REQUEST_CANCELLED") return "cancelled";
  if (["REQUEST_DEADLINE_EXCEEDED", "MODEL_TIMEOUT", "MAP_TIMEOUT", "AUTH_TIMEOUT", "RATE_LIMITER_TIMEOUT"].includes(failure.code)) return "timeout";
  return "failure";
}

const blankStages = (): StageDurations => ({ AUTH: 0, REQUEST: 0, PARSER: 0, GROUNDING: 0, PLANNER: 0, VALIDATOR: 0 });
const blankProviders = (): ProviderMetrics => ({
  deepseek: { requestCount: 0, cacheHitCount: 0, queueWaitMs: 0, networkMs: 0 },
  amap: { requestCount: 0, cacheHitCount: 0, queueWaitMs: 0, networkMs: 0 },
});
const elapsed = (startedAt: number) => Math.max(0, performance.now() - startedAt);
const rounded = (value: number) => Math.round(value * 100) / 100;

export class RequestExecution {
  readonly traceId: string;
  readonly signal: AbortSignal;
  activeStage: FailureStage = "REQUEST";

  private readonly startedAt = performance.now();
  private readonly stages = blankStages();
  private readonly providers = blankProviders();
  private readonly clientSignal?: AbortSignal;
  private readonly deadline = new AbortController();
  private readonly deadlineTimer?: ReturnType<typeof setTimeout>;
  private finished = false;

  constructor(options: { traceId?: string; clientSignal?: AbortSignal; deadlineMs?: number | null } = {}) {
    this.traceId = options.traceId ?? crypto.randomUUID();
    this.clientSignal = options.clientSignal;
    if (options.deadlineMs !== undefined && options.deadlineMs !== null) {
      this.deadlineTimer = setTimeout(() => {
        this.deadline.abort(requestDeadlineExceeded(this.activeStage));
      }, options.deadlineMs);
      this.signal = options.clientSignal
        ? AbortSignal.any([options.clientSignal, this.deadline.signal])
        : this.deadline.signal;
    } else {
      this.signal = options.clientSignal ?? new AbortController().signal;
    }
  }

  throwIfAborted(stage: FailureStage = this.activeStage) {
    this.activeStage = stage;
    if (!this.signal.aborted) return;
    if (this.deadline.signal.aborted) throw this.deadline.signal.reason;
    throw this.clientSignal?.reason instanceof Error
      ? requestCancelled(stage, this.clientSignal.reason)
      : requestCancelled(stage);
  }

  failureFor(error: unknown, stage: FailureStage = this.activeStage) {
    this.activeStage = stage;
    if (this.deadline.signal.aborted) return this.deadline.signal.reason;
    if (this.clientSignal?.aborted) return requestCancelled(stage, error);
    return error;
  }

  async measure<T>(stage: FailureStage, operation: () => Promise<T>): Promise<T> {
    this.activeStage = stage;
    this.throwIfAborted(stage);
    const startedAt = performance.now();
    try {
      const value = await operation();
      this.throwIfAborted(stage);
      return value;
    } finally {
      this.stages[stage] += elapsed(startedAt);
    }
  }

  measureSync<T>(stage: FailureStage, operation: () => T): T {
    this.activeStage = stage;
    this.throwIfAborted(stage);
    const startedAt = performance.now();
    try {
      const value = operation();
      this.throwIfAborted(stage);
      return value;
    } finally {
      this.stages[stage] += elapsed(startedAt);
    }
  }

  recordProvider(provider: ProviderName, metrics: Partial<ProviderMetrics[ProviderName]>) {
    const target = this.providers[provider];
    for (const key of ["requestCount", "cacheHitCount", "queueWaitMs", "networkMs"] as const) {
      target[key] += metrics[key] ?? 0;
    }
  }

  finish(options: {
    route: string;
    outcome: RequestOutcome;
    httpStatus: number;
    status?: string;
    failure?: ServiceFailure;
  }) {
    if (this.finished) return;
    this.finished = true;
    const failure = options.failure;
    const payload = {
      event: "request_finished",
      traceId: this.traceId,
      route: options.route,
      outcome: options.outcome,
      status: options.status ?? null,
      stage: failure?.stage ?? this.activeStage,
      code: failure?.code ?? null,
      provider: failure?.provider ?? null,
      durationMs: rounded(elapsed(this.startedAt)),
      attempt: failure?.attempt ?? null,
      httpStatus: options.httpStatus,
      detail: failure?.detail ?? null,
      retryAfterSeconds: failure?.retryAfterSeconds ?? null,
      exceededScope: failure?.rateLimitScope ?? null,
      timeoutStage: failure?.code === "REQUEST_DEADLINE_EXCEEDED" ? failure.stage : null,
      stages: {
        authMs: rounded(this.stages.AUTH),
        requestMs: rounded(this.stages.REQUEST),
        parserMs: rounded(this.stages.PARSER),
        groundingMs: rounded(this.stages.GROUNDING),
        plannerMs: rounded(this.stages.PLANNER),
        validatorMs: rounded(this.stages.VALIDATOR),
      },
      providers: {
        deepseek: {
          requestCount: this.providers.deepseek.requestCount,
          networkMs: rounded(this.providers.deepseek.networkMs),
        },
        amap: {
          requestCount: this.providers.amap.requestCount,
          cacheHitCount: this.providers.amap.cacheHitCount,
          queueWaitMs: rounded(this.providers.amap.queueWaitMs),
          networkMs: rounded(this.providers.amap.networkMs),
        },
      },
    };
    const output = JSON.stringify(payload);
    if (options.outcome === "failure" || options.outcome === "timeout") console.error(output);
    else console.info(output);
  }

  dispose() {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
  }
}
