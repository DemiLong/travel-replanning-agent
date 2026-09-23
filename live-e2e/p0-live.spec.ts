import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const sessionKey = "travel-session-real-v3";
const evidenceDirectory = path.resolve("work", "p0-live-evidence");
const defectEvidenceDirectory = path.resolve("work", "three-defect-live-evidence");

type AssistBody = {
  status?: string;
  failedStage?: string;
  error?: string;
  missingFact?: { key?: string; question?: string; answerType?: string };
  parsedInput?: {
    existingPlans?: Array<{ id?: string; name?: string; startTime?: string; endTime?: string | null; durationSource?: string; location?: string; locked?: boolean }>;
    activityMentions?: Array<{ id?: string; name?: string; startTime?: string | null; location?: string | null; role?: string }>;
  };
  confirmedDraft?: {
    existingPlans?: Array<{ id?: string; name?: string; startTime?: string; endTime?: string | null; durationSource?: string; location?: string; locked?: boolean }>;
    activityMentions?: Array<{ id?: string; name?: string; startTime?: string | null; location?: string | null; role?: string }>;
  };
  base?: { revision?: number; itinerary?: Array<{ id?: string; placeId?: string; name?: string; startTime?: string; endTime?: string; durationSource?: string; locked?: boolean }> };
  result?: { ok?: boolean; model?: string; plan?: { events?: Array<{ id?: string; name?: string; startTime?: string }> } };
};

type ParseBody = {
  parser?: string;
  parserModel?: string | null;
  existingPlans?: Array<{ id?: string; name?: string; startTime?: string; location?: string }>;
  activityMentions?: Array<{ id?: string; name?: string; role?: string; startTime?: string | null; location?: string | null }>;
  disruptions?: Array<{ kind?: string; label?: string }>;
  question?: string | null;
};

async function assistRequest(page: Page, action: () => Promise<void>) {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/assist") && response.request().method() === "POST",
    { timeout: 45_000 },
  );
  await action();
  const response = await responsePromise;
  const text = await response.text();
  return JSON.parse(text) as AssistBody;
}

function answerFor(body: AssistBody) {
  const key = body.missingFact?.key ?? "";
  const question = body.missingFact?.question ?? "";
  if (key === "currentLocation") return "人民广场(地铁站)";
  if (key === "destination") return "上海";
  if (/酒店/.test(question)) return "上海和平饭店";
  if (/印暨/.test(question)) return "印暨小馆";
  if (/金鹏/.test(question)) return "金鹏老友粉";
  if (/小蛮腰|广州塔/.test(question)) return "广州塔";
  if (/外滩/.test(question) && /几点|时间/.test(question)) return "18:00";
  if (/国金|金融中心/.test(question) && /几点|时间/.test(question)) return "15:00";
  if (/几点|时间/.test(question)) return "15:00";
  return "人民广场(地铁站)";
}

async function continueHomeFlow(page: Page, first: AssistBody) {
  const bodies = [first];
  let current = first;
  for (let round = 0; round < 3 && current.status === "NEEDS_INPUT"; round += 1) {
    await expect(page.locator(".follow-up-card")).toBeVisible();
    const candidates = page.locator(".follow-up-card .poi-option");
    if (await candidates.count()) {
      current = await assistRequest(page, async () => candidates.first().click());
    } else {
      const input = page.locator(".follow-up-card input");
      await input.fill(answerFor(current));
      current = await assistRequest(page, async () => page.getByRole("button", { name: "继续安排今天" }).click());
    }
    bodies.push(current);
  }
  if (current.status === "READY") {
    await page.waitForURL(/\/result$/, { timeout: 20_000 });
  }
  return bodies;
}

