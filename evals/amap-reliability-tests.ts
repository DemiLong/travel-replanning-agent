import assert from "node:assert/strict";
import { createStarterSnapshot } from "../data/session-defaults";
import { materializeCandidate, CandidateOutputError, type PlanCandidate } from "../services/deepseek-planner";
import { buildRealContext } from "../agents/real-context-builder";
import { failureInfo, requestCancelled, requestDeadlineExceeded, ServiceFailure } from "../services/failures";
import { RequestExecution } from "../services/request-execution";
import { amapGet, clearWorldCache, WorldServiceError } from "../services/world/amap-client";
import { AmapPlacesService } from "../services/world/amap-places-service";
import { WorldContextService } from "../services/world/world-context-service";
import { travelTimeValidator } from "../validators/travel-time-validator";
import { ActivityFactSchema, ReplanInputSchema } from "../types";

const originalFetch = globalThis.fetch;
const originalKey = process.env.AMAP_API_KEY;
const originalInterval = process.env.AMAP_REQUEST_INTERVAL_MS;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code: string) => Response.json({ status: "0", infocode: code });
const poi = (name: string) => ({ id: name, name, location: "121.48,31.24", cityname: "上海市", adname: "黄浦区", adcode: "310101", type: "景点", address: name });
const routeResponse = () => Response.json({ status: "1", route: { paths: [{ duration: "600", distance: "1000" }], transits: [{ duration: "600", distance: "1000" }] } });

function fixture(rawText = "不要步行，帮我优化行程", reason: "optimize" | "tired" | "weather" = "optimize") {
  const snapshot = createStarterSnapshot();
  snapshot.trip.destination = "上海";
  snapshot.state.currentTime = "09:00";
  snapshot.state.currentLocation = "人民广场";
  snapshot.stateSources.currentTime = "user";
  snapshot.stateSources.currentLocation = "user";
  const fact = ActivityFactSchema.parse({ id: "museum", placeId: "museum-poi", origin: "message", snapshotEventId: null,
    role: "existing_plan", progress: "not_started", name: "上海博物馆", placeQuery: "上海博物馆", startTime: "14:00", startTimeSource: "user",
    endTime: "14:30", durationMinutes: 30, durationSource: "user", commitment: "flexible", sourceText: "14点去上海博物馆" });
  return ReplanInputSchema.parse({ snapshot, request: { reason, freeText: rawText, currentState: snapshot.state, stateSources: snapshot.stateSources,
    closedPlaceIds: [], variation: 0, activityFacts: [fact], worldOptions: { selectedPois: {}, allowedTravelModes: ["TRANSIT", "DRIVING"] } },
    mode: "live", confirmation: { status: "confirmed", confirmedAt: new Date().toISOString() } });
}

async function coldSearchesArePaced() {
  clearWorldCache();
  process.env.AMAP_REQUEST_INTERVAL_MS = "500";
  const starts: number[] = [];
  globalThis.fetch = async () => { starts.push(performance.now()); return Response.json({ status: "1", pois: [] }); };
  const places = new AmapPlacesService();
  await Promise.all(["上海博物馆", "豫园", "十六铺码头1区"].map(query => places.searchUnbounded(query)));
  await places.search("上海人民广场丽笙大酒店", "上海");
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i++) assert(starts[i] - starts[i - 1] >= 470, "city evidence must use the same scheduler as the following hotel lookup");
  await places.searchUnbounded("上海博物馆");
  assert.equal(starts.length, 4, "cached searches do not consume an outbound slot");
}

