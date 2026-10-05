import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RealSessionSchema, SemanticExtractionSchema, SnapshotSchema } from "../../types/index.ts";
import { normalizeSemanticExtraction } from "../../services/semantic-parser.ts";
import { runAgentAssist } from "../../agents/agent-orchestrator.ts";
import { analyzeImpact } from "../../services/impact-analysis.ts";
import { allowedModes } from "../../services/world/context-resolution.ts";
import { snapshotActivityFacts } from "../../services/activity-facts.ts";
import { protectionPolicyForActivity } from "../../services/protection-policy.ts";
import { ServiceFailure } from "../../services/failures.ts";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const baseURL = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "runs", stamp);
await mkdir(runDir, { recursive: true });
const browserPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", ".playwright-browsers");
try { await access(browserPath); process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath; } catch { /* Installed browser. */ }
const { chromium } = await import("@playwright/test");
const results = [];
async function check(name, fn) {
  try { results.push({ name, passed: true, evidence: await fn() }); }
  catch (error) { results.push({ name, passed: false, evidence: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}
const sources = { currentTime: "user", currentLocation: "user", weather: "unset", energyLevel: "unset", disruption: "user" };
const snapshot = itinerary => SnapshotSchema.parse({ mode: "user", profile: { id: "qa", travelPace: "balanced", walkingTolerance: "medium" },
  trip: { id: "qa", destination: "上海", startDate: "2026-09-28", endDate: "2026-09-28" },
  state: { currentDate: "2026-09-28", currentTime: "16:00", stateCapturedAt: "2026-09-28T08:00:00.000Z", currentLocation: "上海人民广场" },
  stateSources: sources, itinerary, revision: 0 });
const extract = activities => SemanticExtractionSchema.parse({ intent: "rescue", activities,
  disruptions: [{ kind: "late", label: "起晚了", sourceText: "起晚了" }], constraints: [], question: null, ambiguities: [],
  context: { currentTime: { value: "16:00", sourceText: "现在16:00" },
    currentLocation: { value: "上海人民广场", sourceText: "我在上海人民广场" },
    weather: { value: null, sourceText: null }, energyLevel: { value: null, sourceText: null } } });
const activity = (name, location, sourceText, startTime, locked) => ({ role: "existing_plan", name, location, sourceText,
  startTime, startTimeEvidence: startTime && sourceText.includes(startTime) ? startTime : null,
  endTime: null, durationMinutes: null, locked, progress: "not_started" });
const base = snapshot([]);
const sentence = "现在16:00，我在上海人民广场。起晚了，原计划去上海自然博物馆，但18:00必须到上海展览中心7号门集合，请重新安排。";

await check("共享句子中单项 sourceText 不连续时仍保留两项原安排", () => {
  const raw = "现在16:00，我在上海人民广场。起晚了，原计划去上海自然博物馆和上海科技馆都没来得及，18:00必须到上海展览中心7号门集合。";
  const parsed = normalizeSemanticExtraction(base, raw, extract([
    activity("去上海自然博物馆", "上海自然博物馆", "原计划去上海自然博物馆", null, "no"),
    activity("去上海科技馆", "上海科技馆", "原计划去上海科技馆", null, "no"),
    activity("到上海展览中心7号门集合", "上海展览中心7号门", "18:00必须到上海展览中心7号门集合", "18:00", "yes"),
  ]), "controlled");
  assert.equal(parsed.activityFacts.length, 3);
  assert.ok(parsed.activityFacts.some(fact => fact.placeQuery === "上海科技馆" && raw.includes(fact.sourceText)));
  return parsed.activityFacts.map(({ name, sourceText, startTime }) => ({ name, sourceText, startTime }));
});

await check("固定有时间：证据绑定后进入规划，来源为用户", async () => {
  const parsed = normalizeSemanticExtraction(base, sentence, extract([
    activity("去上海自然博物馆", "上海自然博物馆", "原计划去上海自然博物馆", null, "no"),
    activity("到上海展览中心7号门集合", "上海展览中心7号门", "18:00必须到上海展览中心7号门集合", "18:00", "yes"),
  ]), "controlled");
  const fixed = parsed.activityFacts.find(fact => fact.commitment === "fixed");
  assert.equal(fixed.startTime, "18:00");
  assert.equal(fixed.startTimeSource, "user");
  let input;
  const response = await runAgentAssist({ snapshot: base, rawText: sentence }, undefined, {
    parse: async () => parsed, ground: async value => { input = value; throw new ServiceFailure("MAP_PROVIDER_ERROR","GROUNDING",{retryable:true}); },
  });
  assert.equal(response.status, "UPSTREAM_UNAVAILABLE");
  assert.ok(input.request.activityFacts.some(fact=>fact.id===fixed.id&&fact.commitment==="fixed"&&fact.startTime==="18:00"));
  return { fixed, requestIds: input.request.activityFacts.map(fact=>fact.id) };
});
await check("弹性无时间：null 保留在 activityFacts，不追问原定几点", async () => {
  const parsed = normalizeSemanticExtraction(base, sentence, extract([
    activity("去上海自然博物馆", "上海自然博物馆", "原计划去上海自然博物馆", null, "no"),
    activity("到上海展览中心7号门集合", "上海展览中心7号门", "18:00必须到上海展览中心7号门集合", "18:00", "yes"),
  ]), "controlled");
  let input;
  await runAgentAssist({ snapshot: base, rawText: sentence }, undefined, {
    parse: async () => parsed, ground: async value => { input = value; throw new ServiceFailure("MAP_PROVIDER_ERROR","GROUNDING",{retryable:true}); },
  });
  const unscheduledFacts=input.request.activityFacts.filter(fact=>fact.startTime===null&&fact.commitment==="flexible");
  assert.deepEqual(unscheduledFacts.map(fact => fact.name), ["去上海自然博物馆"]);
  assert.equal(unscheduledFacts[0].startTime, null);
  assert.ok(!parsed.missingFacts.some(value => value.endsWith(":startTime")));
  return { unscheduledFacts: unscheduledFacts.map(({ id, name, startTime }) => ({ id, name, startTime })) };
});
let conditional;
await check("固定确实无时间：保留固定事实并返回不可接受的条件性建议", async () => {
  const raw = "现在16:00，我在上海人民广场。起晚了，原计划去上海自然博物馆，已经预约在上海展览中心7号门集合，但没说几点，请重新安排。";
  const parsed = normalizeSemanticExtraction(base, raw, extract([
    activity("去上海自然博物馆", "上海自然博物馆", "原计划去上海自然博物馆", null, "no"),
    activity("到上海展览中心7号门集合", "上海展览中心7号门", "已经预约在上海展览中心7号门集合", null, "yes"),
  ]), "controlled");
  let groundingCalls = 0;
  conditional = await runAgentAssist({ snapshot: base, rawText: raw }, undefined, {
    parse: async () => parsed, ground: async () => { groundingCalls++; throw Error("must not ground"); },
  });
  assert.equal(conditional.status, "CONDITIONAL");
  assert.equal(groundingCalls, 0);
  assert.equal(conditional.parsedInput.activityFacts.find(fact => fact.commitment === "fixed").startTime, null);
  assert.match(conditional.advice.warning, /无法验证是否赶上/);
  assert.ok(conditional.advice.suggestions.some(item => item.includes("上海自然博物馆")));
  return { status: conditional.status, advice: conditional.advice, fixed: conditional.parsedInput.activityFacts.find(fact => fact.commitment === "fixed") };
});
await check("交通停运不是地点关闭，停运方式不参加路线比较", () => {
  const raw = "现在17:30，我在上海火车站。原定19:00到上海中心大厦一层入口和朋友集合，但现在地铁停运了，我该怎么办？";
  const extraction = extract([activity("到上海中心大厦一层入口和朋友集合", "上海中心大厦一层入口",
    "原定19:00到上海中心大厦一层入口和朋友集合", "19:00", "yes")]);
  extraction.disruptions = [{ kind: "closed", label: "地铁停运", sourceText: "但现在地铁停运了" }];
  extraction.context.currentTime = { value: "17:30", sourceText: "现在17:30" };
  extraction.context.currentLocation = { value: "上海火车站", sourceText: "我在上海火车站" };
  const parsed = normalizeSemanticExtraction(base, raw, extraction, "controlled");
  assert.equal(parsed.disruptions[0].kind, "other");
  assert.ok(!parsed.missingFacts.includes("closedPlace"));
  const modes = allowedModes(raw);
  assert.deepEqual(modes, ["WALKING", "DRIVING"]);
  return { disruption: parsed.disruptions, allowedModes: modes };
});

const browser = await chromium.launch({ headless: true });
const browserContext = await browser.newContext({ viewport: { width: 1100, height: 1300 } });
await browserContext.tracing.start({ screenshots: true, snapshots: true });
const session = (state, rawInput = "") => RealSessionSchema.parse({ schemaVersion: 5, experienceMode: "real", flowStage: "NO_ITINERARY",
  snapshot: state, rawInput, parsedInput: null, lastDisruption: null, pendingPlan: null,
  resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] },
  updatedAt: new Date().toISOString() });
const event = (id, name, location, startTime, travelMode, locked = false) => ({ id, placeId: `place-${id}`, name,
  category: "user activity", location, startTime, endTime: startTime, status: locked ? "locked" : "planned", locked,
  protectionPolicy:locked?protectionPolicyForActivity({name,location,sourceText:`${startTime}固定安排${name}`,startTime,durationMinutes:null,commitment:"fixed"}):undefined,
  indoorOutdoor: "mixed", openingTime: null, closingTime: null, travelTimeFromPrevious: null, travelMode,
  reason: "按原安排处理，路线仍以查询结果为准。", constraint: locked ? "固定安排" : "弹性安排", durationSource: "unknown" });
async function showResult(page, state, request, plan, impact) {
  const activityFacts=request.activityFacts;
  const result = { id: crypto.randomUUID(), ok: true, plan, mode: "live", model: "controlled", message: "受控页面截图", attempts: [],
    context: { profile: state.profile, trip: state.trip, state: state.state, stateSources: state.stateSources,
      activityFacts, remainingActivityFacts:activityFacts.filter(fact=>fact.progress!=="completed"),protectedActivityFacts:activityFacts.filter(fact=>fact.commitment!=="flexible"),
      disruption: request, places: [], travelMinutes: {} } };
  const value = RealSessionSchema.parse({ ...session(state, request.freeText), flowStage: "PLAN_READY", lastDisruption: request,
    pendingPlan: { result, base: state, request, impactAnalysis: impact } });
  await page.goto(`${baseURL}/`);
  await page.evaluate(data => localStorage.setItem("travel-session-real-v5", JSON.stringify(data)), value);
  await page.goto(`${baseURL}/result`);
}
await check("条件性建议实际页面可见，不能接受方案；首页文本框无绿色焦点框", async () => {
  const page = await browserContext.newPage();
  try {
    await page.goto(`${baseURL}/`);
    await page.evaluate(data => localStorage.setItem("travel-session-real-v5", JSON.stringify(data)), session(base));
    await page.reload();
    await page.route("**/api/assist", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(conditional) }));
    const textarea = page.getByLabel("描述今天的安排和变化");
    await textarea.fill(conditional.parsedInput.rawText);
    await page.getByRole("button", { name: "帮我重新安排今天" }).click();
    await page.getByText(conditional.advice.heading, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "接受方案" }).count(), 0);
    await page.reload();
    await page.getByText(conditional.advice.heading, { exact: true }).waitFor();
    await textarea.focus();
    const outline = await textarea.evaluate(element => getComputedStyle(element).outlineWidth);
    assert.equal(outline, "0px");
    await page.screenshot({ path: path.join(runDir, "conditional-home.png"), fullPage: true });
    await textarea.fill(`${conditional.parsedInput.rawText} 预约时间是18:00。`);
    assert.equal(await page.getByText(conditional.advice.heading, { exact: true }).count(), 0);
    const updated = await page.evaluate(() => JSON.parse(localStorage.getItem("travel-session-real-v5")));
    assert.equal(updated.resolutionState.roundCount, 0);
    return { status: "CONDITIONAL", acceptButtonCount: 0, textareaOutlineWidth: outline,
      oldAdviceAfterEdit: false, roundCountAfterEdit: updated.resolutionState.roundCount, screenshot: "conditional-home.png" };
  } finally { await page.close(); }
});
for (const [label, mode] of [["方案一", "DRIVING"], ["方案二", "TRANSIT"]]) {
  await check(`D02 ${label}交通方式矩形标签实际页面`, async () => {
    const page = await browserContext.newPage();
    try {
      const hotel = event("hotel", "去上海和平饭店办理入住", "上海和平饭店", "18:00", mode, true);
      const night = event("night", "去外滩观景平台夜游", "外滩观景平台", "20:00", mode);
      const state = snapshot([hotel, night]);
      const request = { reason: "late", freeText: "高铁晚点，请调整酒店入住和夜游。", currentState: state.state,
        closedPlaceIds: [], variation: 0, stateSources: sources, activityFacts:snapshotActivityFacts(state) };
      const plan = { summary: "受控方案", explanation: "保持两项安排。", events: [hotel, night], movedEvents: [], removedEvents: [] };
      await showResult(page, state, request, plan, analyzeImpact(state, request));
      const tags = page.locator(".plan-event-card .travel-mode-tag");
      await tags.first().waitFor();
      assert.equal(await tags.count(), 2);
      const expected = mode === "DRIVING" ? "打车" : "公共交通";
      assert.deepEqual(await tags.allInnerTexts(), [expected, expected]);
      assert.equal(await tags.first().evaluate(element => getComputedStyle(element).borderStyle), "solid");
      const file = mode === "DRIVING" ? "d02-driving.png" : "d02-transit.png";
      await page.screenshot({ path: path.join(runDir, file), fullPage: true });
      return { label, travelMode: expected, tagCount: 2, screenshot: file };
    } finally { await page.close(); }
  });
}
await check("长地点换行时新增标签保持单行且不被挤出卡片", async () => {
  const page = await browserContext.newPage();
  try {
    await page.setViewportSize({ width: 390, height: 950 });
    const state = snapshot([]);
    const request = { reason: "late", freeText: "晚点了，改去附近新地点。", currentState: state.state,
      closedPlaceIds: [], variation: 0, stateSources: sources, activityFacts:[] };
    const added = event("long-name", "PLUSONE COFFEE(武康路店)与附近休息区域", "武康路286号", "17:00", "WALKING");
    const plan = { summary: "受控方案", explanation: "新增附近休息地点。", events: [added], movedEvents: [], removedEvents: [] };
    await showResult(page, state, request, plan, analyzeImpact(state, request));
    const title = page.locator(".plan-event-top h2");
    const badge = page.locator(".plan-event-top .status-pill");
    await badge.waitFor();
    await page.screenshot({ path: path.join(runDir, "long-place-badge.png"), fullPage: true });
    assert.equal(await badge.innerText(), "新增");
    assert.equal(await badge.evaluate(element => getComputedStyle(element).whiteSpace), "nowrap");
    const titleBox = await title.boundingBox(), badgeBox = await badge.boundingBox();
    assert.ok(titleBox && badgeBox && titleBox.x + titleBox.width <= badgeBox.x + 1);
    return { titleWidth: titleBox.width, badgeWidth: badgeBox.width, screenshot: "long-place-badge.png" };
  } finally { await page.close(); }
});
await check("R01 弹窗把受影响与待判断分开，外滩与国金中心各在正确区块", async () => {
  const page = await browserContext.newPage();
  try {
    const bund = event("bund", "外滩散步", "外滩观景平台", "18:00", "DRIVING");
    const mall = event("mall", "去上海国金中心商场", "上海国金中心商场", "15:00", "DRIVING");
    const state = SnapshotSchema.parse({ ...snapshot([bund, mall]), state: { ...base.state, weather: "rain" },
      stateSources: { ...sources, weather: "user" } });
    const request = { reason: "weather", freeText: "现在下雨了，原定去外滩散步，还要去上海国金中心商场。",
      currentState: state.state, closedPlaceIds: [], variation: 0, stateSources: state.stateSources,
      activityFacts:snapshotActivityFacts(state) };
    const plan = { summary: "受控方案", explanation: "保留原安排并提示雨天风险。", events: [mall, bund], movedEvents: [], removedEvents: [] };
    await showResult(page, state, request, plan, analyzeImpact(state, request));
    await page.getByRole("button", { name: "查看我的情况分析" }).click();
    const affected = page.locator(".analysis-block").filter({ hasText: "受到影响的原安排" });
    const unknown = page.locator(".analysis-block").filter({ hasText: "室内外属性尚无法判断" });
    await unknown.waitFor();
    assert.match(await affected.innerText(), /外滩散步/);
    assert.doesNotMatch(await affected.innerText(), /国金中心/);
    assert.match(await unknown.innerText(), /国金中心/);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(runDir, "r01-separated-impact.png"), fullPage: true });
    return { affected: await affected.innerText(), unknown: await unknown.innerText(), screenshot: "r01-separated-impact.png" };
  } finally { await page.close(); }
});
await browserContext.tracing.stop({ path: path.join(runDir, "trace.zip") });
await browser.close();
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本轮修复验收</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto}article{border:1px solid #ddd;margin:20px 0;padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f6;padding:12px}img{max-width:100%;border:1px solid #ddd}</style><h1>本轮受控验收 ${escape(stamp)}</h1><p>通过 ${results.filter(item => item.passed).length}/${results.length}。页面截图来自实际浏览器，接口仅在条件性建议用例使用受控响应。</p>${results.map(item => `<article><h2>${item.passed ? "PASS" : "FAIL"} ${escape(item.name)}</h2><pre>${escape(JSON.stringify(item.evidence, null, 2))}</pre>${item.evidence?.screenshot ? `<img src="${escape(item.evidence.screenshot)}">` : ""}</article>`).join("")}</html>`;
await writeFile(path.join(runDir, "round-two-report.html"), html, "utf8");
await writeFile(path.join(runDir, "round-two-results.json"), JSON.stringify(results, null, 2), "utf8");
console.log(path.join(runDir, "round-two-report.html"));
if (results.some(item => !item.passed)) process.exitCode = 1;
