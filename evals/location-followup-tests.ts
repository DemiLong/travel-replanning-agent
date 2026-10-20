import assert from "node:assert/strict";
import { runAgentAssist, type AssistDependencies } from "../agents/agent-orchestrator";
import { createStarterSnapshot } from "../data/session-defaults";
import { recoverActivityLocation } from "../services/location-recovery";
import { confirmedDraftFromParsed } from "../services/itinerary-domain";
import { normalizeSemanticExtraction } from "../services/semantic-parser";
import { ServiceFailure } from "../services/failures";
import { AmapPlacesService } from "../services/world/amap-places-service";
import { AmapRoutesService } from "../services/world/amap-routes-service";
import { WorldContextService } from "../services/world/world-context-service";
import { uniquePlace } from "../services/world/context-resolution";
import { ActivityFactSchema, EventSchema, ReplanInputSchema, SemanticExtractionSchema, type ActivityFact } from "../types";
import { RealWorldContextSchema, type PlaceResolution, type RouteEndpoint, type TravelMode, type WorldPoi, type WorldRoute } from "../types/world";

const text = "现在是下午4点，我刚到上海博物馆东馆，比原计划晚了60分钟，本来我打算17:00去国金中心、19:00去外滩的，现在还来得及么？";
const base = createStarterSnapshot();
base.state.currentTime = "16:00";
base.stateSources.currentTime = "user";
const time = new Date().toISOString();
function venue(id: string, name: string, city = "上海市"): WorldPoi {
  return { poiId: id, name, city, district: "浦东新区", address: `${city}测试地址`, adcode: "310115", longitude: 121.5, latitude: 31.2,
    coordinateSystem: "GCJ02", type: "景点", source: "amap", fetchedAt: time, status: "available" };
}
function fact(name: string, sourceText = `原定17点去${name}`, placeQuery: string | null = null): ActivityFact {
  return ActivityFactSchema.parse({ id: name, placeId: `place-${name}`, name, sourceText, placeQuery, origin: "message", snapshotEventId: null,
    role: "existing_plan", progress: "not_started", startTime: "17:00", startTimeSource: "user", endTime: null, durationMinutes: null,
    durationSource: "unknown", commitment: "flexible" });
}
function frozenParsed() {
  return normalizeSemanticExtraction(base, text, SemanticExtractionSchema.parse({
    intent: "rescue", activities: [
      { name: "去国金中心", sourceText: "本来我打算17:00去国金中心", startTime: "17:00", startTimeEvidence: "17:00" },
      { name: "去外滩", sourceText: "19:00去外滩", startTime: "19:00", startTimeEvidence: "19:00" },
    ].map(item => ({ ...item, location: null, role: "existing_plan", locked: "no", progress: "not_started", endTime: null, durationMinutes: null })),
    disruptions: [{ kind: "late", label: "比原计划晚了60分钟", sourceText: "比原计划晚了60分钟" }], constraints: [],
    context: { currentTime: { value: "16:00", sourceText: "现在是下午4点" }, currentLocation: { value: "上海博物馆东馆", sourceText: "我刚到上海博物馆东馆" },
      weather: { value: null, sourceText: null }, energyLevel: { value: null, sourceText: null } },
    question: "现在还来得及么？", ambiguities: [],
  }), "frozen-test-model");
}
function unavailable() {
  return RealWorldContextSchema.parse({ currentTime: { value: "16:00", date: base.state.currentDate, source: "user", confirmedAt: time },
    currentLocation: null, resolvedPlaces: [], alternatives: [], routes: [],
    weather: { condition: null, temperature: null, humidity: null, windDirection: null, windPower: null, forecast: [], source: "amap", fetchedAt: time, reportedAt: null, status: "not_requested" },
    dataFreshness: { groundedAt: time, routeMaxAgeSeconds: 120, locationMaxAgeSeconds: 600 },
    missingWorldFacts: [{ kind: "world", field: "routes", message: "路线服务暂时不可用。" }], ambiguities: [], travelMode: null, status: "unavailable" });
}
class TestPlaces extends AmapPlacesService {
  calls: Array<{ query: string; city: string }> = [];
  constructor(private catalog: Record<string, WorldPoi[]>) { super(); }
  override async search(query: string, city = ""): Promise<PlaceResolution> {
    this.calls.push({ query, city });
    const candidates = this.catalog[query] ?? [];
    return { candidates, status: candidates.length ? "available" : "unavailable" };
  }
  override async searchUnbounded(query: string) { return this.search(query); }
}
class TestRoutes extends AmapRoutesService {
  override async batch(pairs: Array<{ origin: RouteEndpoint; destination: RouteEndpoint }>, travelMode: TravelMode): Promise<WorldRoute[]> {
    return pairs.map(pair => ({ ...pair, travelMode, source: "amap", fetchedAt: time, status: "available", durationSeconds: 600, distanceMeters: 1000 }));
  }
}
function groundInput(place: ActivityFact, current = "上海博物馆东馆", city = "待确认城市") {
  const snapshot = structuredClone(base);
  snapshot.trip.destination = city;
  snapshot.state.currentLocation = current;
  snapshot.stateSources.currentLocation = "user";
  return ReplanInputSchema.parse({ snapshot, request: { reason: "late", freeText: "出发晚了，请调整行程", currentState: snapshot.state,
    stateSources: snapshot.stateSources, activityFacts: [place], closedPlaceIds: [], variation: 0,
    worldOptions: { selectedPois: {}, allowedTravelModes: ["TRANSIT"] } }, mode: "live", confirmation: { status: "confirmed", confirmedAt: time } });
}

