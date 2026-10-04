import { expect, test, type Page } from "@playwright/test";

const sessionKey = "travel-session-real-v4";
const date = new Date().toISOString().slice(0, 10);
const capturedAt = new Date().toISOString();

const profile = { id: "e2e-user", travelPace: "balanced", walkingTolerance: "medium" };
const trip = { id: "e2e-trip", destination: "上海", startDate: date, endDate: date };
const state = { currentDate: date, currentTime: "09:00", stateCapturedAt: capturedAt, currentLocation: "人民广场" };
const stateSources = { currentTime: "user", currentLocation: "user", weather: "unset", energyLevel: "unset", disruption: "user" };
const resolutionState = { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] };
const protectionPolicy = {
  source: "confirmed",
  kind: "generic",
  lockedFields: ["name", "startTime", "endTime", "duration", "location"],
  timeAnchor: "starts_at",
  durationPolicy: { mode: "fixed", defaultMinutes: 60, minMinutes: 60, maxMinutes: 60 },
  allowedStartTimes: ["10:00"],
  locationGranularity: "venue",
  transportKind: null,
  arrivalBuffer: null,
  locationNote: null,
};

const externalAuthRequestsByPage = new WeakMap<Page, string[]>();
test.beforeEach(async ({ context, page }) => {
  await context.addInitScript(() => {
    const testEnvironment = globalThis as typeof globalThis & {
      __COVEREDYOU_DISABLE_AUTH_FOR_TESTS__?: boolean;
    };
    testEnvironment.__COVEREDYOU_DISABLE_AUTH_FOR_TESTS__ = true;
  });
  page.on("pageerror", (error) => console.error("browser page error:", error.message));
  const externalAuthRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:3000" && url.pathname.includes("/auth/v1/")) {
      externalAuthRequests.push(request.url());
    }
  });
  externalAuthRequestsByPage.set(page, externalAuthRequests);
});
test.afterEach(async ({ page }) => {
  expect(externalAuthRequestsByPage.get(page) ?? [], "默认浏览器回归不得访问外部认证服务").toEqual([]);
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
  protectionPolicy,
};

const museumFact = {
  id: event.id,
  placeId: event.placeId,
  origin: "snapshot",
  snapshotEventId: event.id,
  role: "existing_plan",
  progress: "not_started",
  name: event.name,
  placeQuery: event.location,
  startTime: event.startTime,
  startTimeSource: "snapshot",
  endTime: event.endTime,
  durationMinutes: 60,
  durationSource: "user",
  commitment: "fixed",
  protectionPolicy,
  sourceText: null,
};

function messageFact(id: string, name: string, startTime: string, endTime: string, placeQuery: string) {
  return {
    id,
    placeId: `custom-${id}`,
    origin: "message",
    snapshotEventId: null,
    role: "existing_plan",
    progress: "not_started",
    name,
    placeQuery,
    startTime,
    startTimeSource: "user",
    endTime,
    durationMinutes: 60,
    durationSource: "user",
    commitment: "flexible",
    sourceText: `${startTime} ${name}`,
  };
}

function parsedInput(rawText = "下雨了，把下午行程调一下") {
  return {
    rawText,
    intent: "rescue",
    activityFacts: [],
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
    activityFacts: [museumFact],
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
    schemaVersion: 4,
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

function pendingPlanSession() {
  const base = ordinarySession().snapshot;
  const request = { reason: "weather", freeText: "下雨了", currentState: state, closedPlaceIds: [], variation: 0, stateSources, activityFacts: [museumFact], worldOptions: { selectedPois: {}, travelMode: "TRANSIT", allowedTravelModes: ["TRANSIT"] } };
  const current = { id: "current", city: "上海市", longitude: 121.47, latitude: 31.23, coordinateSystem: "GCJ02", source: "user", capturedAt, adcode: "310101" };
  const place = { poiId: "museum-poi", name: "城市博物馆", address: "城市博物馆", city: "上海市", district: "黄浦区", adcode: "310101", longitude: 121.49, latitude: 31.23, coordinateSystem: "GCJ02", type: "科教文化服务", source: "amap", fetchedAt: capturedAt, status: "available" };
  const world = { currentTime: { value: "09:00", date, source: "user", confirmedAt: capturedAt }, currentLocation: current, resolvedPlaces: [{ placeId: "museum-poi", poi: place }], alternatives: [], routes: [{ origin: current, destination: { ...place, id: "museum-poi" }, travelMode: "TRANSIT", distanceMeters: 2500, durationSeconds: 900, source: "amap", fetchedAt: capturedAt, status: "available" }], weather: { condition: "小雨", temperature: 20, humidity: 80, windDirection: null, windPower: null, forecast: [], source: "amap", fetchedAt: capturedAt, reportedAt: capturedAt, status: "available" }, dataFreshness: { groundedAt: capturedAt, routeMaxAgeSeconds: 120, locationMaxAgeSeconds: 600 }, missingWorldFacts: [], ambiguities: [], candidatePlaceIds: {}, travelMode: "TRANSIT", cityResolution: { city: "上海市", source: "current_location", evidence: [], conflicts: [] }, resolutionEvidence: [], status: "ready" };
  const plannedEvent = { ...event, travelMode: "TRANSIT", travelTimeFromPrevious: 15, reason: "保留固定预约" };
  const plan = { summary: "保留固定预约", explanation: "雨天只保留已确认安排。", events: [plannedEvent], movedEvents: [], removedEvents: [] };
  const context = { profile, trip, state, stateSources, activityFacts: [museumFact], remainingActivityFacts: [museumFact], protectedActivityFacts: [museumFact], disruption: request, places: [], travelMinutes: {}, world };
  const result = { id: "plan-1", ok: true, plan, attempts: [{ attempt: 1, durationMs: 10, violations: [] }], mode: "live", model: "e2e", message: "已通过当前可验证规则。", verificationLevel: "partial", context, candidatePlans: [{ id: "candidate-1", title: "推荐方案", tradeOff: "保留预约", feasible: true, plan, conflicts: [] }] };
  return { ...ordinarySession(), flowStage: "PLAN_READY", lastDisruption: request, pendingPlan: { result, base, request, accepted: false } };
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
        activityFacts: [messageFact("created", "城市博物馆", "10:00", "11:00", "城市博物馆")],
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
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(1);
  expect(stored.flowStage).toBe("HAS_ITINERARY");
  expect(stored.itineraryDraft).toBeNull();
  expect(stored.rawInput).toBe("");
  expect(stored.parsedInput).toBeNull();
  expect(stored.pendingInput).toBeNull();
  expect(stored.pendingPlan).toBeNull();
  expect(stored.conditionalAdvice).toBeNull();
});

test("仅保存行程保持原有清理范围和 flowStage", async ({ page }) => {
  const conditionalAdvice = { heading: "备用建议", suggestions: ["稍后再试"], warning: "当前仅保存行程" };
  const editable = {
    ...ordinarySession(),
    flowStage: "NEEDS_INPUT",
    rawInput: "保留城市博物馆安排",
    parsedInput: {
      ...parsedInput("保留城市博物馆安排"),
      activityFacts: [museumFact],
      disruptions: [],
    },
    conditionalAdvice,
  };
  await seed(page, editable);
  await page.goto("/rescue");
  await page.getByRole("button", { name: "先保存行程" }).click();
  await expect(page).toHaveURL(/\/trip$/);
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(2);
  expect(stored.flowStage).toBe("HAS_ITINERARY");
  expect(stored.itineraryDraft).toBeNull();
  expect(stored.pendingInput).toBeNull();
  expect(stored.rawInput).toBe("");
  expect(stored.parsedInput).toBeNull();
  expect(stored.pendingPlan).toBeNull();
  expect(stored.conditionalAdvice).toEqual(conditionalAdvice);
});

test("两个标签页基于同一 revision 保存时后提交者冲突", async ({ page, context }) => {
  await context.route("**/api/parse", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...parsedInput("10点去城市博物馆"),
        intent: "create",
        activityFacts: [messageFact("created", "城市博物馆", "10:00", "11:00", "城市博物馆")],
        disruptions: [],
        context: { ...state, currentLocation: "人民广场" },
        contextSources: { ...stateSources, disruption: "unset" },
        status: "draft",
      }),
    });
  });
  await seed(page);
  await page.goto("/onboarding");
  const secondPage = await context.newPage();
  await secondPage.goto("/onboarding");

  for (const candidate of [page, secondPage]) {
    await candidate.getByLabel("所在城市").fill("上海");
    await candidate.getByLabel("现在在哪儿").fill("人民广场");
    await candidate.getByLabel("你今天想怎么安排？").fill("10点去城市博物馆");
    await candidate.getByRole("button", { name: "整理这份行程" }).click();
    await expect(candidate.locator('input[id^="name-"]')).toHaveValue("城市博物馆");
  }

  await page.getByRole("button", { name: /开始今天的行程/ }).click();
  await expect(page).toHaveURL(/\/trip$/);
  await secondPage.getByRole("button", { name: /开始今天的行程/ }).click();
  await expect(secondPage.locator(".error-box")).toContainText("行程已在其他页面更新");
  const stored = await secondPage.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(2);
});

