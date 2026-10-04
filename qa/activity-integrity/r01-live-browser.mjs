import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RealSessionSchema, SnapshotSchema } from "../../types/index.ts";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "runs", stamp);
await mkdir(runDir, { recursive: true });
const browsers = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", ".playwright-browsers");
try { await access(browsers); process.env.PLAYWRIGHT_BROWSERS_PATH = browsers; } catch { /* Use installed browser. */ }
const { chromium } = await import("@playwright/test");
const rawText = "现在13:00，我在上海人民广场。现在下雨了，我原定15:00去上海国金中心商场，18:00去外滩观景平台散步，请帮我重新安排。";
const sources = { currentTime: "user", currentLocation: "user", weather: "unset", energyLevel: "unset", disruption: "unset" };
const base = SnapshotSchema.parse({ mode: "user", profile: { id: "qa", travelPace: "balanced", walkingTolerance: "medium" },
  trip: { id: "qa-r01", destination: "上海", startDate: "2026-09-28", endDate: "2026-09-28" },
  state: { currentDate: "2026-09-28", currentTime: "13:00", stateCapturedAt: new Date().toISOString(), currentLocation: "上海人民广场" },
  stateSources: sources, itinerary: [], revision: 0 });
const session = RealSessionSchema.parse({ schemaVersion: 4, experienceMode: "real", flowStage: "NO_ITINERARY", snapshot: base,
  rawInput: "", parsedInput: null, lastDisruption: null, pendingPlan: null,
  resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] },
  updatedAt: new Date().toISOString() });
const evidence = { type: "真实模型／高德／实际页面", rawText, freshRevision: base.revision, responses: [], selectedCandidates: [], screenshots: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 1300 } });
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
page.on("response", async response => {
  if (!response.url().endsWith("/api/assist")) return;
  try {
    const body = await response.json();
    const sourceById = new Map((body.parsedInput?.activityFacts ?? []).map(fact => [fact.id, fact.sourceText]));
    evidence.responses.push({ status: body.status, message: body.message ?? null,
      facts: body.parsedInput?.activityFacts?.map(({ id, name, sourceText, role }) => ({ id, name, sourceText, role })) ?? [],
      activityFactIds: body.request?.activityFacts?.map(fact=>fact.id) ?? null,
      plan: body.result?.plan ? { summary: body.result.plan.summary, explanation: body.result.plan.explanation,
        events: body.result.plan.events.map(({ id, name, reason }) => ({ id, name, sourceText: sourceById.get(id) ?? null, reason })),
        removedEvents: body.result.plan.removedEvents.map(({ eventId, name, reason }) => ({ eventId, name, sourceText: sourceById.get(eventId) ?? null, reason })) } : null });
  } catch { evidence.responses.push({ status: "UNREADABLE_RESPONSE" }); }
});
try {
  await page.goto("http://127.0.0.1:3000/");
  await page.evaluate(value => localStorage.setItem("travel-session-real-v4", JSON.stringify(value)), session);
  await page.reload();
  await page.getByLabel("描述今天的安排和变化").fill(rawText);
  await page.getByRole("button", { name: "帮我重新安排今天" }).click();
  for (let round = 0; round < 5; round++) {
    await page.waitForFunction(() => location.pathname === "/result" || Boolean(document.querySelector('[role="dialog"][aria-label="补充必要信息"]')) ||
      Boolean(document.querySelector('[role="alert"]')), undefined, { timeout: 120000 });
    if (new URL(page.url()).pathname === "/result") break;
    if (evidence.responses.some(item => ["NO_SAFE_PLAN", "OUT_OF_SCOPE", "UPSTREAM_UNAVAILABLE", "CONDITIONAL"].includes(item.status))) break;
    const dialog = page.getByRole("dialog", { name: "补充必要信息" });
    if (await dialog.count()) {
      const question = await dialog.locator("h2").innerText();
      const candidates = dialog.locator(".poi-option");
      const count = await candidates.count();
      evidence.selectedCandidates.push({ question, candidateCount: count, first: count ? await candidates.first().innerText() : null });
      const file = `follow-up-${round + 1}.png`;
      await page.screenshot({ path: path.join(runDir, file), fullPage: true });
      evidence.screenshots.push(file);
      if (!count) break;
      const [reply] = await Promise.all([page.waitForResponse(response => response.url().endsWith("/api/assist"), { timeout: 120000 }), candidates.first().click()]);
      const replyBody = await reply.json();
      if (!["NEEDS_INPUT", "READY"].includes(replyBody.status)) break;
      await page.waitForTimeout(300);
      continue;
    }
    break;
  }
  evidence.finalUrl = page.url();
  evidence.finalStatus = new URL(page.url()).pathname === "/result" ? "READY" : "真实验收未通过";
  if (evidence.finalStatus === "READY") {
    await page.getByRole("button", { name: "接受方案" }).waitFor();
    const plan = evidence.responses.findLast(item => item.status === "READY")?.plan;
    const ids = evidence.responses.findLast(item => item.status === "READY")?.activityFactIds ?? [];
    const accounted = [...(plan?.events.map(event => event.id) ?? []), ...(plan?.removedEvents.map(event => event.eventId) ?? [])];
    evidence.activityAccounting = { expectedIds: ids, accountedIds: accounted,
      complete: ids.length === 2 && ids.every(id => accounted.filter(value => value === id).length === 1) };
    if (!evidence.activityAccounting.complete) evidence.finalStatus = "真实验收未通过";
    await page.screenshot({ path: path.join(runDir, "result.png"), fullPage: true });
    evidence.screenshots.push("result.png");
    await page.getByRole("button", { name: "查看我的情况分析" }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(runDir, "analysis.png"), fullPage: true });
    evidence.screenshots.push("analysis.png");
  } else {
    evidence.visibleError = await page.getByRole("alert").allInnerTexts();
    await page.screenshot({ path: path.join(runDir, "blocked.png"), fullPage: true });
    evidence.screenshots.push("blocked.png");
  }
} catch (error) {
  evidence.finalStatus = "真实验收未通过";
  evidence.failure = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: path.join(runDir, "blocked.png"), fullPage: true }).catch(() => {});
  evidence.screenshots.push("blocked.png");
} finally {
  await context.tracing.stop({ path: path.join(runDir, "r01-live-trace.zip") });
  await browser.close();
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>R01 真实页面验收</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f6;padding:12px}img{max-width:100%;border:1px solid #ddd}</style><h1>R01 ${escape(evidence.finalStatus)}</h1><p>全新会话 · 原句 · 真实模型／高德 · 地点多候选选择第一项</p><pre>${escape(JSON.stringify(evidence, null, 2))}</pre>${evidence.screenshots.map(file => `<p><a href="${file}">${file}</a><br><img src="${file}"></p>`).join("")}</html>`;
await writeFile(path.join(runDir, "r01-live-report.html"), html, "utf8");
await writeFile(path.join(runDir, "r01-live-results.json"), JSON.stringify(evidence, null, 2), "utf8");
console.log(path.join(runDir, "r01-live-report.html"));
if (evidence.finalStatus !== "READY") process.exitCode = 1;
