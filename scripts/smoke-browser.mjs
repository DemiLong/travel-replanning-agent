import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdirSync,writeFileSync} from "node:fs";
const require=createRequire(import.meta.url);
// Optional external test dependency; not part of the application runtime.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||"playwright");
const browser=await chromium.launch({channel:"msedge",headless:true});
try{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(process.argv[2]||"http://127.0.0.1:3000/");
  const raw="我原本 10:00 去美术馆，现在航班晚点了 2 小时，刚到虹桥。下午 6 点的预约晚餐必须保留。";
  const text=page.locator("textarea").first();await text.fill(raw);
  const responsePromise=page.waitForResponse(r=>r.url().endsWith("/api/assist")&&r.request().method()==="POST",{timeout:180000});
  await page.getByRole("button",{name:/^(帮我重新安排今天|继续完成上次操作)$/}).click();
  const response=await responsePromise;assert(response.ok());
  const body=await response.json();assert.equal(body.status,"needs_input");assert.equal(body.missingFacts.length,1);assert(/晚餐/.test(body.missingFacts[0].reason));
  const follow=page.locator("#assist-follow-up");await follow.waitFor();
  assert.equal(await text.inputValue(),raw);assert.equal(new URL(page.url()).pathname,"/");
  assert.equal(await page.getByRole("combobox").count(),0);
  await follow.fill("晚餐在上海和平饭店龙凤厅，美术馆是上海美术馆（中华艺术宫）。现在是12:00。");
  // Inspect the actual follow-up request without spending another planning call.
  let submitted;
  await page.route("**/api/assist",async route=>{submitted=route.request().postDataJSON();await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});});
  const followResponse=page.waitForResponse(r=>r.url().endsWith("/api/assist"),{timeout:15000});
  await follow.press("Enter");
  await followResponse;
  assert(submitted.rawText.includes(raw));assert(submitted.rawText.includes("上海和平饭店龙凤厅"));
  assert.deepEqual(errors,[]);
  mkdirSync("work",{recursive:true});await page.screenshot({path:"work/assist-mobile-smoke.png",fullPage:true});
  writeFileSync("work/browser-smoke-report.json",JSON.stringify({testedAt:new Date().toISOString(),viewport:"390x844",initialQuestion:"actual DeepSeek + Amap HTTP",followUp:"intercepted response; request preservation verified",pageErrors:errors},null,2));
  console.log("PASS mobile browser: hydration, actual single dinner question, no city/mode form, keyboard follow-up preserves input");
}finally{await browser.close();}