test("六个页面路由与既有会话键保持兼容", async ({ page }) => {
  await seed(page);
  for (const [path, heading] of [
    ["/", "发生了森么？"],
    ["/onboarding", "把今天的安排放进来。"],
    ["/trip", "今天，慢慢走"],
    ["/rescue", "我理解的是"],
    ["/result", "还没有待确认的方案。"],
    ["/me", "我的"],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveTitle(/coveredYou/);
    await expect(page.locator("header .brand")).toContainText("coveredYou");
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(1);
  expect(stored.snapshot.itinerary[0].id).toBe("museum");
});

test("原始输入统一显示剩余字数并在提交前阻止超限内容", async ({ page }) => {
  await seed(page);
  let assistCalls = 0;
  await page.route("**/api/assist", async (route) => {
    assistCalls += 1;
    await route.abort();
  });
  await page.goto("/");

  const homeInput = page.getByLabel("描述今天的安排和变化");
  await expect(homeInput).toHaveAttribute("maxlength", "4000");
  await expect(page.locator("#home-input-limit")).toHaveText("还可输入 4000 个字");
  const atLimit = "行".repeat(4000);
  await homeInput.fill(atLimit);
  await expect(page.locator("#home-input-limit")).toHaveText("还可输入 0 个字");

  const overLimit = `${atLimit}程`;
  await homeInput.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, overLimit);
  await expect(homeInput).toHaveValue(overLimit);
  await page.getByRole("button", { name: "帮我重新安排今天" }).click();
  await expect(page.locator(".error-box")).toContainText("输入最多 4000 个字，请删减后再提交。");
  expect(assistCalls).toBe(0);

  await page.goto("/onboarding");
  const itineraryInput = page.getByLabel("你今天想怎么安排？");
  await expect(itineraryInput).toHaveAttribute("maxlength", "4000");
  await expect(itineraryInput).toHaveValue(atLimit);
  await expect(page.locator("#itinerary-input-limit")).toHaveText("还可输入 0 个字");
});

test("rescue 修改原文和补充方案使用统一长度协议", async ({ page }) => {
  const baseRaw = "行".repeat(3998);
  const emptySnapshot = { ...ordinarySession().snapshot, itinerary: [] };
  await seed(page, {
    ...ordinarySession(),
    flowStage: "NEEDS_INPUT",
    snapshot: emptySnapshot,
    rawInput: baseRaw,
    parsedInput: parsedInput(baseRaw),
  });
  let parseCalls = 0;
  await page.route("**/api/parse", async (route) => {
    parseCalls += 1;
    await route.abort();
  });
  await page.goto("/rescue");

  const replacementInput = page.locator("#rescue-sentence");
  await expect(replacementInput).toHaveAttribute("maxlength", "4000");
  await expect(page.locator("#rescue-sentence-limit")).toHaveText("还可输入 2 个字");

  const supplementalInput = page.locator("#missing-plans");
  await expect(supplementalInput).toBeVisible();
  await expect(supplementalInput).toHaveAttribute("maxlength", "1");
  await expect(page.locator("#missing-plans-limit")).toHaveText("还可输入 1 个字");
  await supplementalInput.evaluate((element) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, "安排");
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(supplementalInput).toHaveValue("安排");
  await page.getByRole("button", { name: "识别补充安排" }).click();
  await expect(page.locator(".error-box").last()).toContainText("输入最多 4000 个字，请删减后再提交。");
  expect(parseCalls).toBe(0);
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "OUT_OF_SCOPE", message: "测试结束，原行程没有改变。", parsedInput: parsedInput(), impactAnalysis: { completedActivities: [], preservedActivities: ["museum"], affectedActivities: [], modifiedActivities: [], removedActivities: [], riskActivities: [], lockedActivities: ["museum"], replacementCandidates: [], availableTimeWindows: [] }, resolutionState: candidateState }) });
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
  await page.route("**/api/assist", async (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ status: "UPSTREAM_UNAVAILABLE", message: "路线服务暂时不可用，请稍后重试。", failure: { code: "MAP_NETWORK_ERROR", stage: "GROUNDING", retryable: true, traceId: "e2e-map-network" } }) }));
  await page.goto("/");
  await page.getByLabel("描述今天的安排和变化").fill("下雨了，请调整下午行程");
  await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
  await expect(page.locator(".error-box")).toContainText("路线服务暂时不可用");
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(1);
  expect(stored.snapshot.itinerary).toHaveLength(1);
});