function responseSummary(body: AssistBody) {
  return {
    status: body.status,
    failedStage: body.failedStage,
    error: body.error,
    blocker: body.missingFact,
    parsedActivities: [
      ...(body.parsedInput?.existingPlans ?? []),
      ...(body.parsedInput?.activityMentions ?? []),
    ].map((item) => ({ id: item.id, name: item.name, startTime: item.startTime, location: item.location, role: "role" in item ? item.role : "existing_plan" })),
    draftActivities: [
      ...(body.confirmedDraft?.existingPlans ?? []),
      ...(body.confirmedDraft?.activityMentions ?? []),
    ].map((item) => ({ id: item.id, name: item.name, startTime: item.startTime, location: item.location })),
    baseRevision: body.base?.revision,
    baseActivities: body.base?.itinerary?.map((item) => ({ id: item.id, name: item.name, startTime: item.startTime, locked: item.locked })),
    planner: body.result ? { ok: body.result.ok, model: body.result.model, eventCount: body.result.plan?.events?.length ?? 0 } : undefined,
  };
}

async function saveEvidence(name: string, page: Page, payload: unknown) {
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDirectory, `${name}.png`), fullPage: true });
  await writeFile(
    path.join(evidenceDirectory, `${name}.json`),
    JSON.stringify({ testedAt: new Date().toISOString(), timezone: "Asia/Shanghai", ...payload as object }, null, 2),
    "utf8",
  );
}

async function saveDefectEvidence(name: string, page: Page, payload: unknown) {
  await mkdir(defectEvidenceDirectory, { recursive: true });
  await page.screenshot({ path: path.join(defectEvidenceDirectory, `${name}.png`), fullPage: true });
  await writeFile(
    path.join(defectEvidenceDirectory, `${name}.json`),
    JSON.stringify({ testedAt: new Date().toISOString(), timezone: "Asia/Shanghai", ...payload as object }, null, 2),
    "utf8",
  );
}

async function parseThroughBrowser(page: Page, rawText: string) {
  await page.goto("/");
  const result = await page.evaluate(async ({ key, text }) => {
    const session = JSON.parse(localStorage.getItem(key) ?? "null");
    const response = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot: session.snapshot, rawText: text }),
    });
    return { status: response.status, body: await response.json() };
  }, { key: sessionKey, text: rawText });
  return result as { status: number; body: ParseBody };
}

async function reviewedPoiChoice(page: Page, question: string) {
  const candidates = page.locator(".follow-up-card .poi-option");
  const count = await candidates.count();
  expect(count).toBeGreaterThan(0);
  let selected = candidates.first();
  if (/国金|金融中心/.test(question)) {
    const exact = candidates.filter({ hasText: /上海ifc商场.*世纪大道8号|国际金融中心.*世纪大道8号/i }).first();
    if (await exact.count()) selected = exact;
  } else if (/外滩/.test(question)) {
    const exact = candidates.filter({ hasText: /外滩.*中山东一路/ }).first();
    if (await exact.count()) selected = exact;
  }
  const selectedText = (await selected.innerText()).replace(/\s+/g, " ").trim();
  const body = await assistRequest(page, async () => selected.click());
  return { body, selectedText };
}

async function continueReviewedFlow(page: Page, first: AssistBody) {
  const bodies = [first];
  const answers: string[] = [];
  let current = first;
  for (let round = 0; round < 3 && current.status === "NEEDS_INPUT"; round += 1) {
    await expect(page.locator(".follow-up-card")).toBeVisible();
    const candidates = page.locator(".follow-up-card .poi-option");
    if (await candidates.count()) {
      const selected = await reviewedPoiChoice(page, current.missingFact?.question ?? "");
      answers.push(selected.selectedText);
      current = selected.body;
    } else {
      const value = answerFor(current);
      answers.push(value);
      await page.locator(".follow-up-card input").fill(value);
      current = await assistRequest(page, async () => page.getByRole("button", { name: "继续安排今天" }).click());
    }
    bodies.push(current);
  }
  if (current.status === "READY") await page.waitForURL(/\/result$/, { timeout: 20_000 });
  return { bodies, answers };
}

