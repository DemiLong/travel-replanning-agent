import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ActivityFactSchema, ConfirmedDraftSchema, RealSessionSchema, SemanticExtractionSchema, SnapshotSchema } from "../../types/index.ts";
import { ActivityCoverageError, DeepSeekSemanticParser, normalizeSemanticExtraction, uncoveredActivities } from "../../services/semantic-parser.ts";
import { confirmedDraftFromParsed } from "../../services/itinerary-domain.ts";
import { mergeConfirmedDraft, runAgentAssist } from "../../agents/agent-orchestrator.ts";
import { validatePlan } from "../../validators/index.ts";
import { browserSessionRepository, realSessionKey } from "../../services/trip-service.ts";
import { amapGet, WorldServiceError } from "../../services/world/amap-client.ts";
import { cityCompatible, uniquePlace } from "../../services/world/context-resolution.ts";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runMode = process.argv.includes("--live") ? "受控测试＋真实模型／高德测试" : "受控测试";
const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "runs", stamp);
const outputDir = runDir;
await mkdir(outputDir, { recursive: true });
async function launchBrowser() {
  const localBrowsers = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", ".playwright-browsers");
  try { await access(localBrowsers); process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers; } catch { /* Use default browser path. */ }
  const { chromium } = await import("@playwright/test");
  return chromium.launch({ headless: true });
}
const results = [];
async function check(name, fn) {
  try { results.push({ name, passed: true, evidence: await fn() }); }
  catch (error) { results.push({ name, passed: false, evidence: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}
const sources = { currentTime: "user", currentLocation: "user", weather: "unset", energyLevel: "unset", disruption: "user" };
const event = (id, name) => ({ id, placeId: `place-${id}`, name, category: "user activity", startTime: "15:00", endTime: "16:00",
  location: name, status: "planned", locked: false, indoorOutdoor: "mixed", openingTime: null, closingTime: null,
  travelTimeFromPrevious: null, reason: "用户原安排", constraint: "弹性安排" });
const snapshot = (itinerary = []) => SnapshotSchema.parse({ mode: "user", profile: { id: "qa", travelPace: "balanced", walkingTolerance: "medium" },
  trip: { id: "qa", destination: "上海", startDate: "2026-09-28", endDate: "2026-09-28" },
  state: { currentDate: "2026-09-28", currentTime: "12:00", stateCapturedAt: "2026-09-28T04:00:00.000Z", currentLocation: "上海人民广场" },
  stateSources: sources, itinerary, revision: 4 });
const extraction = activities => SemanticExtractionSchema.parse({ intent: "rescue", activities,
  disruptions: [{ kind: "late", label: "延误", sourceText: "晚点了" }], constraints: [], question: null, ambiguities: [],
  context: Object.fromEntries(["currentTime", "currentLocation", "weather", "energyLevel"].map(key => [key, { value: null, sourceText: null }])) });
const activity = (name, sourceText, extra = {}) => ({ role: "existing_plan", name, startTime: null, endTime: null,
  durationMinutes: null, location: name, locked: "no", progress: "not_started", sourceText, ...extra });
const fact = (id, name, extra = {}) => ActivityFactSchema.parse({ id, origin: "message", snapshotEventId: null, role: "existing_plan",
  progress: "not_started", name, placeQuery: name, startTime: null, startTimeSource: "not_provided",
  durationMinutes: null, commitment: "flexible", sourceText: name, ...extra });

await check("新增 A. 中文时间原文证据支持 18 点转 18:00，且不借用当前时间（受控）", async () => {
  const raw = "现在 16:00，我刚到静安寺地铁站，18 点必须到上海展览中心集合";
  const model = extraction([activity("到上海展览中心集合", "18 点必须到上海展览中心集合", {
    location: "上海展览中心", startTime: "18:00", startTimeEvidence: "18 点", locked: "yes" })]);
  model.context.currentTime = { value: "16:00", sourceText: "现在 16:00" };
  const parsed = normalizeSemanticExtraction(snapshot(), raw, model, "controlled");
  assert.equal(parsed.activityFacts[0].startTime, "18:00");
  assert.equal(parsed.activityFacts[0].commitment, "fixed");
  const wrong = normalizeSemanticExtraction(snapshot(), raw, { ...model, activities: [{ ...model.activities[0], startTimeEvidence: "16:00" }] }, "controlled");
  assert.equal(wrong.activityFacts[0].startTime, null);
  const nowRaw = "现在 16:00，我准备去吃饭";
  const nowModel = extraction([activity("去吃饭", nowRaw, { location: "餐厅", startTime: "16:00", startTimeEvidence: "16:00" })]);
  nowModel.context.currentTime = { value: "16:00", sourceText: "现在 16:00" };
  assert.equal(normalizeSemanticExtraction(snapshot(), nowRaw, nowModel, "controlled").activityFacts[0].startTime, "16:00");
  return { normalizedTime: parsed.activityFacts[0].startTime, currentTimeNotBorrowed: true, nowActivityAllowed: true };
});

await check("新增 B. 已确认上海时不复用北京同名 POI，显式北京目的地例外（受控）", async () => {
  const beijing = { poiId: "bj", name: "平安国际金融中心", city: "北京市" };
  assert.equal(cityCompatible(beijing, "上海市", "国金中心"), false);
  assert.equal(uniquePlace([beijing], "国金中心", "上海市"), null);
  assert.equal(cityCompatible(beijing, "上海市", "北京平安国际金融中心"), true);
  return { rejected: beijing.poiId, retainedExplicitCrossCity: true };
});

await check("新增 C. 纯比较备选目的地直接返回产品边界文案（受控）", async () => {
  const raw = "现在 9:30，我在龙阳路地铁站，还在考虑今天去迪士尼度假区还是海昌海洋公园，还没决定，先帮我看看两个的情况？";
  const model = SemanticExtractionSchema.parse({ ...extraction([]), intent: "optimize", disruptions: [], activities: [
    activity("迪士尼度假区", "还在考虑今天去迪士尼度假区", { role: "considering", location: "迪士尼度假区" }),
    activity("海昌海洋公园", "还是海昌海洋公园", { role: "considering", location: "海昌海洋公园" }),
  ], context: { currentTime: { value: "09:30", sourceText: "现在 9:30" }, currentLocation: { value: "龙阳路地铁站", sourceText: "我在龙阳路地铁站" }, weather: { value: null, sourceText: null }, energyLevel: { value: null, sourceText: null } } });
  const parsed = normalizeSemanticExtraction(snapshot(), raw, model, "controlled");
  const result = await runAgentAssist({ snapshot: snapshot(), rawText: raw }, undefined, { parse: async () => parsed });
  assert.equal(result.status, "OUT_OF_SCOPE");
  assert.equal(result.message, "我只能帮助你救回已确定的行程，暂时不支持对比多个备选目的地哟");
  return { status: result.status, message: result.message };
});

await check("1. 多个无时间弹性原安排首次提交直达地点查询且不问原定几点（受控）", async () => {
  const base = snapshot();
  const parsed = normalizeSemanticExtraction(base, "晚点了，原计划去上海静安寺，再去上海自然博物馆，请重新安排", extraction([
    activity("上海静安寺", "原计划去上海静安寺"), activity("上海自然博物馆", "再去上海自然博物馆"),
  ]), "qa");
  assert.equal(parsed.activityFacts.filter(x => x.role === "existing_plan").length, 2);
  assert.ok(parsed.activityFacts.every(x => x.startTime === null));
  assert.ok(parsed.missingFacts.every(x => !x.endsWith(":startTime")));
  const clockExtraction = extraction([
    activity("上海静安寺", "现在13:00，原计划去上海静安寺", { startTime: "13:00" }),
  ]);
  clockExtraction.context.currentTime = { value: "13:00", sourceText: "现在13:00" };
  const clockOnly = normalizeSemanticExtraction(base, "晚点了，现在13:00，原计划去上海静安寺", clockExtraction, "qa");
  assert.equal(clockOnly.activityFacts[0].startTime, null);
  const draft = confirmedDraftFromParsed(base, parsed);
  assert.equal(draft.activityFacts.length, 2);
  let groundedRequest = null;
  const direct = await runAgentAssist({ snapshot: base, rawText: parsed.rawText }, undefined, {
    parse: async () => parsed,
    ground: async input => { groundedRequest = input.request; return { status: "ready", currentLocation: { city: "上海" },
      resolvedPlaces: [], alternatives: [], routes: [], missingWorldFacts: [], ambiguities: [], resolutionEvidence: [] }; },
    replan: async () => ({ ok: true, plan: { summary: "受控方案", explanation: "逐项安排", events: draft.activityFacts.map((item, index) => ({
      ...event(item.id, item.name), startTime: `${13 + index}:00`, endTime: `${14 + index}:00`,
      startTimeSource: "suggested", durationSource: "suggested" })), movedEvents: [], removedEvents: [] } }),
  });
  assert.equal(direct.status, "READY");
  assert.deepEqual(groundedRequest.originalActivityIds, draft.activityFacts.map(x => x.id));
  assert.ok(groundedRequest.unscheduledOriginals.every(x => x.startTime === null));
  assert.deepEqual(direct.result.plan.events.map(x => x.id), groundedRequest.originalActivityIds);
  return { ids: draft.activityFacts.map(x => x.id), startTimes: draft.activityFacts.map(x => x.startTime),
    groundedOriginalIds: groundedRequest.originalActivityIds, status: direct.status };
});

await check("2. 没完成的原计划与已完成活动保持不同进度", () => {
  const parsed = normalizeSemanticExtraction(snapshot(), "晚点了，原计划去上海人民公园但没来得及，上海博物馆人民广场馆已经完成", extraction([
    activity("上海人民公园", "原计划去上海人民公园但没来得及", { role: "reference" }),
    activity("上海博物馆人民广场馆", "上海博物馆人民广场馆已经完成", { role: "reference", progress: "completed" }),
  ]), "qa");
  assert.equal(parsed.activityFacts[0].role, "existing_plan");
  assert.equal(parsed.activityFacts[0].progress, "missed");
  assert.equal(parsed.activityFacts[1].progress, "completed");
  assert.ok(confirmedDraftFromParsed(snapshot(), parsed).activityFacts.some(x => x.progress === "missed" && x.role === "existing_plan"));
  return parsed.activityFacts.map(({ name, role, progress }) => ({ name, role, progress }));
});

await check("3. 首次提交直达规划，已识别误分类纠正且已保存活动自动带入（受控）", async () => {
  const base = snapshot();
  const raw = "晚点了，原计划去上海静安寺，请重新安排";
  const parsed = normalizeSemanticExtraction(base, raw, extraction([activity("上海静安寺", "原计划去上海静安寺", { role: "reference" })]), "qa");
  let groundedIds = [];
  const direct = await runAgentAssist({ snapshot: base, rawText: raw }, undefined, {
    parse: async () => parsed, ground: async input => { groundedIds = input.request.originalActivityIds; throw Error("受控地点服务停止"); },
  });
  assert.equal(direct.status, "UPSTREAM_UNAVAILABLE");
  assert.equal(direct.parsedInput.activityFacts[0].role, "existing_plan");
  assert.deepEqual(groundedIds, [direct.parsedInput.activityFacts[0].id]);
  const omitted = normalizeSemanticExtraction(base, raw, extraction([]), "qa");
  const emptyResult = await runAgentAssist({ snapshot: base, rawText: raw }, undefined, { parse: async () => omitted });
  assert.equal(emptyResult.status, "OUT_OF_SCOPE");
  const savedBase = snapshot([event("saved-omitted", "上海静安寺")]);
  const savedOmission = normalizeSemanticExtraction(savedBase, raw, extraction([]), "qa");
  let savedIds = [];
  const savedResult = await runAgentAssist({ snapshot: savedBase, rawText: raw }, undefined, {
    parse: async () => savedOmission, ground: async input => { savedIds = input.request.originalActivityIds; throw Error("受控地点服务停止"); },
  });
  assert.equal(savedResult.status, "UPSTREAM_UNAVAILABLE");
  assert.deepEqual(savedIds, ["saved-omitted"]);
  return { status: direct.status, autoCorrectedRole: direct.parsedInput.activityFacts[0].role,
    savedIds, zeroExtractionStatus: emptyResult.status,
    limitation: "同一份解析结果无法证明模型没有漏识别原文中的活动。" };
});

await check("3a. 独立原文覆盖检查发现合并或漏项时禁止缺项 READY（受控）", async () => {
  const coverage = [
    { name: "上海静安寺", sourceText: "原计划去上海静安寺", role: "existing_plan" },
    { name: "上海自然博物馆", sourceText: "再去上海自然博物馆", role: "existing_plan" },
  ];
  const combined = [fact("combined", "上海静安寺和上海自然博物馆")];
  const missing = uncoveredActivities(coverage, combined);
  assert.equal(missing.length, 1);
  const result = await runAgentAssist({ snapshot: snapshot(), rawText: "晚点了，原计划去上海静安寺，再去上海自然博物馆" },
    undefined, { parse: async () => { throw new ActivityCoverageError(missing); } });
  assert.equal(result.status, "UPSTREAM_UNAVAILABLE");
  assert.match(result.message, /不会生成缺项方案/);
  return { independentNames: coverage.map(item => item.name), combinedFactId: combined[0].id,
    missingNames: missing.map(item => item.name), resultStatus: result.status };
});

await check("3b. 正常解析不再默认发起独立覆盖调用（受控）", async () => {
  const base = snapshot();
  const raw = "晚点了，原计划去上海静安寺，再去上海自然博物馆，请重新安排";
  const first = extraction([activity("上海静安寺", "原计划去上海静安寺")]);
  const fakeParser = outputs => {
    const parser = Object.create(DeepSeekSemanticParser.prototype);
    parser.model = "controlled";
    parser.client = { responses: { parse: async () => ({ status: "completed", output_parsed: outputs.shift() }) } };
    return parser;
  };
  const stages = [];
  const recovered = await fakeParser([first]).parse(base, raw, undefined, undefined,
    (stage, value) => stages.push({ stage, value }));
  assert.equal(recovered.activityFacts.filter(item => item.role === "existing_plan").length, 1);
  assert.ok(!stages.some(item => item.stage === "conditional_coverage"));
  return { stages: stages.map(item => item.stage), names: recovered.activityFacts.map(item => item.name), limitation: "没有冲突信号的模型漏项不能被本次解析自行发现。" };
});

await check("3c. 高德错误按安全类别与代码记录，不泄露密钥（受控）", async () => {
  const previousFetch = globalThis.fetch, previousKey = process.env.AMAP_API_KEY;
  try {
    process.env.AMAP_API_KEY = "qa-placeholder-key";
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "0", infocode: "10021" }), { status: 200 });
    await assert.rejects(() => amapGet("/v3/place/text", { keywords: "上海人民广场", qa: crypto.randomUUID() }),
      error => error instanceof WorldServiceError && error.code === "MAP_PROVIDER_ERROR" && error.detail === "10021" &&
        !error.message.includes("qa-placeholder-key"));
    return { category: "MAP_PROVIDER_ERROR", providerCode: "10021", keyPresentInError: false };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.AMAP_API_KEY;
    else process.env.AMAP_API_KEY = previousKey;
  }
});