for (const authFailure of [
  {
    label: "达到调用额度",
    httpStatus: 429,
    status: "RATE_LIMITED",
    message: "操作有些频繁，请在 18 秒后重试。",
    failure: { code: "RATE_LIMITED", stage: "AUTH", retryable: true, traceId: "e2e-rate-limit", retryAfterSeconds: 18 },
  },
  {
    label: "身份服务不可用",
    httpStatus: 503,
    status: "UPSTREAM_UNAVAILABLE",
    message: "会话服务暂时不可用，请稍后重试。",
    failure: { code: "AUTH_PROVIDER_ERROR", stage: "AUTH", retryable: true, traceId: "e2e-auth-provider" },
  },
] as const) {
  test(`${authFailure.label}时保留输入和业务状态`, async ({ page }) => {
    await seed(page);
    await page.route("**/api/assist", async (route) => route.fulfill({
      status: authFailure.httpStatus,
      contentType: "application/json",
      headers: authFailure.httpStatus === 429 ? { "Retry-After": "18" } : undefined,
      body: JSON.stringify({
        status: authFailure.status,
        message: authFailure.message,
        failure: authFailure.failure,
      }),
    }));
    await page.goto("/");
    const input = page.getByLabel("描述今天的安排和变化");
    await input.fill("下雨了，请保留晚餐预约并调整下午行程");
    await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
    await expect(page.locator(".error-box")).toContainText(authFailure.message);
    await expect(input).toHaveValue("下雨了，请保留晚餐预约并调整下午行程");
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
    expect(stored.flowStage).toBe("HAS_ITINERARY");
    expect(stored.rawInput).toBe("下雨了，请保留晚餐预约并调整下午行程");
    expect(stored.snapshot.revision).toBe(1);
    expect(stored.snapshot.itinerary).toHaveLength(1);
  });
}

