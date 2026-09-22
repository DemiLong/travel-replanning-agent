import { expect, test, type Page } from "@playwright/test";

const sessionKey = "travel-session-real-v3";
const date = new Date().toISOString().slice(0, 10);
const capturedAt = new Date().toISOString();

const profile = { id: "e2e-user", travelPace: "balanced", walkingTolerance: "medium" };
const trip = { id: "e2e-trip", destination: "上海", startDate: date, endDate: date };
const state = { currentDate: date, currentTime: "09:00", stateCapturedAt: capturedAt, currentLocation: "人民广场" };
const stateSources = { currentTime: "user", currentLocation: "user", weather: "unset", energyLevel: "unset", disruption: "user" };
const resolutionState = { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] };

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("browser page error:", error.message));
});
const event = {
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
};

function parsedInput(rawText = "下雨了，把下午行程调一下") {
  return {
    rawText,
    intent: "rescue",
    existingPlans: [],
    activityMentions: [],
    disruptions: [{ kind: "weather", label: "下雨", source: "user" }],
    constraints: [],
    context: state,
    contextSources: stateSources,
    closedPlaceIds: [],
    missingFacts: [],
    status: "confirmed",
    parser: "manual",
    parserModel: null,
    parseWarnings: [],
    worldOptions: { selectedPois: {}, travelMode: "TRANSIT", allowedTravelModes: ["TRANSIT"] },
  };
}

function confirmedDraft(rawText = "下雨了，把下午行程调一下") {
  return {
    rawText,
    intent: "rescue",
    existingPlans: [{ id: event.id, placeId: event.placeId, name: event.name, startTime: event.startTime, endTime: event.endTime, durationMinutes: 60, location: event.location, locked: true }],
    activityMentions: [],
    disruptions: [{ kind: "weather", label: "下雨", source: "user" }],
    constraints: [],
    context: state,
    contextSources: stateSources,
    closedPlaceIds: [],
    question: null,
    worldOptions: { selectedPois: {}, travelMode: "TRANSIT", allowedTravelModes: ["TRANSIT"] },
    removedLockedIds: [],
    baseRevision: 1,
  };
}

function ordinarySession() {
  return {
    schemaVersion: 3,
    experienceMode: "real",
    flowStage: "HAS_ITINERARY",
    snapshot: { mode: "user", profile, trip, state, stateSources, itinerary: [event], revision: 1 },
    rawInput: "",
    parsedInput: null,
    lastDisruption: null,
    pendingPlan: null,
    resolutionState,
    updatedAt: capturedAt,
  };
}

async function seed(page: Page, value: unknown = ordinarySession()) {
  await page.addInitScript(({ key, session }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(session));
  }, { key: sessionKey, session: value });
}

test("首次创建只保存单日正式行程", async ({ page }) => {
  await page.route("**/api/parse", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...parsedInput("10点去城市博物馆"),
        intent: "create",
        existingPlans: [{ id: "created", name: "城市博物馆", startTime: "10:00", endTime: "11:00", durationMinutes: 60, location: "城市博物馆", locked: false, source: "user" }],
        disruptions: [],
        context: { ...state, currentLocation: "人民广场" },
        contextSources: { ...stateSources, disruption: "unset" },
        status: "draft",
      }),
    });
  });
  await page.goto("/onboarding");
  await page.getByLabel("所在城市").fill("上海");
  await page.getByLabel("现在在哪儿").fill("人民广场");
  await page.getByLabel("你今天想怎么安排？").fill("10点去城市博物馆");
  await page.getByRole("button", { name: "整理这份行程" }).click();
  await expect(page.locator('input[id^="name-"]')).toHaveValue("城市博物馆");
  await page.getByRole("button", { name: /开始今天的行程/ }).click();
  await expect(page).toHaveURL(/\/trip$/);
  await expect(page.getByText("城市博物馆").first()).toBeVisible();
});

test("地点候选只作为当前 blocker 的字段答案提交", async ({ page }) => {
  await seed(page);
  const candidateState = { currentBlockerKey: "museum-poi", sameBlockerCount: 1, roundCount: 1, answeredFields: [], questionHistory: ["museum-poi"] };
  let requestCount = 0;
  let continuation: Record<string, unknown> | undefined;
  await page.route("**/api/assist", async (route) => {
    requestCount += 1;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (requestCount === 1) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "NEEDS_INPUT", parsedInput: parsedInput(), confirmedDraft: confirmedDraft(), impactAnalysis: { completedActivities: [], preservedActivities: ["museum"], affectedActivities: [], modifiedActivities: [], removedActivities: [], riskActivities: [], lockedActivities: ["museum"], replacementCandidates: [], availableTimeWindows: [] }, resolutionState: candidateState, missingFact: { key: "museum-poi", field: "museum-poi", importance: "blocking", reason: "请选择地点", question: "你指的是哪一个城市博物馆？", answerType: "poi", candidates: [{ value: "poi-1", label: "城市博物馆东馆", description: "浦东新区" }, { value: "poi-2", label: "城市博物馆西馆", description: "黄浦区" }] } }) });
    } else {
      continuation = body;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "OUT_OF_SCOPE", error: "测试结束，原行程没有改变。", retryable: false, parsedInput: parsedInput(), impactAnalysis: { completedActivities: [], preservedActivities: ["museum"], affectedActivities: [], modifiedActivities: [], removedActivities: [], riskActivities: [], lockedActivities: ["museum"], replacementCandidates: [], availableTimeWindows: [] }, resolutionState: candidateState }) });
    }
  });
  await page.goto("/");
  await page.getByLabel("描述今天的安排和变化").fill("下雨了，把下午行程调一下");
  await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
  await expect(page.getByText("你指的是哪一个城市博物馆？")).toBeVisible();
  await page.getByRole("button", { name: /城市博物馆东馆/ }).click();
  await expect(page.locator(".error-box")).toContainText("原行程没有改变");
  expect(continuation?.rawText).toBeUndefined();
  expect(continuation?.answer).toEqual({ kind: "poi", field: "museum-poi", poiId: "poi-1" });
});