await check("4. 已保存弹性活动从草稿消失且无删除记录时合并拒绝", () => {
  const base = snapshot([event("saved", "上海静安寺")]);
  const draft = ConfirmedDraftSchema.parse({ rawText: "晚点了", intent: "rescue", existingPlans: [], activityMentions: [],
    disruptions: [{ kind: "late", label: "延误", source: "user" }], constraints: [], context: base.state,
    contextSources: sources, closedPlaceIds: [], baseRevision: base.revision });
  assert.throws(() => mergeConfirmedDraft(base, draft), /不能被静默删除/);
  const explicit = ConfirmedDraftSchema.parse({ ...draft, removedOriginalIds: ["saved"] });
  assert.equal(mergeConfirmedDraft(base, explicit).itinerary.length, 0);
  return { savedId: "saved", silentDeletionRejected: true, explicitDeletionAccepted: true };
});

await check("5. 候选漏掉已确认原安排 ID 时校验拒绝", () => {
  const base = snapshot(); const ids = ["one", "two"];
  const context = { profile: base.profile, trip: base.trip, state: base.state, stateSources: sources, existingItinerary: [],
    remainingEvents: [], unscheduledOriginals: [fact(ids[0], "上海静安寺"), fact(ids[1], "上海自然博物馆")], originalActivityIds: ids,
    lockedEvents: [], disruption: { reason: "late", freeText: "晚点了", currentState: base.state, closedPlaceIds: [], variation: 0 },
    places: [], travelMinutes: {} };
  const errors = validatePlan(context, { summary: "候选", explanation: "待核对", events: [], movedEvents: [], removedEvents: [] });
  assert.deepEqual(errors.filter(x => x.code === "change_accounting").map(x => x.eventId), ids);
  const change = { eventId: ids[0], name: "上海静安寺", reason: "主动放弃", constraint: "弹性安排" };
  const duplicate = validatePlan(context, { summary: "候选", explanation: "待核对", events: [], movedEvents: [], removedEvents: [change, change] });
  assert.ok(duplicate.some(x => x.code === "change_accounting" && x.eventId === ids[0]));
  const emptyReason = validatePlan(context, { summary: "候选", explanation: "待核对", events: [], movedEvents: [], removedEvents: [{ ...change, reason: "" }] });
  assert.ok(emptyReason.some(x => x.code === "schema"));
  return { expectedOriginalCount: ids.length, missingIds: ids, duplicateRejected: true, emptyReasonRejected: true };
});

