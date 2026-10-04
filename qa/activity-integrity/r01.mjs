import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RealSessionSchema, SnapshotSchema } from "../../types/index.ts";
import { analyzeImpact } from "../../services/impact-analysis.ts";
import { summarizeVerifiedPlan, validatePlanExplanation } from "../../services/plan-narrative.ts";
import { replanReal } from "../../agents/real-replanning-agent.ts";
import { snapshotActivityFacts } from "../../services/activity-facts.ts";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "runs", stamp);
await mkdir(runDir, { recursive: true });
const browserPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", ".playwright-browsers");
try { await access(browserPath); process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath; } catch { /* Use installed browser. */ }
const { chromium } = await import("@playwright/test");
const results = [];
async function check(name, fn) {
  try { results.push({ name, passed: true, evidence: await fn() }); }
  catch (error) { results.push({ name, passed: false, evidence: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}
const sources = { currentTime: "user", currentLocation: "user", weather: "user", energyLevel: "unset", disruption: "user" };
const bund = { id: "bund-walk", placeId: "place-bund", name: "外滩散步", category: "user activity", startTime: "18:00", endTime: "19:00",
  location: "外滩观景平台", status: "planned", locked: false, indoorOutdoor: "mixed", openingTime: null, closingTime: null,
  travelTimeFromPrevious: null, reason: "原计划散步", constraint: "弹性安排" };
const mall = { ...bund, id: "mall", placeId: "place-mall", name: "上海国金中心商场", location: "上海国金中心商场",
  startTime: "15:00", endTime: "16:00" };
const museum = { ...bund, id: "ai-museum", placeId: "place-museum", name: "上海博物馆人民广场馆", location: "上海博物馆人民广场馆",
  startTime: "16:00", endTime: "17:00", reason: "新增博物馆作为可选参观活动，室内外条件需现场核实。" };
const base = SnapshotSchema.parse({ mode: "user", profile: { id: "qa", travelPace: "balanced", walkingTolerance: "medium" },
  trip: { id: "qa", destination: "上海", startDate: "2026-09-28", endDate: "2026-09-28" },
  state: { currentDate: "2026-09-28", currentTime: "13:00", stateCapturedAt: "2026-09-28T05:00:00.000Z", currentLocation: "上海人民广场", weather: "rain" },
  stateSources: sources, itinerary: [bund], revision: 2 });
const rawText = "现在下雨了，原计划18:00去外滩观景平台散步，请重新安排。";
const activityFacts=snapshotActivityFacts(base);
const request = { reason: "weather", freeText: rawText, currentState: base.state, closedPlaceIds: [], variation: 0,
  stateSources: sources, activityFacts };
const impact = analyzeImpact(base, request);
const context = { profile: base.profile, trip: base.trip, state: base.state, stateSources: sources, activityFacts,
  remainingActivityFacts:activityFacts, protectedActivityFacts:[],disruption: request, places: [], travelMinutes: {} };
const removed = { eventId: bund.id, name: bund.name, reason: "雨天使原定户外散步体验受影响，因此本方案移除这项安排。", constraint: "弹性安排" };
const longExplanation = "雨天对外滩散步有明确影响，因为用户描述了散步这一户外方式。本方案仍保留外滩散步，并新增上海博物馆人民广场馆。新增地点的室内外条件尚未核实，用户可以根据现场情况决定是否接受。";
const keptPlan = { summary: "外滩改成博物馆", explanation: longExplanation,
  events: [{ ...bund, reason: "保留原定外滩散步，但雨天需要用户自行判断是否仍愿意去。" }, museum], movedEvents: [], removedEvents: [] };
const contradictory = { ...keptPlan, explanation: "外滩改成上海博物馆人民广场馆。" };
const replacedPlan = { summary: "保留外滩", explanation: "移除外滩散步，新增上海博物馆人民广场馆。",
  events: [museum], movedEvents: [], removedEvents: [removed] };

await check("1. 矛盾说明被拒绝，概述只按最终活动计算", () => {
  const violations = validatePlanExplanation(context, contradictory);
  assert.ok(violations.some(item => item.eventId === bund.id));
  const summary = summarizeVerifiedPlan(context, contradictory);
  assert.match(summary, /保留或调整：外滩散步/);
  assert.match(summary, /新增：上海博物馆人民广场馆/);
  assert.doesNotMatch(summary, /替换/);
  return { violations, computedSummary: summary };
});
await check("2. mixed 活动按用户方式判断，未知地点不冒充室内，包含无时间原安排", () => {
  const cycling = { id: "cycle",placeId:"custom-cycle", origin: "message", snapshotEventId: null, role: "existing_plan", progress: "not_started",
    name: "黄浦江滨江绿道骑行", placeQuery: "黄浦江滨江绿道", startTime: null, startTimeSource: "not_provided",
    endTime:null,durationMinutes: null,durationSource:"unknown", commitment: "flexible", sourceText: "原计划去黄浦江滨江绿道骑行" };
  const mixedBase = SnapshotSchema.parse({ ...base, itinerary: [bund, mall] });
  const mixedRequest = { ...request, freeText: "现在下雨了，原计划去外滩散步，还原计划去黄浦江滨江绿道骑行，上海国金中心商场也在行程中。",
    activityFacts: [...snapshotActivityFacts(mixedBase),cycling] };
  const result = analyzeImpact(mixedBase, mixedRequest);
  assert.ok(result.affectedActivities.includes(bund.id));
  assert.ok(result.affectedActivities.includes(cycling.id));
  assert.equal(result.activityWeatherJudgments.find(item => item.id === mall.id).exposure, "unknown");
  assert.ok(!result.affectedActivities.includes(mall.id));
  return { affectedIds: result.affectedActivities, judgments: result.activityWeatherJudgments };
});
await check("3. 真正移除原安排时才允许替换概述，且有移除理由", () => {
  assert.deepEqual(validatePlanExplanation(context, replacedPlan), []);
  const summary = summarizeVerifiedPlan(context, replacedPlan);
  assert.match(summary, /替换外滩散步/);
  assert.equal(replacedPlan.removedEvents[0].reason, removed.reason);
  return { summary, removedReason: removed.reason };
});
await check("3a. 地点名称不能充当已验证室内证据", () => {
  const unsupported = { ...keptPlan, events: [keptPlan.events[0], { ...museum, reason: "室内博物馆，雨天保证舒适。" }] };
  const violations = validatePlanExplanation(context, unsupported);
  assert.ok(violations.some(item => item.eventId === museum.id && /室内外属性/.test(item.message)));
  return { eventId: museum.id, violation: violations.find(item => item.eventId === museum.id)?.message };
});
await check("3b. 矛盾候选反馈重生成，两次仍矛盾就不返回可接受方案", async () => {
  const point = (id, name) => ({ id, poiId: id, name, address: name, city: "上海市", district: "黄浦区", adcode: "310101",
    longitude: 121.48, latitude: 31.23, coordinateSystem: "GCJ02", type: "风景名胜", source: "amap",
    fetchedAt: "2026-09-28T05:00:00.000Z", status: "available" });
  const current = { ...point("current", "上海人民广场"), source: "user", capturedAt: "2026-09-28T05:00:00.000Z" };
  const original = point(bund.placeId, bund.name), alternative = point("poi-museum", museum.name);
  const route = (origin, destination) => ({ origin, destination, travelMode: "WALKING", distanceMeters: 500, durationSeconds: 600,
    source: "amap", fetchedAt: "2026-09-28T05:00:00.000Z", status: "available" });
  const world = { status: "ready", currentTime: { value: "13:00", date: "2026-09-28", source: "user", confirmedAt: "2026-09-28T05:00:00.000Z" },
    currentLocation: current, resolvedPlaces: [{ placeId: bund.placeId, poi: original }], alternatives: [alternative],
    routes: [route(current, { ...original, id: bund.placeId }), route({ ...original, id: bund.placeId }, { ...alternative, id: alternative.poiId })],
    weather: { condition: "小雨", temperature: 20, humidity: 80, windDirection: null, windPower: null, forecast: [],
      source: "amap", fetchedAt: "2026-09-28T05:00:00.000Z", reportedAt: null, status: "available" },
    dataFreshness: { groundedAt: "2026-09-28T05:00:00.000Z", routeMaxAgeSeconds: 120, locationMaxAgeSeconds: 600 },
    missingWorldFacts: [], ambiguities: [], travelMode: "WALKING" };
  const candidate = { title: "外滩改成博物馆", tradeOff: "外滩改成博物馆。", steps: [
    { eventId: bund.id, poiId: null, durationMinutes: null, travelMode: "WALKING", reason: "保留原安排并说明雨天风险。" },
    { eventId: null, poiId: alternative.poiId, durationMinutes: 60, travelMode: "WALKING", reason: "新增备选，现场核实条件。" },
  ], removed: [] };
  const feedbackSeen = [];
  const planner = { name: "controlled", generateCandidates: async (_context, feedback) => {
    feedbackSeen.push(feedback.map(item => item.message));
    return [candidate];
  } };
  const result = await replanReal({ snapshot: base, request, mode: "live", confirmation: { status: "confirmed", confirmedAt: new Date().toISOString() } },
    planner, { ground: async () => world }, impact);
  assert.equal(result.ok, false);
  assert.equal(feedbackSeen.length, 2);
  assert.ok(feedbackSeen[1].some(message => /说明声称移除或替换/.test(message)));
  return { attempts: feedbackSeen.length, secondAttemptFeedback: feedbackSeen[1], acceptablePlan: result.plan };
});

const browser = await chromium.launch({ headless: true });
const browserContext = await browser.newContext({ viewport: { width: 1100, height: 1300 } });
await browserContext.tracing.start({ screenshots: true, snapshots: true });
async function showPlan(page, plan, alternatives = []) {
  const result = { id: `controlled-${crypto.randomUUID()}`, ok: true, plan, mode: "live", model: "controlled", message: "受控方案", attempts: [],
    context, candidatePlans: alternatives };
  const session = RealSessionSchema.parse({ schemaVersion: 4, experienceMode: "real", flowStage: "PLAN_READY", snapshot: base,
    rawInput: rawText, parsedInput: null, lastDisruption: request, pendingPlan: { result, base, request, accepted: false, impactAnalysis: impact },
    resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] },
    updatedAt: new Date().toISOString() });
  await page.goto("http://127.0.0.1:3000/");
  await page.evaluate(value => localStorage.setItem("travel-session-real-v4", JSON.stringify(value)), session);
  await page.goto("http://127.0.0.1:3000/result");
}
async function screenshot(name, plan, inspect) {
  const file = `${name.split(".")[0]}-page.png`;
  await check(name, async () => {
    const page = await browserContext.newPage();
    try { await showPlan(page, plan, inspect.alternatives ?? []);
      const evidence = await inspect(page);
      await page.screenshot({ path: path.join(runDir, file), fullPage: true });
      return evidence;
    } finally { await page.close(); }
  });
  if (results.at(-1)?.passed) results.at(-1).screenshot = file;
}
await screenshot("4. 矛盾旧方案在真实结果页不可接受", contradictory, async page => {
  await page.getByText("有一处时间需要重新协调").waitFor();
  assert.equal(await page.getByRole("button", { name: "接受方案" }).count(), 0);
  assert.equal(await page.getByText("外滩改成博物馆", { exact: true }).count(), 0);
  return { acceptButtonCount: 0, contradictoryTitleVisible: false };
});
await screenshot("5. 保留外滩并新增博物馆的结果页与完整弹窗", keptPlan, async page => {
  const summary = summarizeVerifiedPlan(context, keptPlan);
  await page.getByText(summary, { exact: true }).first().waitFor();
  assert.equal(await page.getByText("外滩改成博物馆", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "查看我的情况分析" }).click();
  await page.getByText(longExplanation, { exact: true }).waitFor();
  await page.getByText(keptPlan.events[0].reason, { exact: true }).waitFor();
  await page.getByText(museum.reason, { exact: true }).waitFor();
  assert.ok(await page.getByText("用户描述包含“散步”。", { exact: true }).count());
  await page.waitForTimeout(800);
  return { summary, explanation: longExplanation, reasons: keptPlan.events.map(event => event.reason),
    affected: impact.affectedActivities };
});
await screenshot("6. 确实移除外滩的结果页与移除理由", replacedPlan, async page => {
  const summary = summarizeVerifiedPlan(context, replacedPlan);
  await page.getByText(summary, { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "查看我的情况分析" }).click();
  await page.getByText(replacedPlan.explanation, { exact: true }).waitFor();
  await page.getByText(removed.reason, { exact: true }).waitFor();
  await page.waitForTimeout(800);
  return { summary, explanation: replacedPlan.explanation, removedReason: removed.reason };
});
await check("7. 备选方案标题也取自实际活动", async () => {
  const page = await browserContext.newPage();
  try {
    const mainPlan = { ...keptPlan, summary: "保留外滩", explanation: "保留外滩散步，雨天风险已说明。", events: [keptPlan.events[0]] };
    const alternative = { id: "alt", title: "外滩改成博物馆", tradeOff: longExplanation, feasible: true, plan: keptPlan, conflicts: [] };
    await showPlan(page, mainPlan, [alternative]);
    const actual = summarizeVerifiedPlan(context, keptPlan);
    await page.getByRole("button", { name: new RegExp(actual) }).waitFor();
    assert.equal(await page.getByText("外滩改成博物馆", { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(runDir, "7-page.png"), fullPage: true });
    return { modelTitle: alternative.title, displayedTitle: actual };
  } finally { await page.close(); }
});
if (results.at(-1)?.passed) results.at(-1).screenshot = "7-page.png";
await browserContext.tracing.stop({ path: path.join(runDir, "r01-trace.zip") });
await browser.close();

const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>R01 受控验收</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto}article{padding:20px;margin:16px 0;border:1px solid #ddd}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f6;padding:12px}img{max-width:100%;border:1px solid #ddd}</style><h1>R01 受控验收 · ${stamp}</h1><p>通过 ${results.filter(item => item.passed).length}/${results.length}。页面截图来自实际本地应用，模型与地图数据为固定受控数据。</p>${results.map(item => `<article><h2>${item.passed ? "PASS" : "FAIL"} · ${escape(item.name)}</h2><pre>${escape(JSON.stringify(item.evidence, null, 2))}</pre>${item.screenshot ? `<a href="${item.screenshot}">页面截图</a><br><img src="${item.screenshot}">` : ""}</article>`).join("")}</html>`;
await writeFile(path.join(runDir, "r01-report.html"), html, "utf8");
await writeFile(path.join(runDir, "r01-results.json"), JSON.stringify({ stamp, mode: "controlled", results }, null, 2), "utf8");
console.log(path.join(runDir, "r01-report.html"));
if (results.some(item => !item.passed)) process.exitCode = 1;
