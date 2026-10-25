import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { planDetailsFixture } from "./plan-details-fixture";
import { snapshotActivityFacts } from "../services/activity-facts";
import type { ItineraryEvent } from "../types";

const key = "travel-session-real-v5";
const screenshotDir = "qa/activity-integrity/runs/plan-changes-2026-10-25";

async function seed(page: Page, session = planDetailsFixture()) {
  await page.addInitScript(({ key, session }) => {
    (globalThis as typeof globalThis & { __COVEREDYOU_DISABLE_AUTH_FOR_TESTS__?: boolean }).__COVEREDYOU_DISABLE_AUTH_FOR_TESTS__ = true;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(session));
  }, { key, session });
  await page.goto("/result");
  await expect(page.getByRole("heading", { name: "今天建议这样调整", exact: true })).toBeVisible();
}

test("真实变化、未知时长、备选切换及采纳后的标签保持一致", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await expect(page.locator(".plan-screen .plan-event-ribbon")).toHaveCount(0);
  await expect(page.locator(".plan-summary-overview p")).toContainText("优先保住固定演出");
  const overview = page.locator(".plan-overview-content");
  await expect(overview).toHaveAttribute("aria-hidden", "true");
  expect(await overview.evaluate(element => element.getBoundingClientRect().height)).toBe(0);
  await page.getByRole("button", { name: "展开说明", exact: true }).click();
  await expect(page.getByRole("button", { name: "收起说明", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => overview.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(5);
  await page.getByRole("button", { name: "收起说明", exact: true }).click();
  await expect.poll(() => overview.evaluate(element => element.getBoundingClientRect().height)).toBe(0);
  await page.getByRole("button", { name: "查看具体改动" }).click();
  const meal = page.locator('[data-activity-id="meal"]');
  await expect(meal).toContainText("时间调整");
  await expect(meal).toContainText("停留建议");
  await expect(meal).toContainText("推荐打车");
  await expect(meal).toContainText("建议 45 分钟");
  await expect(meal).toContainText("17:00");
  await expect(meal).toContainText("17:20–18:05");
  await expect(page.locator('[data-activity-id="theatre"]')).toContainText("19:30–21:00 固定时间保留");
  await expect(page.locator('[data-activity-id="shopping"]')).toContainText("建议取消");
  await expect(page.getByText("保留／调整", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("region", { name: "整体取舍" })).toHaveCount(0);
  await page.getByRole("button", { name: "知道了", exact: true }).click();
  await page.getByRole("button", { name: "查看备选方案", exact: true }).click();
  await expect(page.locator(".plan-summary-overview p")).toContainText("公共交通减少打车支出");
  await page.getByRole("button", { name: "查看具体改动" }).click();
  await expect(meal).toContainText("17:40–18:25");
  await expect(meal).toContainText("推荐公共交通");
  await page.reload();
  await page.getByRole("button", { name: "查看具体改动" }).click();
  await expect(meal).toContainText("17:40–18:25");
  await page.getByRole("button", { name: "知道了", exact: true }).click();
  await page.route("**/api/validate", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, violations: [] }) }));
  await page.getByRole("button", { name: "接受方案", exact: true }).click();
  await expect(page).toHaveURL(/\/trip$/);
  await expect(page.locator(".plan-event-ribbon").first()).toHaveText("时间调整");
  await expect(page.locator(".plan-event-card").first()).toContainText("公共交通");
});