await check("6. 新提交请求排除旧草稿和答案，计数归零且 revision 不变", () => {
  const base = snapshot();
  const freshRequest = { snapshot: base, rawText: "现在在上海人民广场，原计划去上海静安寺，行程延误了，请重新安排", resolutionState: {
    currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [],
  } };
  assert.equal("confirmedDraft" in freshRequest, false); assert.equal("answer" in freshRequest, false);
  assert.equal(freshRequest.resolutionState.roundCount, 0); assert.equal(freshRequest.snapshot.revision, 4);
  const raw = "晚点了，原计划去上海静安寺，请重新安排";
  const parsed = normalizeSemanticExtraction(base, raw, extraction([activity("上海静安寺", "原计划去上海静安寺")]), "qa");
  const draft = confirmedDraftFromParsed(base, parsed);
  const saved = RealSessionSchema.parse({ schemaVersion: 3, experienceMode: "real", flowStage: "NEEDS_INPUT",
    snapshot: { ...base, revision: 5 }, rawInput: raw, parsedInput: parsed, lastDisruption: null, pendingPlan: null,
    pendingInput: { stage: "review", parsedInput: parsed, confirmedDraft: draft, missingFact: null,
      questionRawText: raw, baseRevision: 4 },
    resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 1, answeredFields: [], questionHistory: [] },
    updatedAt: new Date().toISOString() });
  const storage = new Map([[realSessionKey, JSON.stringify(saved)]]);
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const restored = browserSessionRepository.load();
  assert.equal(restored.pendingInput, null);
  assert.equal(restored.snapshot.revision, 5);
  storage.set(realSessionKey, JSON.stringify({ ...saved, snapshot: base, pendingInput: { ...saved.pendingInput, baseRevision: base.revision } }));
  const legacyReview = browserSessionRepository.load();
  assert.equal(legacyReview.pendingInput, null);
  assert.equal(legacyReview.snapshot.revision, base.revision);
  assert.equal(legacyReview.rawInput, raw);
  assert.equal(JSON.parse(storage.get(realSessionKey)).pendingInput, null);
  return { requestKeys: Object.keys(freshRequest), roundCount: 0, revision: base.revision,
    stalePendingInputDiscarded: true, legacyReviewExited: true, limitation: "页面请求和刷新另由浏览器场景验证。" };
});