test("上游失败保留正式行程并提供可行动错误", async ({ page }) => {
  await seed(page);
  await page.route("**/api/assist", async (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ status: "UPSTREAM_UNAVAILABLE", failedStage: "GROUNDING", retryable: true, error: "路线服务暂时不可用，请稍后重试。" }) }));
  await page.goto("/");
  await page.getByLabel("描述今天的安排和变化").fill("下雨了，请调整下午行程");
  await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
  await expect(page.locator(".error-box")).toContainText("路线服务暂时不可用");
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(1);
  expect(stored.snapshot.itinerary).toHaveLength(1);
});

test("接受方案前复验成功后才更新 revision", async ({ page }) => {
  const base = ordinarySession().snapshot;
  const request = { reason: "weather", freeText: "下雨了", currentState: state, closedPlaceIds: [], variation: 0, stateSources, worldOptions: { selectedPois: {}, travelMode: "TRANSIT", allowedTravelModes: ["TRANSIT"] } };
  const current = { id: "current", city: "上海市", longitude: 121.47, latitude: 31.23, coordinateSystem: "GCJ02", source: "user", capturedAt, adcode: "310101" };
  const place = { poiId: "museum-poi", name: "城市博物馆", address: "城市博物馆", city: "上海市", district: "黄浦区", adcode: "310101", longitude: 121.49, latitude: 31.23, coordinateSystem: "GCJ02", type: "科教文化服务", source: "amap", fetchedAt: capturedAt, status: "available" };
  const world = { currentTime: { value: "09:00", date, source: "user", confirmedAt: capturedAt }, currentLocation: current, resolvedPlaces: [{ placeId: "museum-poi", poi: place }], alternatives: [], routes: [{ origin: current, destination: { ...place, id: "museum-poi" }, travelMode: "TRANSIT", distanceMeters: 2500, durationSeconds: 900, source: "amap", fetchedAt: capturedAt, status: "available" }], weather: { condition: "小雨", temperature: 20, humidity: 80, windDirection: null, windPower: null, forecast: [], source: "amap", fetchedAt: capturedAt, reportedAt: capturedAt, status: "available" }, dataFreshness: { groundedAt: capturedAt, routeMaxAgeSeconds: 120, locationMaxAgeSeconds: 600 }, missingWorldFacts: [], ambiguities: [], candidatePlaceIds: {}, travelMode: "TRANSIT", cityResolution: { city: "上海市", source: "current_location", evidence: [], conflicts: [] }, resolutionEvidence: [], status: "ready" };
  const plannedEvent = { ...event, travelMode: "TRANSIT", travelTimeFromPrevious: 15, reason: "保留固定预约" };
  const plan = { summary: "保留固定预约", explanation: "雨天只保留已确认安排。", events: [plannedEvent], movedEvents: [], removedEvents: [] };
  const context = { profile, trip, state, stateSources, existingItinerary: [event], lockedEvents: [event], remainingEvents: [event], disruption: request, places: [], travelMinutes: {}, world };
  const result = { id: "plan-1", ok: true, plan, attempts: [{ attempt: 1, durationMs: 10, violations: [] }], mode: "live", model: "e2e", message: "已通过当前可验证规则。", verificationLevel: "partial", context, candidatePlans: [{ id: "candidate-1", title: "推荐方案", tradeOff: "保留预约", feasible: true, plan, conflicts: [] }] };
  const session = { ...ordinarySession(), flowStage: "PLAN_READY", lastDisruption: request, pendingPlan: { result, base, request, accepted: false } };
  await seed(page, session);
  await page.route("**/api/validate", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, violations: [] }) }));
  await page.goto("/result");
  await expect(page.getByText("保留固定预约").first()).toBeVisible();
  await page.getByRole("button", { name: /接受方案/ }).click();
  await expect(page).toHaveURL(/\/trip$/);
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(2);
  expect(stored.pendingPlan).toBeNull();
});