for (const responseKind of ["html", "empty", "truncated"] as const) {
  const responseLabel = responseKind === "html" ? "HTML" : responseKind === "empty" ? "空" : "截断 JSON";
  test(`故障注入：${responseLabel}响应不泄露技术异常`, async ({ page }) => {
    await seed(page);
    await page.route("**/api/assist", async (route) => route.fulfill({
      status: 502,
      contentType: responseKind === "html" ? "text/html" : "application/json",
      body: responseKind === "html" ? "<html><body>Unexpected token internal stack</body></html>" : responseKind === "truncated" ? '{"status":' : "",
    }));
    await page.goto("/");
    const input = page.getByLabel("描述今天的安排和变化");
    await input.fill("下雨了，请调整下午行程");
    await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
    await expect(page.locator(".error-box")).toContainText("服务暂时返回异常");
    await expect(page.locator(".error-box")).not.toContainText("Unexpected token");
    await expect(input).toHaveValue("下雨了，请调整下午行程");
    await expect(page.getByRole("button", { name: /帮我重新安排今天/ })).toBeEnabled();
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
    expect(stored.snapshot.revision).toBe(1);
    expect(stored.snapshot.itinerary).toHaveLength(1);
  });
}

test("故障注入 C1：合法 JSON null 按结构异常处理", async ({ page }) => {
  await seed(page);
  await page.route("**/api/assist", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));
  await page.goto("/");
  const input = page.getByLabel("描述今天的安排和变化");
  await input.fill("下雨了，请调整下午行程");
  await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
  await expect(page.locator(".error-box")).toContainText("服务暂时返回异常");
  await expect(page.locator(".error-box")).not.toContainText(/TypeError|Cannot read|status/);
  await expect(input).toHaveValue("下雨了，请调整下午行程");
  await expect(page.getByRole("button", { name: /帮我重新安排今天/ })).toBeEnabled();
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(1);
  expect(stored.pendingPlan).toBeNull();
});