await check("7. 受控双 POI 补问选择首项后继续到最终状态", async () => {
  const base = snapshot(); const raw = "晚点了，原计划去上海博物馆，请重新安排";
  const parsed = normalizeSemanticExtraction(base, raw, extraction([activity("上海博物馆", "原计划去上海博物馆")]), "qa");
  const field = `custom-${parsed.activityFacts[0].id}`;
  const candidates = [{ poiId: "poi-1", name: "上海博物馆人民广场馆", address: "上海市黄浦区人民大道201号", city: "上海" },
    { poiId: "poi-2", name: "上海博物馆东馆", address: "上海市浦东新区世纪大道1952号", city: "上海" }];
  const deps = { ground: async input => {
    const selected = input.request.worldOptions?.selectedPois?.[field];
    return { status: selected ? "ready" : "needs_input", currentLocation: { city: "上海" },
      resolvedPlaces: selected ? [{ placeId: field, poi: candidates[0] }] : [], alternatives: [], routes: [],
      missingWorldFacts: [], ambiguities: selected ? [] : [{ field, label: "上海博物馆", candidates }], resolutionEvidence: [] };
  }, replan: async () => ({ ok: true, plan: { summary: "建议", explanation: "地点已选",
    events: [{ ...event(parsed.activityFacts[0].id, "上海博物馆"), placeId: field,
      startTime: "13:00", endTime: "14:00", startTimeSource: "suggested", durationSource: "suggested" }],
    movedEvents: [], removedEvents: [] } }) };
  const asked = await runAgentAssist({ snapshot: base, rawText: raw }, undefined, { ...deps, parse: async () => parsed });
  assert.equal(asked.status, "NEEDS_INPUT"); assert.equal(asked.missingFact.candidates[0].value, "poi-1");
  const done = await runAgentAssist({ snapshot: base, confirmedDraft: asked.confirmedDraft,
    resolutionState: asked.resolutionState, answer: { kind: "poi", field, poiId: "poi-1" } }, undefined, deps);
  assert.equal(done.status, "READY");
  assert.equal(done.result.plan.events[0].id, parsed.activityFacts[0].id);
  return { candidates: candidates.map(x => x.poiId), selected: "poi-1", finalStatus: done.status,
    limitation: "地图与规划服务为受控替身；此断言验证补问状态链路。" };
});