async function throttlingAndDiagnostics() {
  process.env.AMAP_REQUEST_INTERVAL_MS = "20";
  for (const response of [() => failure("10021"), () => failure("10016"), () => new Response("", { status: 429, headers: { "Retry-After": "1" } })]) {
    clearWorldCache();
    let calls = 0;
    const starts: number[] = [];
    globalThis.fetch = async () => { calls++; starts.push(performance.now()); return calls === 1 ? response() : Response.json({ status: "1" }); };
    const execution = new RequestExecution({ traceId: "retry-diagnostics" });
    const logs: string[] = [];
    const originalInfo = console.info;
    try {
      await amapGet("/v3/place/text", {}, 1000, { execution });
      assert.equal(calls, 2);
      assert(starts[1] - starts[0] >= 950, "provider throttling must wait, rather than immediately amplify traffic");
      console.info = message => { logs.push(String(message)); };
      execution.finish({ route: "/api/assist", outcome: "success", httpStatus: 200 });
      const log = JSON.parse(logs[0]);
      assert.equal(log.providerFailures.length, 1, "recovered upstream errors remain diagnosable");
      assert.equal(log.providerFailures[0].path, "/v3/place/text");
      assert.equal(log.providers.amap.outboundRequestCount, 2);
      assert.equal(log.providers.amap.retryCount, 1);
      assert(!logs[0].includes("test-key"));
    } finally { console.info = originalInfo; execution.dispose(); }
  }

  clearWorldCache();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return failure("10021"); };
  await assert.rejects(amapGet("/v3/place/text", {}), (error: unknown) => {
    assert(error instanceof WorldServiceError);
    assert.equal(error.detail, "10021");
    assert.equal(failureInfo(error, "trace-10021").providerCode, "10021");
    return true;
  });
  assert.equal(calls, 2, "persistent throttling stops after one retry");

  clearWorldCache();
  const starts: Array<{ path: string; time: number }> = [];
  let firstAttempts = 0;
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    starts.push({ path, time: performance.now() });
    return path === "/throttled" && firstAttempts++ === 0 ? failure("10021") : Response.json({ status: "1" });
  };
  const first = amapGet("/throttled", {});
  await sleep(5);
  await Promise.all([first, amapGet("/other-queued", {})]);
  assert.equal(starts.length, 3);
  assert(starts[1].time - starts[0].time >= 950, "throttling must cool down other queued lookups too");

  for (const code of ["10001", "10003", "10044"]) {
    clearWorldCache(); calls = 0;
    globalThis.fetch = async () => { calls++; return failure(code); };
    await assert.rejects(amapGet("/v3/place/text", {}), (error: unknown) => error instanceof WorldServiceError && !error.retryable);
    assert.equal(calls, 1, "invalid credentials and exhausted daily quota must not retry");
  }

  clearWorldCache(); calls = 0;
  globalThis.fetch = async () => { calls++; return failure("10021"); };
  const execution = new RequestExecution({ deadlineMs: 30 });
  try {
    await assert.rejects(amapGet("/v3/place/text", {}, 1000, { signal: execution.signal }),
      (error: unknown) => error instanceof ServiceFailure && error.code === "REQUEST_DEADLINE_EXCEEDED");
    assert.equal(calls, 1, "the deadline cancels pending retry/cooldown");
  } finally { execution.dispose(); }
}

async function partialFailuresRespectRestrictions() {
  process.env.AMAP_REQUEST_INTERVAL_MS = "5";
  clearWorldCache();
  const queriedPaths: string[] = [];
  globalThis.fetch = async url => {
    const parsed = new URL(String(url)); queriedPaths.push(parsed.pathname);
    if (parsed.pathname === "/v3/place/text") return Response.json({ status: "1", pois: [poi(parsed.searchParams.get("keywords")!)] });
    if (parsed.pathname.includes("/transit/")) return failure("10002");
    return routeResponse();
  };
  const input = fixture();
  const world = await new WorldContextService().ground(input);
  assert.equal(world.status, "ready", "a failed transit API must not discard a valid allowed driving route");
  assert(!queriedPaths.some(path => path.includes("walking")), "forbidden walking must never be queried");
  assert(world.routes.some(route => route.travelMode === "TRANSIT" && route.status === "unavailable"));
  assert(world.dataWarnings?.length);
  const context = buildRealContext(input, world);
  const candidate: PlanCandidate = { title: "打车前往", tradeOff: "使用已核实的打车路线", steps: [{ eventId: "museum", poiId: null, durationMinutes: 30, travelMode: "DRIVING", reason: "保留原安排" }], removed: [] };
  const plan = materializeCandidate(context, candidate, input.snapshot);
  assert.equal(plan.events[0].travelMode, "DRIVING");
  assert.deepEqual(travelTimeValidator(context, plan), []);
  assert.throws(() => materializeCandidate(context, { ...candidate, steps: [{ ...candidate.steps[0], travelMode: "TRANSIT" }] }, input.snapshot), CandidateOutputError);

  // Even stale/unexpected walking data must never become a fallback when the
  // model forgets to choose a mode, or explicitly selects a forbidden mode.
  const driving = world.routes.find(route => route.travelMode === "DRIVING")!;
  world.routes = [{ ...driving, travelMode: "WALKING" }];
  assert.throws(() => materializeCandidate(context, { ...candidate, steps: [{ ...candidate.steps[0], travelMode: undefined }] }, input.snapshot), CandidateOutputError);
  assert.throws(() => materializeCandidate(context, { ...candidate, steps: [{ ...candidate.steps[0], travelMode: "WALKING" }] }, input.snapshot), CandidateOutputError);
  assert(travelTimeValidator(context, { ...plan, events: plan.events.map(event => ({ ...event, travelMode: "WALKING" })) }).some(error => /违反用户明确限制/.test(error.message)));

  // An unrelated usable route is insufficient: a selected itinerary must have
  // a real route for every leg, even after the world stage accepts partial data.
  world.routes = [driving];
  const secondFact = ActivityFactSchema.parse({ ...input.request.activityFacts[0], id: "garden", placeId: "garden-poi", name: "豫园", placeQuery: "豫园", startTime: "16:00", endTime: "16:30" });
  const incompleteContext = { ...context, activityFacts: [...context.activityFacts, secondFact], remainingActivityFacts: [...context.remainingActivityFacts, secondFact] };
  assert.throws(() => materializeCandidate(incompleteContext, { ...candidate, steps: [...candidate.steps, { ...candidate.steps[0], eventId: "garden" }] }, input.snapshot), CandidateOutputError);

  clearWorldCache();
  globalThis.fetch = async url => {
    const parsed = new URL(String(url));
    return parsed.pathname === "/v3/place/text" ? Response.json({ status: "1", pois: [poi(parsed.searchParams.get("keywords")!)] }) : failure("10002");
  };
  await assert.rejects(new WorldContextService().ground(input), (error: unknown) => error instanceof ServiceFailure && error.code === "MAP_PROVIDER_ERROR" && error.detail === "10002",
    "no permitted route available must remain a failure");
}

