import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { demo } = require("../work/eval-build/data/demo.js");
const origin =
  process.argv[2] || process.env.TEST_ORIGIN || "http://127.0.0.1:3000";
for (const path of [
  "/",
  "/trip",
  "/onboarding",
  "/replan",
  "/result",
  "/evals",
  "/api/config",
]) {
  const r = await fetch(origin + path);
  assert.equal(r.status, 200, path);
  console.log("PASS GET", path);
}
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
console.log("HTTP smoke checks passed.");