await check("8. 固定预约时间未知只能返回未验证的条件建议", async () => {
  const base = snapshot(); const raw = "晚点了，原计划去上海国金中心商场鼎泰丰吃饭，已经预约，请重新安排";
  const parsed = normalizeSemanticExtraction(base, raw, extraction([activity("上海国金中心商场鼎泰丰", "原计划去上海国金中心商场鼎泰丰吃饭，已经预约", { locked: "yes" })]), "qa");
  const result = await runAgentAssist({ snapshot: base, rawText: raw }, undefined, { parse: async () => parsed });
  assert.equal(result.status, "CONDITIONAL"); assert.match(result.message, /预约时间未提供/);
  return { status: result.status, message: result.message };
});

await check("8a. 仅对分类不确定的活动单项补问，回答后继续规划（受控）", async () => {
  const base = snapshot(); const raw = "晚点了，去上海自然博物馆这项再安排一下";
  const parsed = normalizeSemanticExtraction(base, raw, extraction([
    activity("上海自然博物馆", "去上海自然博物馆", { role: "uncertain", locked: "uncertain" }),
  ]), "qa");
  assert.equal(parsed.activityFacts[0].commitment, "flexible");
  const asked = await runAgentAssist({ snapshot: base, rawText: raw }, undefined, { parse: async () => parsed });
  assert.equal(asked.status, "NEEDS_INPUT");
  assert.match(asked.missingFact.key, /:role$/);
  assert.equal(asked.confirmedDraft.activityFacts.length, 1);
  let groundedIds = [];
  const answered = await runAgentAssist({ snapshot: base, confirmedDraft: asked.confirmedDraft,
    answer: { kind: "text", field: asked.missingFact.key, value: "existing_plan" }, resolutionState: asked.resolutionState },
  undefined, { ground: async input => { groundedIds = input.request.originalActivityIds; throw Error("受控地点服务停止"); } });
  assert.equal(answered.status, "UPSTREAM_UNAVAILABLE");
  assert.deepEqual(groundedIds, [parsed.activityFacts[0].id]);
  return { blocker: asked.missingFact.key, candidates: asked.missingFact.candidates.map(x => x.value), groundedIds };
});