async function createSavedTrip(page: Page, lockedFirst = false) {
  await page.goto("/onboarding");
  await page.getByLabel("所在城市").fill("上海");
  await page.getByLabel("现在大概几点").fill("13:00");
  await page.getByLabel("现在在哪儿").fill("上海人民广场");
  await page.getByLabel("你今天想怎么安排？").fill("我已经确定今天15:00去上海国金中心，18:00去外滩，这两项都是原定安排。");
  const parseResponse = page.waitForResponse((response) => response.url().includes("/api/parse") && response.request().method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name: "整理这份行程" }).click();
  expect((await parseResponse).ok()).toBeTruthy();
  await expect(page.locator('.stop-editor input[id^="name-"]')).toHaveCount(2, { timeout: 20_000 });
  const lockedCheckboxes = page.getByRole("checkbox");
  await expect(lockedCheckboxes).toHaveCount(2);
  await lockedCheckboxes.nth(0).setChecked(lockedFirst);
  await lockedCheckboxes.nth(1).setChecked(false);
  await page.getByRole("button", { name: /开始今天的行程/ }).click();
  await expect(page).toHaveURL(/\/trip$/);
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
}

test("P0-01 真实原句识别并保留三项活动", async ({ page }) => {
  await page.goto("/");
  const rawText = "现在下雨了，我想3点去印暨小馆喝咖啡的，然后6点去吃金鹏老友粉，晚上8点去看小蛮腰，还来得及全部做这些事吗？";
  await page.getByLabel("描述今天的安排和变化").fill(rawText);
  const first = await assistRequest(page, async () => page.getByRole("button", { name: /帮我重新安排今天/ }).click());
  console.log("P0-01 first response", JSON.stringify(responseSummary(first)));
  const activities = [
    ...(first.confirmedDraft?.existingPlans ?? []),
    ...(first.confirmedDraft?.activityMentions ?? []),
  ];
  expect(activities).toHaveLength(3);
  expect(activities.map((item) => item.startTime)).toEqual(["15:00", "18:00", "20:00"]);
  const bodies = await continueHomeFlow(page, first);
  await saveEvidence("01-original-input-run-1", page, {
    category: "真实浏览器/真实后端/真实 DeepSeek 与按需高德",
    input: rawText,
    responses: bodies.map(responseSummary),
    finalUrl: page.url(),
  });
});

test("P0-01 第二次独立真实运行仍保留三项活动", async ({ page }) => {
  await page.goto("/");
  const rawText = "现在下雨了，我想3点去印暨小馆喝咖啡的，然后6点去吃金鹏老友粉，晚上8点去看小蛮腰，还来得及全部做这些事吗？";
  await page.getByLabel("描述今天的安排和变化").fill(rawText);
  const first = await assistRequest(page, async () => page.getByRole("button", { name: /帮我重新安排今天/ }).click());
  const activities = [
    ...(first.confirmedDraft?.existingPlans ?? []),
    ...(first.confirmedDraft?.activityMentions ?? []),
  ];
  expect(activities).toHaveLength(3);
  expect(activities.map((item) => item.startTime)).toEqual(["15:00", "18:00", "20:00"]);
  const bodies = await continueHomeFlow(page, first);
  await saveEvidence("01-original-input-run-2", page, {
    category: "真实浏览器/真实后端/真实 DeepSeek 与按需高德",
    input: rawText,
    responses: bodies.map(responseSummary),
    finalUrl: page.url(),
  });
});

