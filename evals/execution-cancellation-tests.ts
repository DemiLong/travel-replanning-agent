import assert from "node:assert/strict";
import { amapGet, clearWorldCache } from "../services/world/amap-client";
import { RequestExecution } from "../services/request-execution";
import { ServiceFailure } from "../services/failures";

const waitForAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

async function deadlineAndLogTests() {
  const execution = new RequestExecution({ traceId: "trace-grounding-deadline", deadlineMs: 20 });
  let failure: ServiceFailure | undefined;
  try {
    await execution.measure("GROUNDING", () => waitForAbort(execution.signal));
  } catch (error) {
    failure = execution.failureFor(error) as ServiceFailure;
  }
  assert.equal(failure?.code, "REQUEST_DEADLINE_EXCEEDED");
  assert.equal(failure?.stage, "GROUNDING");

  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => { messages.push(String(message)); };
  try {
    execution.finish({ route: "/api/assist", outcome: "timeout", httpStatus: 504, status: "REQUEST_TIMEOUT", failure });
    execution.finish({ route: "/api/assist", outcome: "timeout", httpStatus: 504, failure });
  } finally {
    console.error = originalError;
    execution.dispose();
  }
  assert.equal(messages.length, 1, "each request writes one terminal timing log");
  const log = JSON.parse(messages[0]) as Record<string, unknown>;
  assert.equal(log.traceId, "trace-grounding-deadline");
  assert.equal(log.timeoutStage, "GROUNDING");
  assert.equal((log.stages as Record<string, number>).groundingMs > 0, true);
  assert.equal(messages[0].includes("用户原文"), false);
}

async function sharedRequestCancellationTests() {
  const originalFetch = globalThis.fetch;
  const originalAmapKey = process.env.AMAP_API_KEY;
  process.env.AMAP_API_KEY = "test-amap-key";
  try {
    clearWorldCache();
    let resolveFetch: ((response: Response) => void) | undefined;
    let upstreamSignal: AbortSignal | undefined;
    let fetchCount = 0;
    globalThis.fetch = (async (_input, init) => {
      fetchCount += 1;
      upstreamSignal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve;
        upstreamSignal?.addEventListener("abort", () => reject(upstreamSignal?.reason), { once: true });
      });
    }) as typeof fetch;

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = amapGet("/shared", { id: "1" }, 1000, { paced: false, signal: firstController.signal });
    const second = amapGet("/shared", { id: "1" }, 1000, { paced: false, signal: secondController.signal });
    firstController.abort();
    await assert.rejects(first, (error: unknown) => error instanceof ServiceFailure && error.code === "REQUEST_CANCELLED");
    assert.equal(upstreamSignal?.aborted, false, "one consumer must not cancel another consumer's upstream request");
    resolveFetch?.(Response.json({ status: "1", pois: [] }));
    assert.equal((await second).status, "1");
    assert.equal(fetchCount, 1, "identical in-flight calls share one upstream request");

    clearWorldCache();
    let allCancelledSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input, init) => {
      allCancelledSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        allCancelledSignal?.addEventListener("abort", () => reject(allCancelledSignal?.reason), { once: true });
      });
    }) as typeof fetch;
    const leftController = new AbortController();
    const rightController = new AbortController();
    const left = amapGet("/all-cancel", { id: "2" }, 1000, { paced: false, signal: leftController.signal });
    const right = amapGet("/all-cancel", { id: "2" }, 1000, { paced: false, signal: rightController.signal });
    leftController.abort();
    rightController.abort();
    await Promise.all([
      assert.rejects(left, (error: unknown) => error instanceof ServiceFailure && error.code === "REQUEST_CANCELLED"),
      assert.rejects(right, (error: unknown) => error instanceof ServiceFailure && error.code === "REQUEST_CANCELLED"),
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(allCancelledSignal?.aborted, true, "upstream request stops after its final consumer cancels");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAmapKey === undefined) delete process.env.AMAP_API_KEY;
    else process.env.AMAP_API_KEY = originalAmapKey;
    clearWorldCache();
  }
}

async function pacingCancellationTests() {
  const originalFetch = globalThis.fetch;
  const originalAmapKey = process.env.AMAP_API_KEY;
  process.env.AMAP_API_KEY = "test-amap-key";
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return Response.json({ status: "1", pois: [] });
  }) as typeof fetch;
  try {
    clearWorldCache();
    await amapGet("/pace-first", { id: "1" }, 1);
    const controller = new AbortController();
    const startedAt = performance.now();
    const waiting = amapGet("/pace-cancelled", { id: "2" }, 1, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(waiting, (error: unknown) => error instanceof ServiceFailure && error.code === "REQUEST_CANCELLED");
    assert.equal(performance.now() - startedAt < 200, true, "queue cancellation should not wait for the pacing slot");
    await amapGet("/pace-next", { id: "3" }, 1);
    assert.equal(fetchCount, 2, "cancelled queue entry must not issue an upstream request");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAmapKey === undefined) delete process.env.AMAP_API_KEY;
    else process.env.AMAP_API_KEY = originalAmapKey;
    clearWorldCache();
  }
}

async function providerMetricsLogTests() {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalAmapKey = process.env.AMAP_API_KEY;
  process.env.AMAP_API_KEY = "test-amap-key";
  const messages: string[] = [];
  console.info = (message?: unknown) => { messages.push(String(message)); };
  globalThis.fetch = (async () => Response.json({ status: "1", pois: [] })) as typeof fetch;
  const execution = new RequestExecution({ traceId: "trace-provider-metrics", deadlineMs: null });
  try {
    clearWorldCache();
    await amapGet("/metrics", { id: "1" }, 1000, { paced: false, execution });
    await amapGet("/metrics", { id: "1" }, 1000, { paced: false, execution });
    execution.finish({ route: "/api/validate", outcome: "success", httpStatus: 200, status: "VALID" });
    const log = JSON.parse(messages[0]) as { providers: { amap: { requestCount: number; cacheHitCount: number; networkMs: number } } };
    assert.equal(log.providers.amap.requestCount, 2);
    assert.equal(log.providers.amap.cacheHitCount, 1);
    assert.equal(log.providers.amap.networkMs >= 0, true);
  } finally {
    execution.dispose();
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
    if (originalAmapKey === undefined) delete process.env.AMAP_API_KEY;
    else process.env.AMAP_API_KEY = originalAmapKey;
    clearWorldCache();
  }
}

async function main() {
  await deadlineAndLogTests();
  await sharedRequestCancellationTests();
  await pacingCancellationTests();
  await providerMetricsLogTests();
  console.log("Execution cancellation and timing tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