await check("9. 页面改写原文后重提，不带旧答案且刷新不恢复旧补问（受控）", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  try {
    const base = snapshot([event("saved-ui", "上海静安寺")]);
    const session = RealSessionSchema.parse({ schemaVersion: 3, experienceMode: "real", flowStage: "HAS_ITINERARY", snapshot: base,
      rawInput: "", parsedInput: null, lastDisruption: null, pendingPlan: null,
      resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] },
      updatedAt: new Date().toISOString() });
    const requests = [];
    const impact = { completedActivities: [], preservedActivities: ["saved-ui"], affectedActivities: [], modifiedActivities: [],
      removedActivities: [], riskActivities: [], lockedActivities: [], replacementCandidates: [], availableTimeWindows: [] };
    const rawOld = "晚点了，原计划去上海静安寺，请重新安排";
    const rawNew = "晚点了，现在在上海人民广场，原计划去上海自然博物馆，请重新安排";
    await page.route("**/api/assist", async route => {
      const payload = route.request().postDataJSON(); requests.push(payload);
      const old = requests.length === 1;
      const raw = old ? rawOld : rawNew;
      const parsed = normalizeSemanticExtraction(base, raw, extraction([activity(old ? "上海静安寺" : "上海自然博物馆",
        old ? "原计划去上海静安寺" : "原计划去上海自然博物馆")]), "qa");
      const draft = confirmedDraftFromParsed(base, parsed);
      const key = old ? "currentLocation" : "destination";
      const question = old ? "现在在哪里？" : "目的地是哪里？";
      const resolutionState = { currentBlockerKey: key, sameBlockerCount: 1, roundCount: 1, answeredFields: [], questionHistory: [key] };
      const body = { status: "NEEDS_INPUT", parsedInput: parsed, confirmedDraft: draft, impactAnalysis: impact,
        missingFact: { key, field: key, importance: "blocking", reason: question, question, answerType: "text" }, resolutionState };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("http://127.0.0.1:3000/");
    await page.evaluate(value => localStorage.setItem("travel-session-real-v3", JSON.stringify(value)), session);
    await page.reload();
    await page.getByLabel("描述今天的安排和变化").fill(rawOld);
    await page.getByRole("button", { name: "帮我重新安排今天" }).click();
    await page.getByRole("dialog", { name: "补充必要信息" }).waitFor();
    await page.getByLabel("描述今天的安排和变化").fill(rawNew);
    await page.getByRole("button", { name: "按新描述重新分析" }).click();
    await page.getByRole("heading", { name: "目的地是哪里？" }).waitFor();
    assert.equal(await page.getByText("我识别到的原安排").count(), 0);
    assert.equal(requests.length, 2);
    assert.deepEqual(Object.keys(requests[1]).sort(), ["rawText", "resolutionState", "snapshot"].sort());
    assert.equal(requests[1].resolutionState.roundCount, 0);
    assert.equal(requests[1].snapshot.revision, base.revision);
    await page.screenshot({ path: path.join(runDir, "ui-reanalysis.png"), fullPage: true });
    await page.reload();
    await page.getByRole("heading", { name: "目的地是哪里？" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "现在在哪里？" }).count(), 0);
    const result = { requestKeys: Object.keys(requests[1]), roundCount: requests[1].resolutionState.roundCount,
      revision: requests[1].snapshot.revision, oldFollowUpAfterReload: false,
      limitation: "API 解析响应为受控替身；截图展示真实页面交互。" };
    await context.tracing.stop({ path: path.join(runDir, "ui-trace.zip") });
    return result;
  } finally { await browser.close(); }
});
if (results.at(-1)?.passed) results.at(-1).screenshot = "ui-reanalysis.png";