async function main() {
  assert.equal(frozenParsed().activityFacts[0].placeQuery, null);
  let checks = 0;
  const check = async (name: string, run: () => void | Promise<void>) => { await run(); checks++; console.log(`PASS ${name}`); };

  await check("frozen missing locations reach grounding, retain evidence, and clear stale warnings", async () => {
    let captured: ReturnType<typeof ReplanInputSchema.parse> | undefined;
    const result = await runAgentAssist({ snapshot: base, rawText: text }, undefined, {
      parse: async () => frozenParsed(), ground: async raw => { captured = ReplanInputSchema.parse(raw); return unavailable(); },
    });
    assert.equal(result.status, "UPSTREAM_UNAVAILABLE");
    assert.deepEqual(captured?.request.activityFacts.map(item => item.placeQuery), ["国金中心", "外滩"]);
    assert.equal(result.parsedInput?.parseWarnings.length, 0);
    assert(!result.parsedInput?.missingFacts.includes("activityDetails"));
    assert.equal(result.parsedInput?.activityFacts[0].locationEvidence?.source, "original_text");
    if (result.status !== "UPSTREAM_UNAVAILABLE") throw new Error("expected recoverable map failure");
    assert.equal(result.confirmedDraft?.activityFacts[0].placeQuery, "国金中心");
  });

  for (const name of ["国金中心", "外滩", "巴金故居", "颐和园", "上海和平饭店", "蓝蛙(虹桥天地店)"]) {
    await check(`recover an evidenced venue: ${name}`, () => {
      const item = fact(`去${name}`, `原定17点去${name}`);
      assert.equal(recoverActivityLocation(item, item.sourceText!, base).placeQuery, name);
    });
  }
  for (const name of ["吃晚饭", "回酒店", "逛商场", "附近的咖啡馆", "国金中心和外滩"]) {
    await check(`do not invent a destination for: ${name}`, () => {
      const item = fact(name);
      assert.equal(recoverActivityLocation(item, item.sourceText!, base).placeQuery, null);
    });
  }
  await check("use a single venue from the activity's own clause with a generic activity title", () => {
    const item = fact("吃饭", "原定17点去海棠餐厅吃饭");
    assert.equal(recoverActivityLocation(item, item.sourceText!, base).placeQuery, "海棠餐厅");
  });
  await check("meeting another person does not turn a single venue into multiple destinations", () => {
    const item = fact("去国金中心", "原定17点去国金中心和朋友集合");
    assert.equal(recoverActivityLocation(item, item.sourceText!, base).placeQuery, "国金中心");
  });
  await check("action-like characters inside an evidenced venue name are preserved", () => {
    for (const name of ["回民街", "去回民街", "在水一方"]) {
      const item = fact(name, `原定17点去${name.replace(/^去/u, "")}`);
      assert.equal(recoverActivityLocation(item, item.sourceText!, base).placeQuery, name.replace(/^去/u, ""));
    }
  });
  await check("an explicit cleared saved location is not restored from old prose", () => {
    const item = { ...fact("去国金中心"), origin: "snapshot" as const, snapshotEventId: "saved" };
    assert.equal(recoverActivityLocation(item, item.sourceText!, base).placeQuery, null);
  });
  await check("unverified source and invented venue names cannot become search queries", () => {
    const item = fact("上海国金中心", "原定17点去国金中心");
    assert.equal(recoverActivityLocation(item, item.sourceText!, base).placeQuery, "国金中心");
    assert.equal(recoverActivityLocation(item, "原定去外滩", base).placeQuery, null);
  });
  await check("a uniquely saved hotel can resolve a reference, but two hotels cannot", () => {
    const snapshot = structuredClone(base);
    const hotel = EventSchema.parse({ id: "hotel", placeId: "hotel-place", name: "上海和平饭店", location: "上海和平饭店", category: "hotel",
      startTime: "18:00", endTime: "19:00", startTimeSource: "user", durationSource: "user", status: "planned", locked: false,
      indoorOutdoor: "mixed", openingTime: null, closingTime: null, travelTimeFromPrevious: null, reason: "原安排", constraint: "原安排" });
    snapshot.itinerary = [hotel];
    const item = fact("回酒店", "原定17点回酒店");
    assert.equal(recoverActivityLocation(item, item.sourceText!, snapshot).placeQuery, "上海和平饭店");
    snapshot.itinerary.push({ ...hotel, id: "second-hotel", placeId: "second-place", name: "上海另一酒店", location: "上海另一酒店" });
    assert.equal(recoverActivityLocation(item, item.sourceText!, snapshot).placeQuery, null);
  });
  await check("follow-up answers take priority over original prose and invalidate old selections", async () => {
    const parsed = frozenParsed();
    parsed.activityFacts[0].placeQuery = "国金中心";
    parsed.activityFacts[1].placeQuery = "外滩";
    const draft = confirmedDraftFromParsed(base, parsed);
    draft.worldOptions ??= { selectedPois: {} };
    draft.worldOptions!.selectedPois[draft.activityFacts[0].placeId] = "old-branch";
    let captured: ReturnType<typeof ReplanInputSchema.parse> | undefined;
    const key = `activity:${draft.activityFacts[0].id}:location`;
    await runAgentAssist({ snapshot: base, confirmedDraft: draft, answer: { kind: "text", field: key, value: "上海环球金融中心" },
      resolutionState: { currentBlockerKey: key, sameBlockerCount: 1, roundCount: 1, answeredFields: [], questionHistory: [key] } }, undefined,
      { ground: async raw => { captured = ReplanInputSchema.parse(raw); return unavailable(); } });
    assert.equal(captured?.request.activityFacts[0].placeQuery, "上海环球金融中心");
    assert.equal(captured?.request.worldOptions?.selectedPois[draft.activityFacts[0].placeId], undefined);
  });
  await check("resolved places survive a later follow-up and a map failure without re-parsing", async () => {
    const world = unavailable();
    world.status = "needs_input";
    world.resolvedPlaces = [{ placeId: "place-kept", poi: venue("kept-poi", "已确认地点") }];
    world.missingWorldFacts = [{ kind: "user", field: "currentLocation", message: "请补充当前位置。" }];
    const first = await runAgentAssist({ snapshot: base, rawText: text }, undefined, { parse: async () => frozenParsed(), ground: async () => world });
    if (first.status !== "NEEDS_INPUT") throw new Error("expected location question");
    assert.equal(first.confirmedDraft.worldOptions?.selectedPois["place-kept"], "kept-poi");
    const second = await runAgentAssist({ snapshot: base, confirmedDraft: first.confirmedDraft,
      answer: { kind: "text", field: "currentLocation", value: "上海人民广场" }, resolutionState: first.resolutionState }, undefined,
      { ground: async () => { throw new ServiceFailure("MAP_NETWORK_ERROR", "GROUNDING", { retryable: true, provider: "amap" }); } });
    if (second.status !== "UPSTREAM_UNAVAILABLE") throw new Error("expected map failure");
    assert.equal(second.confirmedDraft?.context.currentLocation, "上海人民广场");
    assert.equal(second.resolutionState?.currentBlockerKey, null);
    let parseCalls = 0;
    await runAgentAssist({ snapshot: base, confirmedDraft: second.confirmedDraft, resolutionState: second.resolutionState }, undefined,
      { parse: async () => { parseCalls++; return frozenParsed(); }, ground: async () => unavailable() });
    assert.equal(parseCalls, 0);
  });

  await check("four different successful questions are not rejected by a three-round cap", async () => {
    const keys = ["currentLocation", "destination", "travelMode", "currentLocation"];
    let round = 0;
    const dependencies: AssistDependencies = { parse: async () => frozenParsed(), ground: async () => {
      const world = unavailable(); world.status = "needs_input";
      world.missingWorldFacts = [{ kind: "user", field: keys[round++], message: `请补充第${round}项信息。` }]; return world;
    } };
    let result = await runAgentAssist({ snapshot: base, rawText: text }, undefined, dependencies);
    for (let i = 0; i < 3; i++) {
      if (result.status !== "NEEDS_INPUT") throw new Error("expected continued progress");
      const key = result.missingFact.key;
      result = await runAgentAssist({ snapshot: base, confirmedDraft: result.confirmedDraft, resolutionState: result.resolutionState,
        answer: key === "travelMode" ? { kind: "travel_mode", field: key, value: "TRANSIT" } : { kind: "text", field: key, value: key === "destination" ? "上海" : "上海人民广场" } }, undefined, dependencies);
    }
    assert.equal(result.status, "NEEDS_INPUT");
    assert.equal(result.resolutionState?.roundCount, 4);
  });
  await check("repeated unresolved question stops without claiming the trip is out of scope", async () => {
    const world = unavailable(); world.status = "needs_input";
    world.missingWorldFacts = [{ kind: "user", field: "currentLocation", message: "请补充具体当前位置。" }];
    const dependencies: AssistDependencies = { parse: async () => frozenParsed(), ground: async () => world };
    let result = await runAgentAssist({ snapshot: base, rawText: text }, undefined, dependencies);
    for (let i = 0; i < 2; i++) {
      if (result.status !== "NEEDS_INPUT") throw new Error("expected repeated question");
      result = await runAgentAssist({ snapshot: base, confirmedDraft: result.confirmedDraft, resolutionState: result.resolutionState,
        answer: { kind: "text", field: "currentLocation", value: "附近" } }, undefined, dependencies);
    }
    assert.equal(result.status, "NO_SAFE_PLAN");
    if (result.status !== "NO_SAFE_PLAN") throw new Error("expected bounded stop");
    assert(result.confirmedDraft);
  });
  await check("moving from a text answer to an actual branch choice is progress", async () => {
    const initial = frozenParsed();
    initial.activityFacts = [fact("吃晚饭", "原定17点吃晚饭")];
    initial.rawText = "原定17点吃晚饭，出发晚了，请调整";
    const first = await runAgentAssist({ snapshot: base, rawText: initial.rawText }, undefined, { parse: async () => initial });
    if (first.status !== "NEEDS_INPUT") throw new Error("expected venue question");
    const next = unavailable(); next.status = "needs_input"; next.missingWorldFacts = [];
    next.ambiguities = [{ field: initial.activityFacts[0].placeId, label: "海底捞", candidates: [venue("a", "海底捞(甲店)"), venue("b", "海底捞(乙店)")] }];
    const result = await runAgentAssist({ snapshot: base, confirmedDraft: first.confirmedDraft, resolutionState: first.resolutionState,
      answer: { kind: "text", field: first.missingFact.key, value: "海底捞" } }, undefined, { ground: async () => next });
    assert.equal(result.status, "NEEDS_INPUT");
    assert.equal(result.resolutionState?.sameBlockerCount, 1);
    if (result.status === "NEEDS_INPUT") assert(result.missingFact.candidates?.every(item => item.description?.includes("上海市")));
  });

  const originalKey = process.env.AMAP_API_KEY;
  process.env.AMAP_API_KEY = "test-key";
  try {
    const museum = venue("current-museum", "上海博物馆东馆");
    for (const [name, query, candidates] of [
      ["reject wrong city", "上海动物园", [venue("beijing", "北京动物园", "北京市")]],
      ["report no search results", "不存在的指定场馆", []],
    ] as Array<[string, string, WorldPoi[]]>) {
      await check(name, async () => {
        const places = new TestPlaces({ "上海博物馆东馆": [museum], [query]: candidates });
        const input = groundInput(fact(query, `去${query}`, query));
        const world = await new WorldContextService(places, new TestRoutes()).ground(input);
        assert.equal(world.resolvedPlaces.length, 0);
        assert.equal(world.status, "unavailable");
        assert(world.missingWorldFacts.some(item => item.kind === "world"));
        assert.equal(world.missingWorldFacts.filter(item => item.kind === "user").length, 0);
      });
    }
    for (const [query, candidate] of [
      ["蓝蛙(虹桥天地店)", venue("other-branch", "蓝蛙(虹桥南丰城店)")],
      ["中华艺术宫", venue("station", "中华艺术宫(地铁站)")],
    ] as Array<[string, WorldPoi]>) {
      await check(`provider result is shown but not automatically adopted: ${candidate.name}`, async () => {
        const places = new TestPlaces({ "上海博物馆东馆": [museum], [query]: [candidate] });
        const world = await new WorldContextService(places, new TestRoutes()).ground(groundInput(fact(query, `去${query}`, query)));
        assert.equal(world.resolvedPlaces.length, 0);
        assert.equal(world.status, "needs_input");
        assert.equal(world.ambiguities[0].candidates[0].poiId, candidate.poiId);
      });
    }
    await check("provider aliases retain original names, addresses and order; selected alias can be used", async () => {
      const results = [venue("mall", "上海ifc商场"), venue("center", "国际金融中心"), venue("phase", "国金中心2期"),
        venue("parking", "上海国金中心商场地下停车场"), venue("tower", "国金中心A座")];
      const places = new TestPlaces({ "上海博物馆东馆": [museum], "国金中心": results });
      const input = groundInput(fact("国金中心", "去国金中心", "国金中心"));
      const service = new WorldContextService(places, new TestRoutes());
      const first = await service.ground(input);
      assert.equal(first.resolvedPlaces.length, 0);
      assert.deepEqual(first.ambiguities[0].candidates, results);
      input.request.worldOptions!.selectedPois[input.request.activityFacts[0].placeId] = "mall";
      const selected = await service.ground(input);
      assert.equal(selected.status, "ready");
      assert.equal(selected.resolvedPlaces[0].poi.name, "上海ifc商场");
    });
    await check("multiple branches require selection; a chosen non-first branch stays chosen", async () => {
      const branches = [venue("branch-a", "海底捞(甲店)"), venue("branch-b", "海底捞(乙店)")];
      const places = new TestPlaces({ "上海博物馆东馆": [museum], "海底捞": branches });
      const input = groundInput(fact("海底捞", "去海底捞", "海底捞"));
      const service = new WorldContextService(places, new TestRoutes());
      const first = await service.ground(input);
      assert.equal(first.resolvedPlaces.length, 0);
      assert.equal(first.ambiguities[0].candidates.length, 2);
      input.request.worldOptions!.selectedPois[input.request.activityFacts[0].placeId] = "branch-b";
      const second = await service.ground(input);
      assert.equal(second.status, "ready");
      assert.equal(second.resolvedPlaces[0].poi.poiId, "branch-b");
      assert(places.calls.some(call => call.query === "海底捞" && call.city === "上海市"));
    });
    await check("one fuzzy match is offered for confirmation rather than automatically adopted", async () => {
      const places = new TestPlaces({ "上海博物馆东馆": [museum], "国金中心": [venue("ifc", "上海ifc国金中心商场")] });
      const world = await new WorldContextService(places, new TestRoutes()).ground(groundInput(fact("国金中心", "去国金中心", "国金中心")));
      assert.equal(world.status, "needs_input");
      assert.equal(world.resolvedPlaces.length, 0);
      assert.equal(world.ambiguities[0].candidates[0].poiId, "ifc");
    });
    await check("an explicit destination city is preserved instead of forced into the current city", async () => {
      const places = new TestPlaces({ "上海博物馆东馆": [museum], "苏州博物馆": [venue("suzhou", "苏州博物馆", "苏州市")] });
      const world = await new WorldContextService(places, new TestRoutes()).ground(groundInput(fact("苏州博物馆", "去苏州博物馆", "苏州博物馆")));
      assert.equal(world.resolvedPlaces[0].poi.city, "苏州市");
    });
    await check("a city conflict from an unqualified current location requires confirmation", async () => {
      const places = new TestPlaces({ "人民广场": [venue("wrong-city-square", "人民广场", "北京市")], "上海外滩": [venue("bund", "上海外滩")] });
      const world = await new WorldContextService(places, new TestRoutes()).ground(groundInput(fact("上海外滩", "去上海外滩", "上海外滩"), "人民广场"));
      assert.equal(world.currentLocation, null);
      assert(world.missingWorldFacts.some(item => item.kind === "user" && item.field === "currentLocation"));
      assert(!world.resolutionEvidence?.some(item => item.field === "currentLocation" && item.poiId));
    });
    await check("a brand's exact hit plus a branch alias is still ambiguous", () => {
      assert.equal(uniquePlace([venue("brand", "海底捞"), venue("branch", "海底捞(甲店)")], "海底捞", "上海市"), null);
    });
    await check("a city prefix alone does not create a spurious place ambiguity", () => {
      assert.equal(uniquePlace([venue("bund", "上海外滩")], "外滩", "")?.poiId, "bund");
    });
    await check("a venue's same-name bus stop is not a competing destination", async () => {
      const places = new TestPlaces({ "上海博物馆东馆": [venue("museum", "上海博物馆(东馆)"), venue("bus-stop", "上海博物馆东馆(公交站)")],
        "外滩": [venue("bund", "外滩"), venue("viewpoint", "外滩观景台")] });
      const world = await new WorldContextService(places, new TestRoutes()).ground(groundInput(fact("外滩", "去外滩", "外滩")));
      assert.equal(world.status, "ready");
      assert.equal(world.currentLocation?.id, "current");
      assert.equal(world.resolvedPlaces[0].poi.poiId, "bund");
      assert.equal(world.ambiguities.length, 0);
    });
    await check("branch names without parentheses still require a choice", () => {
      assert.equal(uniquePlace([venue("brand", "海底捞"), venue("branch", "海底捞甲店")], "海底捞", "上海市"), null);
    });
  } finally {
    if (originalKey === undefined) delete process.env.AMAP_API_KEY; else process.env.AMAP_API_KEY = originalKey;
  }
  console.log(`Location recovery and follow-up regression: ${checks} checks passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