test("故障注入 C3：parse 成功响应结构错误不能进入创建流程", async ({ page }) => {
  await page.route("**/api/parse", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parser: "llm" }) }));
  await page.goto("/onboarding");
  await page.getByLabel("所在城市").fill("上海");
  const input = page.getByLabel("你今天想怎么安排？");
  await input.fill("10点去城市博物馆");
  await page.getByRole("button", { name: "整理这份行程" }).click();
  await expect(page.locator(".error-box")).toContainText("服务暂时返回异常");
  await expect(input).toHaveValue("10点去城市博物馆");
  await expect(page.locator('.stop-editor input[id^="name-"]')).toHaveCount(0);
});

for (const [label, body] of [
  ["数组", "[]"],
  ["字符串", '"text"'],
  ["数字", "123"],
  ["布尔值", "true"],
] as const) {
  test(`故障注入 C2：${label}不能冒充 assist 对象`, async ({ page }) => {
    await seed(page);
    await page.route("**/api/assist", async (route) => route.fulfill({ status: 200, contentType: "application/json", body }));
    await page.goto("/");
    const input = page.getByLabel("描述今天的安排和变化");
    await input.fill("下雨了，请调整下午行程");
    await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
    await expect(page.locator(".error-box")).toContainText("服务暂时返回异常");
    await expect(input).toHaveValue("下雨了，请调整下午行程");
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
    expect(stored.snapshot.revision).toBe(1);
  });
}

for (const [label, body] of [
  ["空对象", {}],
  ["未知状态", { status: "SOMETHING_ELSE" }],
  ["READY 缺结果", { status: "READY", parsedInput: parsedInput() }],
  ["NEEDS_INPUT 缺可提交问题", { status: "NEEDS_INPUT", parsedInput: parsedInput() }],
] as const) {
  test(`故障注入 C3/C4：${label}不能进入业务流程`, async ({ page }) => {
    await seed(page);
    await page.route("**/api/assist", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
    await page.goto("/");
    const input = page.getByLabel("描述今天的安排和变化");
    await input.fill("下雨了，请调整下午行程");
    await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
    await expect(page.locator(".error-box")).toContainText("服务暂时返回异常");
    await expect(page).toHaveURL(/\/$/);
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
    expect(stored.snapshot.revision).toBe(1);
    expect(stored.pendingPlan).toBeNull();
  });
}

test("故障注入：连接失败后保留输入并恢复操作", async ({ page }) => {
  await seed(page);
  await page.route("**/api/assist", async (route) => route.abort("failed"));
  await page.goto("/");
  const input = page.getByLabel("描述今天的安排和变化");
  await input.fill("下雨了，请调整下午行程");
  await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
  await expect(page.locator(".error-box")).toContainText("服务暂时无法连接");
  await expect(input).toHaveValue("下雨了，请调整下午行程");
  await expect(page.getByRole("button", { name: /帮我重新安排今天/ })).toBeEnabled();
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(1);
});

test("故障注入：取消请求不显示技术错误或迟到保存", async ({ page }) => {
  await seed(page);
  await page.route("**/api/assist", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "OUT_OF_SCOPE", message: "迟到响应不应生效" }),
    }).catch(() => undefined);
  });
  await page.goto("/");
  const input = page.getByLabel("描述今天的安排和变化");
  await input.fill("下雨了，请调整下午行程");
  await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.locator(".error-box")).toHaveCount(0);
  await expect(input).toHaveValue("下雨了，请调整下午行程");
  await expect(page.getByRole("button", { name: /帮我重新安排今天/ })).toBeEnabled();
  await page.waitForTimeout(1400);
  await expect(page).toHaveURL(/\/$/);
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(1);
  expect(stored.pendingPlan).toBeNull();
});

test("故障注入 C8：响应头返回后读取正文时取消仍保持静默", async ({ page }) => {
  await seed(page);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/api/assist")) return originalFetch(input, init);
      const response = {
        ok: true,
        status: 200,
        text: () => new Promise<string>((_resolve, reject) => {
          const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }),
      };
      return Promise.resolve(response as Response);
    }) as typeof window.fetch;
  });
  await page.goto("/");
  const input = page.getByLabel("描述今天的安排和变化");
  await input.fill("下雨了，请调整下午行程");
  await page.getByRole("button", { name: /帮我重新安排今天/ }).click();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.locator(".error-box")).toHaveCount(0);
  await expect(input).toHaveValue("下雨了，请调整下午行程");
  await expect(page.getByRole("button", { name: /帮我重新安排今天/ })).toBeEnabled();
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(1);
  expect(stored.pendingPlan).toBeNull();
});

