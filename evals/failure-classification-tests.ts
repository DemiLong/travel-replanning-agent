import assert from "node:assert/strict";
import { runAgentAssist } from "../agents/agent-orchestrator";
import { MAX_REPLAN_ATTEMPTS, replanReal } from "../agents/real-replanning-agent";
import { createStarterSnapshot } from "../data/session-defaults";
import type { CandidatePlanner } from "../services/deepseek-planner";
import { failureEnvelope } from "../services/api-failure";
import { RequestExecution } from "../services/request-execution";
import {
  failureHttpStatus,
  modelInvalidOutput,
  requestCancelled,
  requestDeadlineExceeded,
  ServiceFailure,
} from "../services/failures";
import {
  EventSchema,
  ParsedUserInputSchema,
  ReplanningRequestSchema,
  SnapshotSchema,
  type ParsedUserInput,
  type Snapshot,
} from "../types";
import { RealWorldContextSchema, type RealWorldContext } from "../types/world";
import { amapGet, clearWorldCache, WorldServiceError } from "../services/world/amap-client";

function snapshot(): Snapshot {
  const base = createStarterSnapshot();
  return SnapshotSchema.parse({
    ...base,
    trip: { ...base.trip, destination: "上海" },
    state: {
      ...base.state,
      currentTime: "09:00",
      currentLocation: "人民广场",
      stateCapturedAt: new Date().toISOString(),
    },
    stateSources: {
      ...base.stateSources,
      currentTime: "user",
      currentLocation: "user",
      disruption: "user",
    },
    itinerary: [EventSchema.parse({
      id: "museum",
      placeId: "museum-poi",
      name: "城市博物馆",
      category: "user activity",
      startTime: "10:00",
      endTime: "11:00",
      durationSource: "user",
      location: "城市博物馆",
      status: "locked",
      locked: true,
      indoorOutdoor: "mixed",
      openingTime: null,
      closingTime: null,
      travelTimeFromPrevious: null,
      reason: "用户确认的固定安排。",
      constraint: "固定预约",
    })],
    revision: 7,
  });
}

function parsed(base: Snapshot): ParsedUserInput {
  return ParsedUserInputSchema.parse({
    rawText: "下雨了，把今天的行程调整一下",
    intent: "rescue",
    existingPlans: [],
    activityMentions: [],
    disruptions: [{ kind: "weather", label: "下雨", source: "user" }],
    constraints: [],
    context: base.state,
    contextSources: base.stateSources,
    closedPlaceIds: [],
    missingFacts: [],
    status: "confirmed",
    parser: "manual",
    parserModel: null,
    parseWarnings: [],
    worldOptions: { selectedPois: {}, travelMode: "TRANSIT", allowedTravelModes: ["TRANSIT"] },
  });
}

function world(base: Snapshot): RealWorldContext {
  const current = { id: "current", city: "上海市", longitude: 121.47, latitude: 31.23, coordinateSystem: "GCJ02" as const, source: "user" as const, capturedAt: new Date().toISOString(), adcode: "310101" };
  const destination = { poiId: "museum-poi", name: "城市博物馆", address: "城市博物馆", city: "上海市", district: "黄浦区", adcode: "310101", longitude: 121.49, latitude: 31.23, coordinateSystem: "GCJ02" as const, type: "科教文化服务", source: "amap" as const, fetchedAt: new Date().toISOString(), status: "available" as const };
  return RealWorldContextSchema.parse({
    currentTime: { value: "09:00", date: base.state.currentDate, source: "user", confirmedAt: new Date().toISOString() },
    currentLocation: current,
    resolvedPlaces: [{ placeId: "museum-poi", poi: destination }],
    alternatives: [],
    routes: [{ origin: current, destination: { ...destination, id: "museum-poi" }, travelMode: "TRANSIT", distanceMeters: 2500, durationSeconds: 900, source: "amap", fetchedAt: new Date().toISOString(), status: "available" }],
    weather: { condition: null, temperature: null, humidity: null, windDirection: null, windPower: null, forecast: [], source: "amap", fetchedAt: new Date().toISOString(), reportedAt: null, status: "not_requested" },
    dataFreshness: { groundedAt: new Date().toISOString(), routeMaxAgeSeconds: 120, locationMaxAgeSeconds: 600 },
    missingWorldFacts: [],
    ambiguities: [],
    candidatePlaceIds: {},
    travelMode: "TRANSIT",
    cityResolution: { city: "上海市", source: "current_location", evidence: [], conflicts: [] },
    resolutionEvidence: [],
    status: "ready",
  });
}

function input(base: Snapshot) {
  return {
    snapshot: base,
    request: ReplanningRequestSchema.parse({
      reason: "weather",
      freeText: "下雨了",
      currentState: base.state,
      closedPlaceIds: [],
      variation: 0,
      stateSources: base.stateSources,
      worldOptions: { selectedPois: {}, travelMode: "TRANSIT", allowedTravelModes: ["TRANSIT"] },
    }),
    mode: "live" as const,
    confirmation: { status: "confirmed" as const, confirmedAt: new Date().toISOString() },
  };
}