for (const locked of [false, true] as const) {
  for (const run of [1, 2] as const) {
    const caseNumber = locked ? "03" : "02";
    test(`P0-${caseNumber} ${locked ? "固定" : "普通"}行程补位置不丢活动 第${run}次`, async ({ page }) => {
      const before = await createSavedTrip(page, locked);
      const original = before.snapshot.itinerary.map((item: { id: string; placeId: string; startTime: string; locked: boolean }) => ({ id: item.id, placeId: item.placeId, startTime: item.startTime, locked: item.locked }));
      expect(original.map((item: { locked: boolean }) => item.locked)).toEqual(locked ? [true, false] : [false, false]);
      await page.goto("/");
      const rawText = "我现在换地方了，在地铁站附近，下雨了，请调整今天剩下的安排。";
      await page.getByLabel("描述今天的安排和变化").fill(rawText);
      const first = await assistRequest(page, async () => page.getByRole("button", { name: /帮我重新安排今天/ }).click());
      const bodies = await continueHomeFlow(page, first);
      const terminal = bodies.at(-1)!;
      const unchanged = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
      console.log(`P0-${caseNumber} run ${run}`, JSON.stringify(bodies.map(responseSummary)));
      await saveEvidence(`${caseNumber}-${locked ? "locked" : "ordinary"}-run-${run}`, page, {
        category: "真实浏览器/真实后端/真实 DeepSeek/真实高德",
        input: rawText,
        original,
        responses: bodies.map(responseSummary),
        formalRevisionBeforeAccept: unchanged.snapshot.revision,
      });
      expect(terminal.status).toBe("READY");
      expect(terminal.base?.itinerary?.map((item) => ({ id: item.id, placeId: item.placeId, startTime: item.startTime, locked: item.locked }))).toEqual(original);
      expect(unchanged.snapshot.revision).toBe(1);
      expect(unchanged.snapshot.itinerary.map((item: { id: string }) => item.id)).toEqual(original.map((item: { id: string }) => item.id));
    });
  }
}

test("P0-04 空行程的酒店地点答案只归属酒店活动", async ({ page }) => {
  await page.goto("/");
  const rawText = "现在下雨了，我原定15点回酒店，18点去上海国金中心，请帮我调整。";
  await page.getByLabel("描述今天的安排和变化").fill(rawText);
  const first = await assistRequest(page, async () => page.getByRole("button", { name: /帮我重新安排今天/ }).click());
  const initialActivities = [
    ...(first.parsedInput?.existingPlans ?? []),
    ...(first.parsedInput?.activityMentions ?? []),
  ];
  expect(initialActivities).toHaveLength(2);
  const initialIds = [
    ...(first.confirmedDraft?.existingPlans ?? []),
    ...(first.confirmedDraft?.activityMentions ?? []),
  ].map((item) => item.id);
  const bodies = await continueHomeFlow(page, first);
  const allActivities = bodies.flatMap((body) => [
    ...(body.parsedInput?.existingPlans ?? []),
    ...(body.parsedInput?.activityMentions ?? []),
  ]);
  const hotelActivity = [...allActivities].reverse().find((item) => /酒店/.test(item.name ?? ""));
  const financeActivity = [...allActivities].reverse().find((item) => /国金|金融中心/.test(item.name ?? ""));
  await saveEvidence("04-hotel-location-answer", page, {
    category: "真实浏览器/真实后端/真实 DeepSeek 与按需高德",
    input: rawText,
    answers: ["上海和平饭店", "人民广场(地铁站)", "真实 POI 候选首项（如出现）"],
    responses: bodies.map(responseSummary),
    finalUrl: page.url(),
  });
  const expectedIds = [...initialIds].sort();
  expect(bodies.slice(1).every((body) => {
    const ids = [
      ...(body.parsedInput?.existingPlans ?? []),
      ...(body.parsedInput?.activityMentions ?? []),
    ].map((item) => item.id).sort();
    return ids.length === 0 || JSON.stringify(ids) === JSON.stringify(expectedIds);
  })).toBeTruthy();
  expect(hotelActivity?.location).toMatch(/上海和平饭店|和平饭店|酒店/);
  expect(financeActivity?.startTime).toBe("18:00");
  expect(financeActivity?.location).toMatch(/上海国金中心/);
  expect(bodies.at(-1)?.error ?? "").not.toMatch(/没有对应|JSON|Zod|SyntaxError/i);
});