for (const invalidOk of ["false", 1] as const) {
  test(`故障注入 C5：validate ok=${JSON.stringify(invalidOk)} 不得保存`, async ({ page }) => {
    await seed(page, pendingPlanSession());
    await page.route("**/api/validate", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: invalidOk }) }));
    await page.goto("/result");
    await page.getByRole("button", { name: /接受方案/ }).click();
    await expect(page.locator(".error-box")).toContainText("服务暂时返回异常");
    await expect(page).toHaveURL(/\/result$/);
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
    expect(stored.snapshot.revision).toBe(1);
    expect(stored.pendingPlan).not.toBeNull();
  });
}

test("复验服务超时保留待接受方案并显示可重试提示", async ({ page }) => {
  await seed(page, pendingPlanSession());
  await page.route("**/api/validate", async (route) => route.fulfill({
    status: 504,
    contentType: "application/json",
    body: JSON.stringify({
      status: "UPSTREAM_UNAVAILABLE",
      message: "本次处理时间较长，请重试。",
      failure: { code: "MAP_TIMEOUT", stage: "GROUNDING", retryable: true, traceId: "e2e-map-timeout" },
    }),
  }));
  await page.goto("/result");
  await page.getByRole("button", { name: /接受方案/ }).click();
  await expect(page.locator(".error-box")).toContainText("本次处理时间较长，请重试");
  await expect(page).toHaveURL(/\/result$/);
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(1);
  expect(stored.pendingPlan).not.toBeNull();
});

test("主动取消复验保持静默并保留待接受方案", async ({ page }) => {
  await seed(page, pendingPlanSession());
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/api/validate")) return originalFetch(input, init);
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }) as typeof window.fetch;
  });
  await page.goto("/result");
  await page.getByRole("button", { name: /接受方案/ }).click();
  await page.getByRole("button", { name: "取消复验" }).click();
  await expect(page.locator(".error-box")).toHaveCount(0);
  await expect(page).toHaveURL(/\/result$/);
  await expect(page.getByRole("button", { name: /接受方案/ })).toBeEnabled();
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(1);
  expect(stored.pendingPlan).not.toBeNull();
});

test("接受方案前复验成功后才更新 revision", async ({ page }) => {
  const conditionalAdvice = { heading: "旧建议", suggestions: ["保留用于行为兼容"], warning: "接受后仍保留" };
  await seed(page, { ...pendingPlanSession(), conditionalAdvice });
  await page.route("**/api/validate", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, violations: [] }) }));
  await page.goto("/result");
  const acceptButton = page.getByRole("button", { name: /接受方案/ });
  await expect(acceptButton).toBeVisible();
  await acceptButton.click();
  await expect(page).toHaveURL(/\/trip$/);
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(2);
  expect(stored.flowStage).toBe("HAS_ITINERARY");
  expect(stored.itineraryDraft).toBeNull();
  expect(stored.pendingInput).toBeNull();
  expect(stored.rawInput).toBe("");
  expect(stored.parsedInput).toBeNull();
  expect(stored.pendingPlan).toBeNull();
  expect(stored.lastDisruption).toEqual(pendingPlanSession().lastDisruption);
  expect(stored.conditionalAdvice).toEqual(conditionalAdvice);
});

test("过期 pending plan 不能接受", async ({ page }) => {
  const stale = pendingPlanSession();
  await seed(page, { ...stale, snapshot: { ...stale.snapshot, revision: 2 } });
  let validateCalls = 0;
  await page.route("**/api/validate", async (route) => {
    validateCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, violations: [] }) });
  });
  await page.goto("/result");
  await page.getByRole("button", { name: /接受方案/ }).click();
  await expect(page.locator(".error-box")).toContainText("原行程已发生变化");
  expect(validateCalls).toBe(0);
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(stored.snapshot.revision).toBe(2);
  expect(stored.pendingPlan).not.toBeNull();
});

test("确认时间超过五分钟的方案不能进入复验", async ({ page }) => {
  const stale = pendingPlanSession();
  if (!stale.pendingPlan.result.context.world) throw new Error("测试方案缺少真实世界上下文");
  stale.pendingPlan.result.context.world.currentTime.confirmedAt = new Date(Date.now() - 5 * 60 * 1000 - 1).toISOString();
  await seed(page, stale);
  let validateCalls = 0;
  await page.route("**/api/validate", async (route) => {
    validateCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, violations: [] }) });
  });
  await page.goto("/result");
  await page.getByRole("button", { name: /接受方案/ }).click();
  await expect(page.locator(".error-box")).toContainText("距离确认时间较久");
  expect(validateCalls).toBe(0);
});
