import assert from "node:assert/strict";
import { createAuthenticatedJsonFetch } from "../services/api-client";
import { failureEnvelope, failureResponse } from "../services/api-failure";
import {
  authorizeApiRequest,
  type AuthRateGateway,
  type ProtectedApiRoute,
} from "../services/server-auth";
import { failureHttpStatus, failureStatus, ServiceFailure } from "../services/failures";

const signal = () => new AbortController().signal;
const request = (authorization?: string) => new Request("http://example.test/api/assist", {
  method: "POST",
  headers: authorization ? { Authorization: authorization } : undefined,
});

function gateway(options: {
  userId?: string;
  claim?: { allowed: boolean; remaining: number; retry_after_seconds: number; exceeded_scope: "user" | "global" | null };
  getUser?: AuthRateGateway["getUserId"];
  claimRequest?: AuthRateGateway["claim"];
} = {}): AuthRateGateway {
  return {
    getUserId: options.getUser ?? (async () => options.userId ?? "anonymous-user"),
    claim: options.claimRequest ?? (async () => options.claim ?? ({ allowed: true, remaining: 4, retry_after_seconds: 60, exceeded_scope: null })),
  };
}

async function expectFailure(operation: Promise<unknown>, code: string) {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof ServiceFailure && error.code === code);
}