await check("10. 返回编辑时保留旧方案，提交新描述才使其失效（受控）", async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  try {
    const base = snapshot([event("saved-result", "上海自然博物馆")]);
    const raw = "晚点了，原计划去上海自然博物馆，请重新安排";
    const parsed = normalizeSemanticExtraction(base, raw, extraction([activity("上海自然博物馆", "原计划去上海自然博物馆")]), "qa");
    const request = { reason: "late", freeText: raw, currentState: base.state, closedPlaceIds: [], variation: 0,
      stateSources: sources, originalActivityIds: ["saved-result"] };
    const plan = { summary: "调整后的行程", explanation: "受控方案", events: [event("saved-result", "上海自然博物馆")], movedEvents: [], removedEvents: [] };
    const result = { id: "controlled-result", ok: true, plan, attempts: [], mode: "live", model: "controlled", message: "可执行",
      context: { profile: base.profile, trip: base.trip, state: base.state, stateSources: sources,
        existingItinerary: base.itinerary, lockedEvents: [], remainingEvents: base.itinerary,
        disruption: request, places: [], travelMinutes: {} } };
    const session = RealSessionSchema.parse({ schemaVersion: 3, experienceMode: "real", flowStage: "PLAN_READY", snapshot: base,
      rawInput: "", parsedInput: parsed, lastDisruption: request,
      pendingPlan: { result, base, request, accepted: false, parsedInput: parsed },
      resolutionState: { currentBlockerKey: "currentLocation", sameBlockerCount: 1, roundCount: 1, answeredFields: [], questionHistory: ["currentLocation"] },
      updatedAt: new Date().toISOString() });
    let assistCalls = 0;
    await page.route("**/api/assist", async route => { assistCalls++; await route.abort(); });
    await page.goto("http://127.0.0.1:3000/");
    await page.evaluate(value => localStorage.setItem("travel-session-real-v3", JSON.stringify(value)), session);
    await page.goto("http://127.0.0.1:3000/result");
    await page.getByRole("button", { name: "结果有误？点击重新规划" }).waitFor();
    await page.screenshot({ path: path.join(runDir, "ui-result-before.png"), fullPage: true });
    await page.getByRole("button", { name: "结果有误？点击重新规划" }).click();
    await page.getByLabel("描述今天的安排和变化").waitFor();
    assert.equal(await page.getByLabel("描述今天的安排和变化").inputValue(), raw);
    assert.equal(assistCalls, 0);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("travel-session-real-v3")));
    assert.equal(stored.pendingPlan?.result.id, "controlled-result");
    assert.equal(stored.pendingInput, null);
    assert.equal(stored.resolutionState.roundCount, 0);
    assert.equal(stored.snapshot.revision, base.revision);
    assert.deepEqual(stored.snapshot.itinerary, base.itinerary);
    await page.screenshot({ path: path.join(runDir, "ui-result-replan.png"), fullPage: true });
    await page.getByRole("link", { name: "返回上一个方案" }).click();
    await page.getByRole("button", { name: "接受方案" }).waitFor();
    return { rawRestored: raw, assistCalls, pendingPlan: stored.pendingPlan, revision: stored.snapshot.revision,
      itineraryIds: stored.snapshot.itinerary.map(x => x.id), beforeScreenshot: "ui-result-before.png", afterScreenshot: "ui-result-replan.png" };
  } finally { await browser.close(); }
});
if (results.at(-1)?.passed) results.at(-1).screenshot = "ui-result-replan.png";