async function main() {
  assert.equal(failureHttpStatus(new ServiceFailure("MODEL_NETWORK_ERROR", "PLANNER", { retryable: true }).code), 503);
  assert.equal(failureHttpStatus(new ServiceFailure("MODEL_TIMEOUT", "PLANNER", { retryable: true }).code), 504);
  assert.equal(failureHttpStatus(new ServiceFailure("MODEL_INVALID_OUTPUT", "PLANNER", { retryable: true }).code), 502);
  assert.equal(failureHttpStatus(new ServiceFailure("MAP_NETWORK_ERROR", "GROUNDING", { retryable: true }).code), 503);
  assert.equal(failureHttpStatus(new ServiceFailure("MAP_TIMEOUT", "GROUNDING", { retryable: true }).code), 504);
  assert.equal(failureHttpStatus(new ServiceFailure("MAP_HTTP_ERROR", "GROUNDING", { retryable: true }).code), 502);
  assert.equal(failureHttpStatus(new ServiceFailure("MAP_INVALID_RESPONSE", "GROUNDING", { retryable: true }).code), 502);
  assert.equal(failureHttpStatus(new ServiceFailure("INTERNAL_ERROR", "REQUEST", { retryable: true }).code), 500);
  assert.equal(failureHttpStatus(requestCancelled("REQUEST").code), 499);

  const traced = failureEnvelope(new ServiceFailure("MAP_NETWORK_ERROR", "GROUNDING", { retryable: true, provider: "amap" }), {
    traceId: "trace-map-network",
    stage: "GROUNDING",
  });
  assert.equal(traced.httpStatus, 503);
  assert.equal(traced.body.failure.code, "MAP_NETWORK_ERROR");
  assert.equal(traced.body.failure.stage, "GROUNDING");
  assert.equal(traced.body.failure.traceId, "trace-map-network");

  const deadline = failureEnvelope(requestDeadlineExceeded(), { traceId: "trace-deadline", stage: "REQUEST" });
  assert.equal(deadline.httpStatus, 504);
  assert.equal(deadline.body.status, "REQUEST_TIMEOUT");
  assert.equal(deadline.body.message, "本次处理时间较长，请重试。");

  const originalFetch = globalThis.fetch;
  const originalAmapKey = process.env.AMAP_API_KEY;
  process.env.AMAP_API_KEY = "test-amap-key";
  try {
    const cases: Array<{ path: string; fetch: typeof fetch; code: string }> = [
      { path: "/network", fetch: async () => { throw new TypeError("offline"); }, code: "MAP_NETWORK_ERROR" },
      { path: "/http", fetch: async () => new Response("", { status: 503 }), code: "MAP_HTTP_ERROR" },
      { path: "/invalid", fetch: async () => new Response("not-json", { status: 200 }), code: "MAP_INVALID_RESPONSE" },
      { path: "/provider", fetch: async () => Response.json({ status: "0", infocode: "10001" }), code: "MAP_PROVIDER_ERROR" },
    ];
    for (const testCase of cases) {
      clearWorldCache();
      globalThis.fetch = testCase.fetch;
      await assert.rejects(
        amapGet(testCase.path, { query: testCase.path }, 1, { paced: false }),
        (error: unknown) => error instanceof WorldServiceError && error.code === testCase.code,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAmapKey === undefined) delete process.env.AMAP_API_KEY;
    else process.env.AMAP_API_KEY = originalAmapKey;
    clearWorldCache();
  }

  const base = snapshot();
  const modelTimeout = await runAgentAssist(
    { snapshot: base, rawText: "下雨了，把今天的行程调整一下" },
    new RequestExecution({ traceId: "trace-model-timeout", deadlineMs: null }),
    {
      parse: async () => parsed(base),
      ground: async () => world(base),
      replan: async () => { throw new ServiceFailure("MODEL_TIMEOUT", "PLANNER", { retryable: true, provider: "deepseek" }); },
    },
  );
  assert.equal(modelTimeout.status, "UPSTREAM_UNAVAILABLE");
  if (!("failure" in modelTimeout)) throw new Error("expected typed failure");
  assert.equal(modelTimeout.failure.code, "MODEL_TIMEOUT");
  assert.equal(modelTimeout.failure.traceId, "trace-model-timeout");

  let invalidAttempts = 0;
  const invalidPlanner: CandidatePlanner = {
    name: "invalid-output-test",
    generateCandidates: async () => {
      invalidAttempts += 1;
      throw modelInvalidOutput("PLANNER", invalidAttempts);
    },
  };
  await assert.rejects(
    replanReal(input(base), invalidPlanner, { ground: async () => world(base) }),
    (error: unknown) => error instanceof ServiceFailure && error.code === "MODEL_INVALID_OUTPUT",
  );
  assert.equal(invalidAttempts, MAX_REPLAN_ATTEMPTS, "invalid model output retries exactly once");

  const controller = new AbortController();
  controller.abort(requestCancelled("PLANNER"));
  const cancelledPlanner: CandidatePlanner = {
    name: "cancel-test",
    generateCandidates: async () => { throw controller.signal.reason; },
  };
  await assert.rejects(
    replanReal(input(base), cancelledPlanner, { ground: async () => world(base) }, undefined, controller.signal),
    (error: unknown) => error instanceof ServiceFailure && error.code === "REQUEST_CANCELLED",
  );

  console.log("Failure classification tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