test("P0-05 空行程活动缺时间时答案可定向更新且 ID 稳定", async ({ page }) => {
  await page.goto("/");
  const rawText = "我今天原定去上海国金中心，再去外滩，现在下雨了，帮我调整。";
  await page.getByLabel("描述今天的安排和变化").fill(rawText);
  const first = await assistRequest(page, async () => page.getByRole("button", { name: /帮我重新安排今天/ }).click());
  const initialActivities = [
    ...(first.parsedInput?.existingPlans ?? []),
    ...(first.parsedInput?.activityMentions ?? []),
  ];
  expect(initialActivities).toHaveLength(2);
  const initialIds = [
    ...(first.confirmedDraft?.existingPlans ?? []),
    ...(first.confirmedDraft?.activityMentions ?? []),
  ].map((item) => item.id);
  const bodies = await continueHomeFlow(page, first);
  const askedTime = bodies.some((body) => /几点|时间/.test(body.missingFact?.question ?? ""));
  const finalParsed = [
    ...(bodies.at(-1)?.parsedInput?.existingPlans ?? []),
    ...(bodies.at(-1)?.parsedInput?.activityMentions ?? []),
  ];
  await saveEvidence("05-missing-time-answer", page, {
    category: "真实浏览器/真实后端/真实 DeepSeek 与按需高德",
    input: rawText,
    answers: ["15:00（上海国金中心）", "18:00（外滩）", "人民广场(地铁站)（如询问当前位置）"],
    responses: bodies.map(responseSummary),
    finalUrl: page.url(),
  });
  expect(askedTime).toBeTruthy();
  expect(finalParsed.map((item) => item.id)).toEqual(initialIds);
  expect(finalParsed.find((item) => /国金|金融中心/.test(item.name ?? ""))?.startTime).toBe("15:00");
  expect(finalParsed.find((item) => /外滩/.test(item.name ?? ""))?.startTime).toBe("18:00");
  expect(bodies.at(-1)?.error ?? "").not.toMatch(/没有对应|JSON|Zod|SyntaxError/i);
});

test("P0-06 已有活动的取消问题保留原活动身份且接受前不改正式行程", async ({ page }) => {
  const before = await createSavedTrip(page);
  const original = before.snapshot.itinerary.map((item: { id: string; placeId: string; name: string; startTime: string }) => ({
    id: item.id,
    placeId: item.placeId,
    name: item.name,
    startTime: item.startTime,
  }));
  const activityB = original.find((item: { name: string }) => /外滩/.test(item.name));
  expect(activityB).toBeTruthy();
  await page.goto("/");
  const rawText = "原来18点去外滩，现在下雨了，要不要取消外滩？";
  await page.getByLabel("描述今天的安排和变化").fill(rawText);
  const first = await assistRequest(page, async () => page.getByRole("button", { name: /帮我重新安排今天/ }).click());
  const bodies = await continueHomeFlow(page, first);
  const unchanged = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  const handledActivities = [
    ...(first.parsedInput?.existingPlans ?? []),
    ...(first.parsedInput?.activityMentions ?? []),
    ...(first.base?.itinerary ?? []),
  ];
  await saveEvidence("06-cancel-existing-activity", page, {
    category: "真实浏览器/真实后端/真实 DeepSeek 与按需高德",
    input: rawText,
    original,
    responses: bodies.map(responseSummary),
    formalRevisionBeforeAccept: unchanged.snapshot.revision,
    finalUrl: page.url(),
  });
  expect(handledActivities.some((item) => item.id === activityB.id || /外滩/.test(item.name ?? ""))).toBeTruthy();
  expect(unchanged.snapshot.revision).toBe(1);
  expect(unchanged.snapshot.itinerary.map((item: { id: string }) => item.id)).toEqual(original.map((item: { id: string }) => item.id));
  expect(bodies.at(-1)?.error ?? "").not.toMatch(/没有对应|JSON|Zod|SyntaxError/i);
});