if (process.argv.includes("--live")) await check("11. 真实模型与高德：地点多候选时选择首项并走完整链路", async () => {
  const base = snapshot();
  base.trip.destination = "上海";
  base.state.currentTime = "13:00";
  base.state.currentLocation = "上海人民广场";
  const raw = "现在13:00，我在上海人民广场。今天原计划去上海静安寺。今天还原计划去上海自然博物馆。起晚了，请帮我重新安排这两个地方。";
  let current = await runAgentAssist({ snapshot: base, rawText: raw });
  const originals = current.parsedInput?.activityFacts.filter(x => x.role === "existing_plan" && x.progress !== "completed") ?? [];
  assert.equal(originals.length, 2);
  const questions = [];
  for (let round = 0; round < 5 && current.status === "NEEDS_INPUT"; round++) {
    const blocker = current.missingFact;
    questions.push({ key: blocker.key, candidates: blocker.candidates?.length ?? 0,
      firstPoiId: blocker.candidates?.[0]?.value ?? null });
    if (!blocker.candidates?.length) break;
    const answer = blocker.answerType === "poi"
      ? { kind: "poi", field: blocker.key, poiId: blocker.candidates[0].value }
      : { kind: "text", field: blocker.key, value: blocker.candidates[0].value };
    current = await runAgentAssist({ snapshot: base, confirmedDraft: current.confirmedDraft,
      resolutionState: current.resolutionState, answer });
  }
  assert.equal(current.status, "READY", JSON.stringify({ status: current.status, message: current.message, questions,
    attempts: current.result?.attempts, comparisons: current.result?.candidateComparisons }));
  const plan = current.result.plan;
  const accounted = new Set([...plan.events.map(x => x.id), ...plan.removedEvents.map(x => x.eventId)]);
  assert.ok(originals.every(x => accounted.has(x.id)));
  const originalIds = new Set(originals.map(x => x.id));
  const retained = plan.events.filter(x => originalIds.has(x.id));
  assert.ok(retained.every(x => x.startTimeSource === "suggested"));
  assert.ok(current.result.context.world.resolvedPlaces.some(x => x.poi.source === "amap"));
  return { status: current.status, questions, originalIds: originals.map(x => x.id),
    retained: retained.map(x => ({ id: x.id, startTime: x.startTime, startTimeSource: x.startTimeSource })),
    removedIds: plan.removedEvents.map(x => x.eventId),
    groundedPoiIds: current.result.context.world.resolvedPlaces.map(x => x.poi.poiId) };
});

const escape = x => String(x).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let browserNote = "截图未生成";
try {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  for (const [i, result] of results.entries()) {
    await page.setContent(`<html><meta charset="utf-8"><style>body{font:18px/1.6 system-ui;padding:40px;background:#f3f8f5;color:#183029}.card{background:white;padding:30px;border:1px solid #ccd9d1;border-radius:16px;max-width:900px}pre{white-space:pre-wrap;font:14px/1.5 Consolas;background:#f7faf8;padding:16px}</style><div class="card"><h1>${escape(result.name)}</h1><b>${result.passed ? "PASS" : "FAIL"}</b><pre>${escape(JSON.stringify(result.evidence, null, 2))}</pre></div></html>`);
    if (!result.screenshot) {
      result.screenshot = `assertion-${i + 1}.png`;
      await page.screenshot({ path: path.join(runDir, result.screenshot), fullPage: true });
    }
  }
  await context.tracing.stop({ path: path.join(runDir, "trace.zip") });
  await browser.close();
  browserNote = "各断言截图与 trace.zip 已保存。截图为断言证据卡，不是地图服务实况。";
} catch (error) { browserNote = `Playwright 截图不可用：${error instanceof Error ? error.message : String(error)}`; }
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>活动完整性验收</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto;color:#183029}article{padding:20px;margin:18px 0;border:1px solid #ccd9d1;border-radius:12px}pre{white-space:pre-wrap;background:#f5f8f6;padding:14px}.pass{color:#087b4a}.fail{color:#b23434}img{max-width:100%;border:1px solid #ddd}</style><h1>活动完整性验收 · ${escape(stamp)}</h1><p>类型：${escape(runMode)}。通过 ${results.filter(x => x.passed).length}/${results.length}。${escape(browserNote)}</p>${results.map(r => `<article><h2 class="${r.passed ? "pass" : "fail"}">${r.passed ? "PASS" : "FAIL"} · ${escape(r.name)}</h2><pre>${escape(JSON.stringify(r.evidence, null, 2))}</pre>${r.screenshot ? `<a href="${r.screenshot}">对应截图</a><br><img src="${r.screenshot}" alt="断言截图">` : "截图未生成"}${r.evidence?.beforeScreenshot ? `<p><a href="${escape(r.evidence.beforeScreenshot)}">点击前的结果页截图</a></p>` : ""}</article>`).join("")}</html>`;
await writeFile(path.join(runDir, "report.html"), html, "utf8");
await writeFile(path.join(runDir, "results.json"), JSON.stringify({ stamp, runMode, browserNote, results }, null, 2), "utf8");
await writeFile(path.join(runDir, "run.log"), results.map(item => `${item.passed ? "PASS" : "FAIL"} ${item.name}`).join("\n") + "\n", "utf8");
console.log(path.join(runDir, "report.html"));
if (results.some(x => !x.passed)) process.exitCode = 1;