async function optionalAndRequiredFailures() {
  const input = fixture("不要步行，太累了帮我调整", "tired");
  const serve = (url: RequestInfo | URL) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v3/place/text") return Response.json({ status: "1", pois: [poi(parsed.searchParams.get("keywords")!)] });
    return routeResponse();
  };
  clearWorldCache();
  globalThis.fetch = async url => new URL(String(url)).pathname === "/v3/place/around" ? failure("10002") : serve(url);
  let world = await new WorldContextService().ground(input);
  assert.equal(world.status, "ready");
  assert.equal(world.alternatives.length, 0);
  assert(world.dataWarnings?.some(warning => warning.includes("附近")));

  clearWorldCache();
  const weatherInput = fixture("下雨了，不要步行", "weather");
  globalThis.fetch = async url => new URL(String(url)).pathname.includes("weatherInfo") ? failure("10002") : serve(url);
  world = await new WorldContextService().ground(weatherInput);
  assert.equal(world.status, "ready");
  assert.equal(world.weather.status, "unavailable");
  assert.equal(world.weather.condition, null, "weather failure must not invent sunshine/rain");
  assert(world.dataWarnings?.some(warning => warning.includes("天气")));

  clearWorldCache();
  globalThis.fetch = async url => {
    const parsed = new URL(String(url));
    return parsed.pathname === "/v3/place/text" && parsed.searchParams.get("keywords") === "上海博物馆" ? failure("10003") : serve(url);
  };
  await assert.rejects(new WorldContextService().ground(input), (error: unknown) => error instanceof ServiceFailure && error.detail === "10003",
    "missing required place identity must stop the flow");

  for (const error of [requestCancelled("GROUNDING"), requestDeadlineExceeded("GROUNDING")]) {
    clearWorldCache();
    globalThis.fetch = async url => { if (new URL(String(url)).pathname === "/v3/place/around") throw error; return serve(url); };
    await assert.rejects(new WorldContextService().ground(input), (caught: unknown) => caught instanceof ServiceFailure && caught.code === error.code,
      "cancellation and deadlines must never be downgraded to optional-data failure");
  }
  clearWorldCache();
  globalThis.fetch = async url => new URL(String(url)).pathname === "/v3/place/around" ? failure("10001") : serve(url);
  await assert.rejects(new WorldContextService().ground(input), (error: unknown) => error instanceof ServiceFailure && error.detail === "10001",
    "an invalid account key remains fatal even for an optional query");
}

async function main() {
  process.env.AMAP_API_KEY = "test-key";
  try {
    await coldSearchesArePaced();
    await throttlingAndDiagnostics();
    await partialFailuresRespectRestrictions();
    await optionalAndRequiredFailures();
    console.log("Amap pacing, partial failure, diagnostics and transport restriction tests passed.");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.AMAP_API_KEY; else process.env.AMAP_API_KEY = originalKey;
    if (originalInterval === undefined) delete process.env.AMAP_REQUEST_INTERVAL_MS; else process.env.AMAP_REQUEST_INTERVAL_MS = originalInterval;
    clearWorldCache();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