test("P0-07 真正考虑中的互斥选项不会自动变成两项确定行程", async ({ page }) => {
  await page.goto("/");
  const rawText = "现在下雨了，我在考虑15点去上海博物馆东馆还是上海国金中心，还没决定。";
  await page.getByLabel("描述今天的安排和变化").fill(rawText);
  const first = await assistRequest(page, async () => page.getByRole("button", { name: /帮我重新安排今天/ }).click());
  const parsed = [
    ...(first.parsedInput?.existingPlans ?? []).map((item) => ({ ...item, role: "existing_plan" })),
    ...(first.parsedInput?.activityMentions ?? []),
  ];
  await saveEvidence("07-considering-options", page, {
    category: "真实浏览器/真实后端/真实 DeepSeek",
    input: rawText,
    responses: [responseSummary(first)],
    finalUrl: page.url(),
  });
  expect(first.status).not.toBe("READY");
  expect(first.result).toBeUndefined();
  expect(parsed.filter((item) => item.role === "existing_plan")).toHaveLength(0);
  expect(parsed.filter((item) => item.role === "considering")).toHaveLength(2);
});

test("P0-08 真实同城方案接受、复验与保存闭环", async ({ page }) => {
  const before = await createSavedTrip(page);
  expect(before.snapshot.revision).toBe(1);
  const originalIds = before.snapshot.itinerary.map((item: { id: string }) => item.id);

  await page.goto("/");
  const rawText = "现在下雨了，请根据我在上海人民广场的位置调整今天剩下的原定安排。";
  await page.getByLabel("描述今天的安排和变化").fill(rawText);
  const first = await assistRequest(page, async () => page.getByRole("button", { name: /帮我重新安排今天/ }).click());
  const bodies = await continueHomeFlow(page, first);
  const terminal = bodies.at(-1)!;
  expect(terminal.status).toBe("READY");
  await expect(page).toHaveURL(/\/result$/, { timeout: 20_000 });
  const pending = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(pending.snapshot.revision).toBe(1);
  expect(pending.snapshot.itinerary.map((item: { id: string }) => item.id)).toEqual(originalIds);
  const validateResponse = page.waitForResponse((response) => response.url().includes("/api/validate") && response.request().method() === "POST", { timeout: 45_000 });
  await page.getByRole("button", { name: /接受方案/ }).click();
  expect((await validateResponse).ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/trip$/, { timeout: 20_000 });
  await page.reload();
  const accepted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(accepted.snapshot.revision).toBe(2);
  expect(accepted.pendingPlan).toBeNull();
  await saveEvidence("08-same-city-success", page, {
    category: "真实浏览器/真实后端/真实 DeepSeek/真实高德/真实复验",
    input: rawText,
    originalIds,
    responses: bodies.map(responseSummary),
    revisionBefore: before.snapshot.revision,
    revisionAfter: accepted.snapshot.revision,
    finalUrl: page.url(),
  });
});

