import assert from "node:assert/strict";
import { runWorldTests } from "./world-tests";
import { createStarterSnapshot } from "../data/session-defaults";
import {
  createDeterministicTestSnapshot,
  createLegacyDemoSnapshot,
  event,
} from "./test-helpers";
import { buildContext } from "../agents/context-builder";
import { DeterministicTestPlanner } from "./deterministic-planner";
import { replan } from "../agents/replanning-agent";
import { validatePlan } from "../validators";
import { parseItineraryText } from "../services/itinerary-parser";
import { parseUnifiedInput } from "../services/input-parser";
import {
  normalizeSemanticExtraction,
  SEMANTIC_PARSER_PROMPT,
} from "../services/semantic-parser";
import {
  loadSession,
  realSessionKey,
  saveSession,
} from "../services/trip-service";
import type { ProposedPlan, Violation } from "../types";
async function main() {
  await runWorldTests();
  const legacyDemo = createLegacyDemoSnapshot();
  const input = {
    snapshot: createDeterministicTestSnapshot(),
    mode: "local" as const,
    request: {
      reason: "tired",
      freeText: "rain",
      currentState: createDeterministicTestSnapshot().state,
      closedPlaceIds: [],
      variation: 0,
    },
    confirmation: {
      status: "confirmed" as const,
      confirmedAt: new Date().toISOString(),
    },
  };
  input.request.currentState = input.snapshot.state;
  const context = buildContext(input);
  const good = await new DeterministicTestPlanner().generate(context);
  assert.deepEqual(validatePlan(context, good), []);
  const tests: [string, Violation["code"], (p: ProposedPlan) => void][] = [
    [
      "deleted lock",
      "locked_event",
      (p) => {
        p.events = p.events.filter((e) => !e.locked);
      },
    ],
    [
      "retimed lock",
      "locked_event",
      (p) => {
        p.events.find((e) => e.locked)!.startTime = "19:05";
      },
    ],
    [
      "renamed lock",
      "locked_event",
      (p) => {
        p.events.find((e) => e.locked)!.name = "Different dinner";
      },
    ],
    [
      "overlap",
      "time_conflict",
      (p) => {
        p.events[0].endTime = "19:15";
      },
    ],
    [
      "first transfer",
      "travel_time",
      (p) => {
        p.events[0].startTime = "15:00";
      },
    ],
    [
      "between transfer",
      "travel_time",
      (p) => {
        p.events[1].startTime = p.events[0].endTime;
      },
    ],
    [
      "closed hour",
      "opening_hours",
      (p) => {
        p.events.unshift(
          event("history-museum", "late-museum", "16:00", "17:00"),
        );
      },
    ],
    [
      "over budget",
      "budget",
      (p) => {
        p.events.push(event("nature-center", "expensive", "21:00", "22:00"));
      },
    ],
    [
      "past",
      "past_event",
      (p) => {
        p.events[0].startTime = "14:59";
      },
    ],
    [
      "zero duration",
      "duration",
      (p) => {
        p.events[0].endTime = p.events[0].startTime;
      },
    ],
    [
      "negative duration",
      "duration",
      (p) => {
        p.events[0].endTime = "14:00";
      },
    ],
    [
      "forged price",
      "place_data",
      (p) => {
        p.events[0].estimatedCost += 1;
      },
    ],
    [
      "forged hours",
      "place_data",
      (p) => {
        p.events[0].closingTime = "23:58";
      },
    ],
    [
      "unknown venue",
      "place_data",
      (p) => {
        p.events[0].placeId = "imaginary";
      },
    ],
    [
      "duplicate id",
      "schema",
      (p) => {
        p.events.push(p.events[0]);
      },
    ],
    [
      "hidden original removal",
      "change_accounting",
      (p) => {
        p.movedEvents = [];
        p.removedEvents = [];
      },
    ],
    [
      "unapproved lock",
      "locked_event",
      (p) => {
        p.events[0].locked = true;
      },
    ],
    [
      "historical output",
      "past_event",
      (p) => {
        p.events.push(legacyDemo.itinerary[0]);
      },
    ],
  ];
  for (const [name, code, mutate] of tests) {
    const bad = structuredClone(good);
    mutate(bad);
    assert(
      validatePlan(context, bad).some((v) => v.code === code),
      name,
    );
    console.log(`PASS ${name}`);
  }
  assert(
    validatePlan(context, { summary: "malformed" }).some(
      (v) => v.code === "schema",
    ),
  );
  let calls = 0;
  const repaired = await replan(
    input,
    {
      name: "repair-fixture",
      async generate(_c, feedback) {
        calls++;
        if (calls === 1) return {};
        assert(feedback.some((v) => v.code === "schema"));
        return good;
      },
    },
    "local",
  );
  assert(repaired.ok && calls === 2);
  calls = 0;
  const failed = await replan(
    input,
    {
      name: "always-invalid",
      async generate() {
        calls++;
        return {};
      },
    },
    "local",
  );
  assert(!failed.ok && calls === 3 && failed.plan === null);
  calls = 0;
  const apiFailure = await replan(
    input,
    {
      name: "api-error",
      async generate() {
        calls++;
        throw new Error("API failure");
      },
    },
    "live",
  );
  assert(!apiFailure.ok && calls === 3);
  const closed = structuredClone(context);
  closed.disruption.closedPlaceIds = ["dinner"];
  assert(validatePlan(closed, good).some((v) => v.code === "opening_hours"));
  const boundary = structuredClone(context);
  boundary.state.remainingBudget = good.events.reduce(
    (s, e) => s + e.estimatedCost,
    0,
  );
  assert(!validatePlan(boundary, good).some((v) => v.code === "budget"));
  assert.throws(() => buildContext({}), /./);
  const phuket = createDeterministicTestSnapshot();
  phuket.trip.destination = "test-city";
  phuket.state.currentLocation = "测试区域";
  phuket.itinerary = [
    {
      ...phuket.itinerary.find((item) => item.locked)!,
      id: "event-phuket-dinner",
      placeId: "custom-phuket-dinner",
      name: "测试城市晚餐预约",
      location: "测试区域",
    },
  ];
  const phuketInput = {
    snapshot: phuket,
    mode: "local" as const,
    request: {
      reason: "late" as const,
      freeText: "My ferry arrived late.",
      currentState: phuket.state,
      closedPlaceIds: [],
      variation: 0,
    },
    confirmation: {
      status: "confirmed" as const,
      confirmedAt: new Date().toISOString(),
    },
  };
  const phuketContext = buildContext(phuketInput);
  const phuketPlan = await new DeterministicTestPlanner().generate(phuketContext);
  assert.equal(validatePlan(phuketContext, phuketPlan).length, 0);
  assert(phuketContext.places.some((place) => place.id === "test-city-rest"));
  console.log("PASS generic destination with a user-entered fixed plan");
  const user = createStarterSnapshot();
  user.state = {
    ...user.state,
    currentTime: "11:00",
    currentLocation: "城市中心",
  };
  user.stateSources = {
    currentTime: "user",
    currentLocation: "user",
    weather: "unset",
    energyLevel: "unset",
    disruption: "unset",
  };
  user.itinerary = [event("shopping-center", "user-stop", "12:00", "13:00")];
  const closedOnly = {
    snapshot: user,
    mode: "local" as const,
    request: {
      reason: "closed" as const,
      freeText: "有个地方关门了",
      currentState: user.state,
      closedPlaceIds: [],
      variation: 0,
      stateSources: { ...user.stateSources, disruption: "user" as const },
    },
    confirmation: {
      status: "confirmed" as const,
      confirmedAt: new Date().toISOString(),
    },
  };
  assert.throws(
    () => buildContext({ ...closedOnly, confirmation: undefined }),
    /请先确认/,
  );
  const userContext = buildContext(closedOnly);
  assert.equal(userContext.state.currentTime, "11:00");
  assert.equal(userContext.state.weather, undefined);
  assert.equal(userContext.state.energyLevel, undefined);
  const userPlan = await new DeterministicTestPlanner().generate(userContext);
  assert(userPlan.events.length > 0);
  assert(userPlan.events.every((item) => item.startTime >= "11:00"));
  assert(userPlan.events.some((item) => item.startTime < "15:00"));
  const traced = await replan(
    closedOnly,
    new DeterministicTestPlanner(),
    "local",
  );
  assert(traced.ok);
  assert(
    traced.decisionTrace?.inputFacts.some(
      (fact) =>
        fact.field === "用户报告的变化" && fact.value === "有个地方关门了",
    ),
  );
  assert(
    traced.decisionTrace?.validationEvidence.every(
      (item) => item.status !== "failed",
    ),
  );
  assert.equal(
    traced.decisionTrace?.validationEvidence.find(
      (item) => item.check === "预算",
    )?.status,
    "not_checked",
  );
  const unknownCostInput = structuredClone(closedOnly);
  unknownCostInput.snapshot.itinerary[0].estimatedCostKnown = false;
  unknownCostInput.snapshot.state.remainingBudget = 1000;
  unknownCostInput.request.currentState.remainingBudget = 1000;
  const unknownCostResult = await replan(
    unknownCostInput,
    new DeterministicTestPlanner(),
    "local",
  );
  assert.equal(
    unknownCostResult.decisionTrace?.validationEvidence.find(
      (item) => item.check === "预算",
    )?.status,
    "not_checked",
  );
  console.log(
    "PASS user facts stay isolated from demo state and trace every plan",
  );
  const parsedItinerary = parseItineraryText(
    "10:00 城市博物馆，12:30 午餐，19:00 booked dinner",
    "测试城市",
    "城市中心",
  );
  assert.equal(parsedItinerary.length, 3);
  assert.equal(parsedItinerary[0].name, "城市博物馆");
  assert.equal(parsedItinerary[2].locked, true);
  console.log(
    "PASS natural-language itinerary parsing and locked reservation detection",
  );
  const mixedSnapshot = createStarterSnapshot();
  mixedSnapshot.state.currentTime = "11:00";
  mixedSnapshot.stateSources.currentTime = "system";
  const mixed = parseUnifiedInput(
    mixedSnapshot,
    "10:00 城市博物馆，12:30 午餐，19:00 booked dinner。现在下雨了，我在城市中心，希望保留晚餐。",
  );
  assert.equal(mixed.intent, "mixed");
  assert.equal(mixed.existingPlans.length, 3);
  assert(mixed.disruptions.some((item) => item.kind === "weather"));
  assert.equal(mixed.context.weather, "rain");
  assert.equal(mixed.context.currentLocation, "城市中心");
  assert.equal(mixed.context.currentTime, "11:00");
  assert(mixed.existingPlans.some((item) => item.locked));
  assert(mixed.constraints.some((item) => item.kind === "keep"));
  console.log("PASS mixed input splits plans, disruption, location and lock");
  const disruptionOnly = parseUnifiedInput(
    createStarterSnapshot(),
    "有个地方关门了",
  );
  assert(disruptionOnly.missingFacts.includes("existingPlans"));
  assert(disruptionOnly.missingFacts.includes("closedPlace"));
  assert.equal(disruptionOnly.context.weather, undefined);
  assert.equal(disruptionOnly.context.energyLevel, undefined);
  const planOnlyBase = createStarterSnapshot();
  planOnlyBase.state.currentLocation = "城市中心";
  planOnlyBase.stateSources.currentLocation = "user";
  const planOnly = parseUnifiedInput(
    planOnlyBase,
    "10:00 城市博物馆，12:30 午餐",
  );
  assert.equal(planOnly.intent, "create");
  assert(planOnly.missingFacts.includes("disruptionOrOptimize"));
  console.log("PASS partial inputs trigger only the necessary follow-up facts");

  const ambiguousSentence =
    "15:00 按摩，晚上预订了8点的游乐场，但是现在已经14点了，按摩需要1个小时，我还去吗？";
  const safeFallback = parseItineraryText(
    ambiguousSentence,
    "测试城市",
    "城市中心",
  );
  assert.equal(safeFallback.length, 0);
  const safeFallbackFacts = parseUnifiedInput(
    createStarterSnapshot(),
    ambiguousSentence,
  );
  assert.equal(safeFallbackFacts.context.currentTime, "14:00");
  assert.equal(safeFallbackFacts.existingPlans.length, 0);
  assert(safeFallbackFacts.parseWarnings.length > 0);
  const semantic = normalizeSemanticExtraction(
    createStarterSnapshot(),
    ambiguousSentence,
    {
      intent: "rescue",
      activities: [
        {
          role: "considering",
          name: "按摩",
          startTime: null,
          endTime: null,
          durationMinutes: 60,
          location: null,
          estimatedCost: null,
          locked: "no",
          sourceText: "按摩需要1个小时，我还去吗",
        },
        {
          role: "existing_plan",
          name: "游乐场",
          startTime: "20:00",
          endTime: null,
          durationMinutes: null,
          location: null,
          estimatedCost: null,
          locked: "yes",
          sourceText: "晚上预订了8点的游乐场",
        },
      ],
      disruptions: [
        {
          kind: "other",
          label: "询问是否仍适合去按摩",
          sourceText: "我还去吗",
        },
      ],
      constraints: [],
      context: {
        currentTime: { value: "14:00", sourceText: "现在已经14点了" },
        currentLocation: { value: null, sourceText: null },
        weather: { value: "rain", sourceText: "下雨" },
        energyLevel: { value: null, sourceText: null },
        remainingBudget: { value: null, sourceText: null },
      },
      question: "我还去按摩吗？",
      ambiguities: ["按摩的开始时间和地点尚未明确。"],
    },
    "fixture-model",
  );
  assert.equal(semantic.parser, "llm");
  assert.equal(semantic.context.currentTime, "14:00");
  assert.equal(semantic.context.weather, undefined);
  assert.equal(semantic.context.energyLevel, undefined);
  assert.equal(semantic.existingPlans.length, 0);
  assert.equal(semantic.activityMentions.length, 2);
  assert(
    semantic.activityMentions.some(
      (item) =>
        item.name === "游乐场" &&
        item.startTime === "20:00" &&
        item.locked === "yes",
    ),
  );
  assert(
    semantic.activityMentions.some(
      (item) =>
        item.name === "按摩" &&
        item.role === "considering" &&
        item.durationMinutes === 60 &&
        item.locked === "no",
    ),
  );
  assert(!semantic.activityMentions.some((item) => item.name === ambiguousSentence));
  assert(SEMANTIC_PARSER_PROMPT.includes("currentTime"));
  assert(SEMANTIC_PARSER_PROMPT.includes("nearest named activity"));
  const chineseContext = normalizeSemanticExtraction(
    createStarterSnapshot(),
    "现在14点，我在城市中心，下雨了。",
    {
      intent: "rescue",
      activities: [],
      disruptions: [
        { kind: "weather", label: "下雨", sourceText: "下雨了" },
      ],
      constraints: [],
      context: {
        currentTime: { value: "14:00", sourceText: "现在14点" },
        currentLocation: { value: "城市中心", sourceText: "我在城市中心" },
        weather: { value: "rain", sourceText: "下雨了" },
        energyLevel: { value: null, sourceText: null },
        remainingBudget: { value: null, sourceText: null },
      },
      question: null,
      ambiguities: [],
    },
    "fixture-model",
  );
  assert.equal(chineseContext.context.currentLocation, "城市中心");
  assert.equal(chineseContext.context.weather, "rain");
  console.log(
    "PASS ambiguous question keeps current time, duration and booking attached to separate facts",
  );

  const storage = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    key(index: number) {
      return [...storage.keys()][index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  };
  localStorage.setItem("travel-snapshot", JSON.stringify(legacyDemo));
  localStorage.setItem("travel-result-demo", JSON.stringify({ leaked: true }));
  const migrated = loadSession();
  assert.equal(migrated.snapshot.mode, "user");
  assert.equal(migrated.snapshot.itinerary.length, 0);
  assert.equal(migrated.pendingPlan, null);
  assert(localStorage.getItem(realSessionKey));
  const persisted = saveSession({
    ...migrated,
    rawInput: "真实行程草稿",
    flowStage: "RESCUE_INPUT",
  });
  assert.equal(loadSession().rawInput, "真实行程草稿");
  assert.equal(persisted.experienceMode, "real");
  console.log(
    "PASS legacy demo and result keys cannot enter the real v2 session",
  );
  console.log(
    "PASS schema, bounded regeneration, failure fallback, closure, exact budget and missing context",
  );
  console.log(
    "Validator, parser, state isolation and agent-loop checks passed.",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
