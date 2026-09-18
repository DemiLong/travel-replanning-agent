import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { demo, createStarterSnapshot } = require("../work/eval-build/data/demo.js");
const origin =
  process.argv[2] || process.env.TEST_ORIGIN || "http://127.0.0.1:3000";
for (const path of [
  "/",
  "/trip",
  "/onboarding",
  "/rescue",
  "/demo",
  "/result",
  "/api/config",
]) {
  const r = await fetch(origin + path);
  assert.equal(r.status, 200, path);
  console.log("PASS GET", path);
}
// A stale Next.js process can serve HTML from one build while returning 500
// for a client chunk from another build. That leaves the React app on its
// loading screen, so verify every script referenced by the home document.
const homeHtml = await (await fetch(origin + "/")).text();
const scriptSources = [...homeHtml.matchAll(/<script[^>]+src="([^"]+)"/g)]
  .map((match) => match[1])
  .filter(Boolean);
assert(scriptSources.length > 0, "home page has no client scripts");
for (const source of scriptSources) {
  const asset = await fetch(new URL(source, origin));
  assert.equal(asset.status, 200, `client asset ${source}`);
}
console.log(`PASS ${scriptSources.length} home client assets`);
const evalsRoute = await fetch(origin + "/evals");
assert([200, 404].includes(evalsRoute.status));
console.log(
  `PASS /evals is ${evalsRoute.status === 404 ? "hidden in production" : "available in development"}`,
);
const legacyRoute = await fetch(origin + "/replan", { redirect: "manual" });
assert([307, 308].includes(legacyRoute.status));
assert.equal(legacyRoute.headers.get("location"), "/rescue");
console.log("PASS /replan redirects to /rescue");
const input = {
  snapshot: demo,
  mode: "demo",
  request: {
    reason: "tired",
    freeText: "It's 3 PM, I'm tired and it's raining.",
    currentState: demo.state,
    closedPlaceIds: [],
    variation: 0,
  },
};
async function post(path, body) {
  const r = await fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const semantic = await post("/api/parse", {
  snapshot: createStarterSnapshot(),
  rawText:
    "按摩，晚上预订了8点的游乐场，但是现在已经14点了，按摩需要1个小时，我还去吗？",
});
assert([200, 503].includes(semantic.status));
if (semantic.status === 200) {
  assert.equal(semantic.body.parser, "llm");
  assert.equal(semantic.body.context.currentTime, "14:00");
} else {
  assert(["MODEL_NOT_CONFIGURED", "MODEL_UPSTREAM_UNAVAILABLE"].includes(semantic.body.code));
}
console.log(
  `PASS semantic parser endpoint is ${semantic.status === 200 ? "live" : semantic.body.code === "MODEL_NOT_CONFIGURED" ? "explicitly unconfigured" : "unavailable without fallback"}`,
);
const response = await post("/api/replan", input);
assert.equal(response.status, 200);
assert(response.body.ok);
const plan = response.body.plan;
assert(
  plan.events.some(
    (e) =>
      e.id === "e-dinner" && e.startTime === "19:00" && e.endTime === "20:30",
  ),
);
console.log("PASS replan and locked dinner");
const acceptance = await post("/api/validate", { ...input, plan });
assert(acceptance.body.ok);
console.log("PASS acceptance revalidation");
const forged = structuredClone(plan);
forged.events.find((e) => e.locked).startTime = "19:30";
assert(!(await post("/api/validate", { ...input, plan: forged })).body.ok);
console.log("PASS tampered lock rejected");
const impossible = structuredClone(input);
impossible.request.currentState.remainingBudget = 100;
const fallback = await post("/api/replan", impossible);
assert(
  !fallback.body.ok &&
    fallback.body.plan === null &&
    fallback.body.attempts.length === 3,
);
console.log("PASS impossible budget safe fallback");
assert.equal((await post("/api/replan", {})).status, 400);
console.log("PASS missing context");
const localWithoutConfirmation = structuredClone(input);
localWithoutConfirmation.mode = "local";
assert.equal((await post("/api/replan", localWithoutConfirmation)).status, 400);
console.log("PASS local planning requires confirmed input");
const localWithoutItinerary = structuredClone(localWithoutConfirmation);
localWithoutItinerary.snapshot.mode = "user";
localWithoutItinerary.snapshot.itinerary = [];
localWithoutItinerary.snapshot.state.currentLocation = "Siam";
localWithoutItinerary.confirmation = {
  status: "confirmed",
  confirmedAt: new Date().toISOString(),
};
assert.equal((await post("/api/replan", localWithoutItinerary)).status, 400);
console.log("PASS local planning requires an itinerary");
const disguisedDemo=structuredClone(input);disguisedDemo.snapshot.mode="user";
assert.equal((await post("/api/replan",disguisedDemo)).status,400);
assert.equal((await post("/api/validate",{...disguisedDemo,plan})).status,400);
console.log("PASS real data cannot opt into Demo Planner or Demo validation");
console.log("HTTP smoke checks passed.");