test("DEFECT-A 真实固定预约重申后保留时长与来源", async ({ page }) => {
  await page.goto("/onboarding");
  await page.getByLabel("所在城市").fill("上海");
  await page.getByLabel("现在大概几点").fill("13:00");
  await page.getByLabel("现在在哪儿").fill("上海人民广场");
  await page.getByLabel("你今天想怎么安排？").fill("我已经确定今天18:00到19:00去上海国金中心，这是固定预约。");
  const parseResponse = page.waitForResponse((response) => response.url().includes("/api/parse") && response.request().method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name: "整理这份行程" }).click();
  expect((await parseResponse).ok()).toBeTruthy();
  await expect(page.locator('.stop-editor input[id^="name-"]')).toHaveCount(1, { timeout: 20_000 });
  await page.getByLabel("开始").fill("18:00");
  await page.getByLabel("结束").fill("19:00");
  await page.getByRole("checkbox").setChecked(true);
  await page.getByRole("button", { name: /开始今天的行程/ }).click();
  await expect(page).toHaveURL(/\/trip$/);
  const before = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  const original = before.snapshot.itinerary[0];
  expect([original.startTime, original.endTime, original.durationSource, original.locked]).toEqual(["18:00", "19:00", "user", true]);

  await page.goto("/");
  const rawText = "下雨了，18点去上海国金中心的预约请保留。我现在在地铁站附近。";
  await page.getByLabel("描述今天的安排和变化").fill(rawText);
  const first = await assistRequest(page, async () => page.getByRole("button", { name: /帮我重新安排今天/ }).click());
  expect(first.status).toBe("NEEDS_INPUT");
  const bodies = [first];
  const answers: string[] = [];
  let current = first;
  let suppliedCurrentLocation = false;
  for (let round = 0; round < 3 && current.status === "NEEDS_INPUT"; round += 1) {
    await expect(page.locator(".follow-up-card")).toBeVisible();
    const candidates = page.locator(".follow-up-card .poi-option");
    if (await candidates.count()) {
      const selected = await reviewedPoiChoice(page, current.missingFact?.question ?? "");
      if (current.missingFact?.key === "currentLocation") suppliedCurrentLocation = true;
      answers.push(selected.selectedText);
      current = selected.body;
    } else {
      const value = answerFor(current);
      if (current.missingFact?.key === "currentLocation") suppliedCurrentLocation = true;
      answers.push(value);
      await page.locator(".follow-up-card input").fill(value);
      current = await assistRequest(page, async () => page.getByRole("button", { name: "继续安排今天" }).click());
    }
    bodies.push(current);
  }
  expect(suppliedCurrentLocation).toBeTruthy();
  if (current.status === "READY") await page.waitForURL(/\/result$/, { timeout: 20_000 });
  const drafts = bodies
    .map((body) => body.confirmedDraft?.existingPlans?.find((item) => item.id === original.id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  expect(drafts).toHaveLength(bodies.filter((body) => body.status === "NEEDS_INPUT").length);
  const unchanged = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  await saveDefectEvidence("A-real-fixed-restatement", page, {
    category: "真实浏览器/真实后端/真实 DeepSeek/按需真实高德",
    input: rawText,
    answers,
    original: { id: original.id, placeId: original.placeId, startTime: original.startTime, endTime: original.endTime, durationSource: original.durationSource, locked: original.locked },
    responses: bodies.map(responseSummary),
    draftFacts: drafts,
    formalRevisionBeforeAccept: unchanged.snapshot.revision,
  });
  for (const item of drafts) {
    expect(item).toBeTruthy();
    expect([item?.startTime, item?.endTime, item?.durationSource, item?.locked]).toEqual(["18:00", "19:00", "user", true]);
  }
  expect(unchanged.snapshot.revision).toBe(1);
  expect([unchanged.snapshot.itinerary[0].id, unchanged.snapshot.itinerary[0].endTime, unchanged.snapshot.itinerary[0].durationSource]).toEqual([original.id, "19:00", "user"]);
});

const semanticCases = [
  {
    id: "B1",
    input: "现在下雨了，我想3点去印暨小馆喝咖啡的，然后6点去吃金鹏老友粉，晚上8点去看小蛮腰，还来得及全部做这些事吗？",
    assert: (body: ParseBody) => {
      expect(body.existingPlans?.map((item) => item.startTime)).toEqual(["15:00", "18:00", "20:00"]);
      expect(body.activityMentions ?? []).toHaveLength(0);
    },
  },
  {
    id: "B2",
    input: "我还不确定是否去，正在考虑15点去上海博物馆东馆，然后18点去上海国金中心，来得及吗？",
    assert: (body: ParseBody) => {
      expect(body.existingPlans ?? []).toHaveLength(0);
      expect(body.activityMentions?.map((item) => item.role)).toEqual(["considering", "considering"]);
    },
  },
  {
    id: "B3",
    input: "我原定15点去上海博物馆东馆、18点去上海国金中心，但现在不确定赶不赶得上。",
    assert: (body: ParseBody) => {
      expect(body.existingPlans?.map((item) => item.startTime)).toEqual(["15:00", "18:00"]);
      expect(body.activityMentions ?? []).toHaveLength(0);
    },
  },
  {
    id: "B6",
    input: "已确定15点去上海博物馆东馆，晚上还在考虑18点去上海国金中心，全部来得及吗？",
    assert: (body: ParseBody) => {
      expect(body.existingPlans?.map((item) => item.startTime)).toEqual(["15:00"]);
      expect(body.activityMentions?.map((item) => [item.role, item.startTime])).toEqual([["considering", "18:00"]]);
    },
  },
] as const;

for (const semanticCase of semanticCases) {
  for (const run of [1, 2] as const) {
    test(`DEFECT-${semanticCase.id} 真实模型分类 第${run}次`, async ({ page }) => {
      const response = await parseThroughBrowser(page, semanticCase.input);
      await saveDefectEvidence(`${semanticCase.id}-semantic-run-${run}`, page, {
        category: "真实浏览器 fetch/真实后端/真实 DeepSeek，仅验证语义分类",
        input: semanticCase.input,
        httpStatus: response.status,
        parser: response.body?.parser,
        parserModel: response.body?.parserModel,
        existingPlans: response.body?.existingPlans,
        activityMentions: response.body?.activityMentions,
        disruptions: response.body?.disruptions,
        question: response.body?.question,
      });
      expect(response.status).toBe(200);
      semanticCase.assert(response.body);
    });
  }
}

test("DEFECT-CLOSURE 空正式行程的真实同城接受闭环", async ({ page }) => {
  await page.goto("/");
  const rawText = "现在13:00，我在上海人民广场。现在下雨了，我原定15:00到16:00去上海国金中心，18:00到19:00去外滩，请帮我调整。";
  await page.getByLabel("描述今天的安排和变化").fill(rawText);
  const first = await assistRequest(page, async () => page.getByRole("button", { name: /帮我重新安排今天/ }).click());
  const flow = await continueReviewedFlow(page, first);
  const terminal = flow.bodies.at(-1)!;
  expect(terminal.status).toBe("READY");
  expect(terminal.base?.revision).toBe(0);
  await expect(page).toHaveURL(/\/result$/);
  const beforeAccept = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  expect(beforeAccept.snapshot.revision).toBe(0);
  const validateResponse = page.waitForResponse((response) => response.url().includes("/api/validate") && response.request().method() === "POST", { timeout: 45_000 });
  await page.getByRole("button", { name: /接受方案/ }).click();
  expect((await validateResponse).ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/trip$/, { timeout: 20_000 });
  await page.reload();
  const accepted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sessionKey);
  await saveDefectEvidence("normal-empty-session-closure", page, {
    category: "真实浏览器/真实后端/真实 DeepSeek/真实高德/真实复验",
    input: rawText,
    reviewedAnswers: flow.answers,
    responses: flow.bodies.map(responseSummary),
    revisionBefore: beforeAccept.snapshot.revision,
    revisionAfter: accepted.snapshot.revision,
    savedActivities: accepted.snapshot.itinerary.map((item: { id: string; name: string; startTime: string; endTime: string }) => ({ id: item.id, name: item.name, startTime: item.startTime, endTime: item.endTime })),
    finalUrl: page.url(),
  });
  expect(accepted.snapshot.revision).toBe(1);
  expect(accepted.pendingPlan).toBeNull();
});