test("说明矛盾时保留可行方案，隐藏疑似冲突文字", async ({ page }) => {
  const session = planDetailsFixture();
  const plan = session.pendingPlan!.result.plan!;
  plan.explanation = "上海大剧院固定演出改为虹桥天地逛街。";
  plan.events[0].reason = "缩短虹桥天地（购物中心南区）餐饮区用餐的停留时间。";
  await seed(page, session);
  await expect(page.getByRole("button", { name: "接受方案", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "查看具体改动" }).click();
  await expect(page.locator(".plan-summary-overview")).toHaveCount(0);
  await expect(page.getByText(plan.events[0].reason, { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-activity-id="meal"]')).toContainText("建议 45 分钟");
  await expect(page.locator(".change-text-note")).toBeVisible();
});

test("末站结束未定：不显示结束或停留建议，采纳刷新后仍保持未知", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = planDetailsFixture();
  const pending = session.pendingPlan!;
  const last: ItineraryEvent = { ...pending.base.itinerary[0], id: "bund", placeId: "bund-poi", name: "外滩散步", location: "外滩",
    startTime: "21:40", endTime: "21:40", durationSource: "unknown", travelMode: "WALKING", travelTimeFromPrevious: 40,
    reason: "演出结束后去外滩散步，离开时间自行决定，营业和入场情况仍需确认。" };
  session.snapshot.itinerary.push(last);
  pending.base.itinerary.push(last);
  pending.request.activityFacts = snapshotActivityFacts(pending.base);
  pending.result.context.activityFacts = pending.request.activityFacts;
  pending.result.context.remainingActivityFacts = pending.request.activityFacts;
  pending.result.context.disruption = pending.request;
  pending.result.plan!.events.push(last);
  for (const candidate of pending.result.candidatePlans ?? []) candidate.plan!.events.push(last);
  await seed(page, session);
  const finalTime = page.locator(".plan-event").last().locator(".plan-event-time");
  await expect(finalTime).toHaveText("21:40");
  await expect(page.locator(".plan-event-time").nth(1)).toContainText("21:00");
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: `${screenshotDir}/result-open-end-390.png`, fullPage: true });
  await page.getByRole("button", { name: "查看具体改动" }).click();
  const card = page.locator('[data-activity-id="bund"]');
  await page.locator(".change-unchanged summary").click();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await expect(card).not.toContainText("停留建议");
  await expect(card).not.toContainText("60 分钟");
  await expect(card.locator("dt").filter({ hasText: "停留" })).toHaveCount(0);
  await page.getByRole("dialog").screenshot({ path: `${screenshotDir}/details-open-end-390.png` });
  await page.getByRole("button", { name: "知道了", exact: true }).click();
  await page.route("**/api/validate", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, violations: [] }) }));
  await page.getByRole("button", { name: "接受方案", exact: true }).click();
  await expect(page).toHaveURL(/\/trip$/);
  await page.reload();
  await expect(page.locator(".plan-event").last().locator(".plan-event-time b")).toHaveText("21:40");
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
  expect(saved.snapshot.itinerary.at(-1)).toMatchObject({ startTime: "21:40", endTime: "21:40", durationSource: "unknown" });
});

test("全部未变时展示保留结果，普通安排可展开", async ({ page }) => {
  const session = planDetailsFixture();
  const pending = session.pendingPlan!;
  pending.request.activityFacts = pending.request.activityFacts.filter(fact => fact.id !== "meal");
  pending.result.context.remainingActivityFacts = pending.request.activityFacts;
  pending.result.context.activityFacts = pending.request.activityFacts;
  pending.result.plan = { summary: "保留原安排", explanation: "保留已确认的演出与逛街安排。", events: pending.base.itinerary.filter(event => event.id !== "meal"), removedEvents: [], movedEvents: [] };
  await seed(page, session);
  await page.getByRole("button", { name: "查看具体改动" }).click();
  await expect(page.locator(".change-empty")).toContainText("已知时间与地点未变");
  await expect(page.getByRole("region", { name: "保住的重要安排" })).toBeVisible();
  await expect(page.locator('[data-activity-id="shopping"]')).not.toBeVisible();
  await page.locator(".change-unchanged summary").click();
  await expect(page.locator('[data-activity-id="shopping"]')).toBeVisible();
});

for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`排版验收 ${viewport.width}px：长地名、多标签与抽屉滚动`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await seed(page);
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: `${screenshotDir}/result-${viewport.width}.png` });
    const expand = page.getByRole("button", { name: "展开说明", exact: true });
    if (await expand.count()) {
      await expand.click();
      await expect.poll(() => page.locator(".plan-overview-content").evaluate(element => Math.abs(element.clientHeight - element.scrollHeight))).toBeLessThan(2);
      await page.screenshot({ path: `${screenshotDir}/result-${viewport.width}-expanded.png` });
    }
    await page.getByRole("button", { name: "查看具体改动" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "具体改动与建议", exact: true })).toBeVisible();
    await expect.poll(() => dialog.evaluate(element => Math.abs(element.getBoundingClientRect().bottom - innerHeight))).toBeLessThan(2);
    const layout = await dialog.evaluate(element => {
      const scroll = element.querySelector(".drawer-scroll")!;
      return { width: element.getBoundingClientRect().width, scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth,
        overflow: [...element.querySelectorAll(".change-tags,.change-card-detail,.change-facts")].some(node => node.scrollWidth > node.clientWidth + 1) };
    });
    expect(layout.width).toBeLessThanOrEqual(viewport.width);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.overflow).toBe(false);
    await page.screenshot({ path: `${screenshotDir}/details-${viewport.width}.png` });
    await dialog.screenshot({ path: `${screenshotDir}/details-${viewport.width}-panel.png` });
    await page.locator('[data-activity-id="shopping"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-activity-id="shopping"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "知道了", exact: true })).toBeInViewport();
    await page.screenshot({ path: `${screenshotDir}/details-${viewport.width}-scrolled.png` });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });
}
