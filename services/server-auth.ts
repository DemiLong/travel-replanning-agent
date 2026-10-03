import { createClient } from "@supabase/supabase-js";
import { requestCancelled, ServiceFailure } from "./failures";

export type ProtectedApiRoute = "parse" | "assist" | "validate";

export type AuthorizationResult = {
  userId: string;
  bypassed: boolean;
  remaining: number | null;
};

type RateLimitRow = {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
  exceeded_scope: "user" | "global" | null;
};

export type AuthRateGateway = {
  getUserId(token: string, signal: AbortSignal): Promise<string>;
  claim(token: string, route: ProtectedApiRoute, signal: AbortSignal): Promise<RateLimitRow>;
};

export type AuthorizationDependencies = {
  configured?: boolean;
  localBypass?: boolean;
  gateway?: AuthRateGateway;
  operationTimeoutMs?: number;
};

const AUTH_OPERATION_TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function configuration() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "",
  };
}

function localBypassAllowed(request: Request) {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_LOCAL_LIVE !== "true") return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(request.url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function fetchWithSignal(signal: AbortSignal): typeof fetch {
  return (input, init) => {
    const requestSignal = init?.signal;
    const combined = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
    return fetch(input, { ...init, signal: combined });
  };
}

async function timedOperation<T>(
  parentSignal: AbortSignal,
  timeoutCode: "AUTH_TIMEOUT" | "RATE_LIMITER_TIMEOUT",
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = AUTH_OPERATION_TIMEOUT_MS,
) {
  if (parentSignal.aborted) {
    throw parentSignal.reason instanceof ServiceFailure
      ? parentSignal.reason
      : requestCancelled("AUTH", parentSignal.reason);
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(new ServiceFailure(timeoutCode, "AUTH", {
      retryable: true,
      provider: "supabase",
    }));
  }, timeoutMs);
  const signal = AbortSignal.any([parentSignal, timeout.signal]);
  try {
    const value = await operation(signal);
    if (parentSignal.aborted) {
      throw parentSignal.reason instanceof ServiceFailure
        ? parentSignal.reason
        : requestCancelled("AUTH", parentSignal.reason);
    }
    if (timeout.signal.aborted) throw timeout.signal.reason;
    return value;
  } catch (error) {
    if (parentSignal.aborted) {
      throw parentSignal.reason instanceof ServiceFailure
        ? parentSignal.reason
        : requestCancelled("AUTH", error);
    }
    if (timeout.signal.aborted) throw timeout.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function bearerToken(request: Request) {
  const header = request.headers.get("authorization");
  if (!header) {
    throw new ServiceFailure("AUTH_REQUIRED", "AUTH", { retryable: true });
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match) {
    throw new ServiceFailure("AUTH_INVALID", "AUTH", { retryable: true });
  }
  return match[1];
}

function rateLimitRow(data: unknown): RateLimitRow | null {
  const candidate = Array.isArray(data) ? data[0] : data;
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, unknown>;
  if (
    typeof row.allowed !== "boolean" ||
    typeof row.remaining !== "number" ||
    typeof row.retry_after_seconds !== "number" ||
    ![null, "user", "global"].includes(row.exceeded_scope as never)
  ) return null;
  return row as RateLimitRow;
}

function supabaseGateway(url: string, key: string): AuthRateGateway {
  return {
    async getUserId(token, signal) {
      const client = createClient(url, key, {
        global: { fetch: fetchWithSignal(signal) },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error } = await client.auth.getUser(token);
      if (error) {
        if ([400, 401, 403].includes(error.status ?? 0)) {
          throw new ServiceFailure("AUTH_INVALID", "AUTH", {
            retryable: true,
            provider: "supabase",
            cause: error,
          });
        }
        throw new ServiceFailure("AUTH_PROVIDER_ERROR", "AUTH", {
          retryable: true,
          provider: "supabase",
          cause: error,
        });
      }
      if (!data.user) {
        throw new ServiceFailure("AUTH_INVALID", "AUTH", {
          retryable: true,
          provider: "supabase",
        });
      }
      return data.user.id;
    },
    async claim(token, route, signal) {
      const client = createClient(url, key, {
        global: {
          headers: { Authorization: `Bearer ${token}` },
          fetch: fetchWithSignal(signal),
        },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error, status } = await client.rpc("claim_api_request", {
        requested_route: route,
      });
      if (error) {
        if ([401, 403].includes(status)) {
          throw new ServiceFailure("AUTH_INVALID", "AUTH", {
            retryable: true,
            provider: "supabase",
            cause: error,
          });
        }
        throw new ServiceFailure("RATE_LIMITER_ERROR", "AUTH", {
          retryable: true,
          provider: "supabase",
          cause: error,
        });
      }
      const parsed = rateLimitRow(data);
      if (!parsed) {
        throw new ServiceFailure("RATE_LIMITER_ERROR", "AUTH", {
          retryable: true,
          provider: "supabase",
          detail: "INVALID_RATE_LIMIT_RESPONSE",
        });
      }
      return parsed;
    },
  };
}

export async function authorizeApiRequest(
  request: Request,
  route: ProtectedApiRoute,
  signal: AbortSignal,
  dependencies: AuthorizationDependencies = {},
): Promise<AuthorizationResult> {
  if (dependencies.localBypass ?? localBypassAllowed(request)) {
    return { userId: "local-development", bypassed: true, remaining: null };
  }

  const { url, key } = configuration();
  if (!(dependencies.configured ?? Boolean(url && key))) {
    throw new ServiceFailure("AUTH_NOT_CONFIGURED", "AUTH", {
      retryable: false,
      provider: "supabase",
    });
  }

  const token = bearerToken(request);
  const gateway = dependencies.gateway ?? supabaseGateway(url, key);
  const userId = await timedOperation(signal, "AUTH_TIMEOUT", (operationSignal) =>
    gateway.getUserId(token, operationSignal), dependencies.operationTimeoutMs);

  const claim = await timedOperation(signal, "RATE_LIMITER_TIMEOUT", (operationSignal) =>
    gateway.claim(token, route, operationSignal), dependencies.operationTimeoutMs);

  if (!claim.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(claim.retry_after_seconds));
    throw new ServiceFailure("RATE_LIMITED", "AUTH", {
      retryable: true,
      provider: "supabase",
      retryAfterSeconds,
      rateLimitScope: claim.exceeded_scope ?? undefined,
    });
  }

  return {
    userId,
    bypassed: false,
    remaining: Math.max(0, Math.floor(claim.remaining)),
  };
}