async function main() {
  const mappings = [
    ["AUTH_NOT_CONFIGURED", 503, "UPSTREAM_UNAVAILABLE"],
    ["AUTH_REQUIRED", 401, "AUTH_REQUIRED"],
    ["AUTH_INVALID", 401, "AUTH_REQUIRED"],
    ["AUTH_TIMEOUT", 504, "UPSTREAM_UNAVAILABLE"],
    ["AUTH_PROVIDER_ERROR", 503, "UPSTREAM_UNAVAILABLE"],
    ["RATE_LIMITED", 429, "RATE_LIMITED"],
    ["RATE_LIMITER_TIMEOUT", 504, "UPSTREAM_UNAVAILABLE"],
    ["RATE_LIMITER_ERROR", 503, "UPSTREAM_UNAVAILABLE"],
  ] as const;
  for (const [code, httpStatus, status] of mappings) {
    assert.equal(failureHttpStatus(code), httpStatus);
    assert.equal(failureStatus(code), status);
  }

  await expectFailure(
    authorizeApiRequest(request(), "assist", signal(), { configured: false, localBypass: false }),
    "AUTH_NOT_CONFIGURED",
  );

  let gatewayCalls = 0;
  const untouchedGateway = gateway({
    getUser: async () => { gatewayCalls += 1; return "unexpected"; },
  });
  await expectFailure(
    authorizeApiRequest(request(), "assist", signal(), { configured: true, localBypass: false, gateway: untouchedGateway }),
    "AUTH_REQUIRED",
  );
  assert.equal(gatewayCalls, 0, "missing bearer token must fail before the provider is called");

  for (const code of ["AUTH_INVALID", "AUTH_PROVIDER_ERROR"] as const) {
    await expectFailure(
      authorizeApiRequest(request("Bearer token"), "assist", signal(), {
        configured: true,
        localBypass: false,
        gateway: gateway({ getUser: async () => { throw new ServiceFailure(code, "AUTH", { retryable: true, provider: "supabase" }); } }),
      }),
      code,
    );
  }

  await expectFailure(
    authorizeApiRequest(request("Bearer token"), "assist", signal(), {
      configured: true,
      localBypass: false,
      operationTimeoutMs: 5,
      gateway: gateway({
        getUser: async (_token, operationSignal) => new Promise((_resolve, reject) => {
          operationSignal.addEventListener("abort", () => reject(operationSignal.reason), { once: true });
        }),
      }),
    }),
    "AUTH_TIMEOUT",
  );

  await expectFailure(
    authorizeApiRequest(request("Bearer token"), "assist", signal(), {
      configured: true,
      localBypass: false,
      operationTimeoutMs: 5,
      gateway: gateway({
        claimRequest: async (_token, _route, operationSignal) => new Promise((_resolve, reject) => {
          operationSignal.addEventListener("abort", () => reject(operationSignal.reason), { once: true });
        }),
      }),
    }),
    "RATE_LIMITER_TIMEOUT",
  );

  let claimedRoute: ProtectedApiRoute | null = null;
  let claimCount = 0;
  const authorized = await authorizeApiRequest(request("Bearer token"), "assist", signal(), {
    configured: true,
    localBypass: false,
    gateway: gateway({
      claimRequest: async (_token, route) => {
        claimCount += 1;
        claimedRoute = route;
        return { allowed: true, remaining: 3, retry_after_seconds: 42, exceeded_scope: null };
      },
    }),
  });
  assert.equal(authorized.userId, "anonymous-user");
  assert.equal(authorized.remaining, 3);
  assert.equal(claimedRoute, "assist");
  assert.equal(claimCount, 1, "one HTTP request claims exactly one route allowance");

  let limited: ServiceFailure | null = null;
  try {
    await authorizeApiRequest(request("Bearer token"), "assist", signal(), {
      configured: true,
      localBypass: false,
      gateway: gateway({ claim: { allowed: false, remaining: 0, retry_after_seconds: 17.2, exceeded_scope: "global" } }),
    });
  } catch (error) {
    if (error instanceof ServiceFailure) limited = error;
  }
  assert(limited);
  assert.equal(limited.code, "RATE_LIMITED");
  assert.equal(limited.retryAfterSeconds, 18);
  assert.equal(limited.rateLimitScope, "global");
  const envelope = failureEnvelope(limited, { traceId: "trace-rate-limit", stage: "AUTH" });
  assert.equal(envelope.body.failure.retryAfterSeconds, 18);
  assert.equal(envelope.body.message, "操作有些频繁，请在 18 秒后重试。");
  const response = failureResponse(limited, { traceId: "trace-rate-limit", stage: "AUTH" });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "18");

  const attempts: Array<{ authorization: string | null; body: string | null; signal: AbortSignal | null }> = [];
  let tokenCalls = 0;
  const authenticatedFetch = createAuthenticatedJsonFetch({
    getAccessToken: async (forceNew) => {
      tokenCalls += 1;
      return forceNew ? "replacement-token" : "old-token";
    },
    fetch: async (_input, init) => {
      attempts.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : null,
        signal: init?.signal ?? null,
      });
      return attempts.length === 1
        ? Response.json({ status: "AUTH_REQUIRED" }, { status: 401 })
        : Response.json({ ok: true });
    },
  });
  const controller = new AbortController();
  const retried = await authenticatedFetch("/api/assist", { json: { value: 7 }, signal: controller.signal });
  assert.equal(retried.status, 200);
  assert.equal(tokenCalls, 2);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((item) => item.authorization), ["Bearer old-token", "Bearer replacement-token"]);
  assert.deepEqual(attempts.map((item) => item.body), ['{"value":7}', '{"value":7}']);
  assert(attempts.every((item) => item.signal === controller.signal));

  let rateFetches = 0;
  const noRateRetry = createAuthenticatedJsonFetch({
    getAccessToken: async () => "token",
    fetch: async () => {
      rateFetches += 1;
      return Response.json({ status: "RATE_LIMITED" }, { status: 429 });
    },
  });
  assert.equal((await noRateRetry("/api/assist", { json: {} })).status, 429);
  assert.equal(rateFetches, 1, "429 must never be retried automatically");

  let cancelledFetches = 0;
  const cancellation = new AbortController();
  const cancelledRetry = createAuthenticatedJsonFetch({
    getAccessToken: async (forceNew) => {
      if (forceNew) cancellation.abort(new DOMException("cancelled", "AbortError"));
      return forceNew ? "replacement" : "old";
    },
    fetch: async () => {
      cancelledFetches += 1;
      return Response.json({}, { status: 401 });
    },
  });
  await assert.rejects(
    cancelledRetry("/api/assist", { json: { stable: true }, signal: cancellation.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(cancelledFetches, 1, "cancellation must prevent the second fetch");

  console.log("Authentication and rate-limit tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
