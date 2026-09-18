import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStarterSnapshot } = require(
  "../work/eval-build/data/session-defaults.js",
);
const { createDeterministicTestSnapshot } = require(
  "../work/eval-build/evals/test-helpers.js",
);
const origin =
  process.argv[2] || process.env.TEST_ORIGIN || "http://127.0.0.1:3000";

for (const path of [
  "/",
  "/trip",
  "/onboarding",
  "/rescue",
  "/result",
  "/api/config",
]) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200, path);
  console.log("PASS GET", path);
}

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

async function post(path, body) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const semantic = await post("/api/parse", {
  snapshot: createStarterSnapshot(),
  rawText:
    "有个地方关门了，但是现在已经14点了，我还需要调整今天的安排吗？",
});
assert([200, 503].includes(semantic.status));
if (semantic.status === 200) assert.equal(semantic.body.parser, "llm");
else
  assert(
    ["MODEL_NOT_CONFIGURED", "MODEL_UPSTREAM_UNAVAILABLE"].includes(
      semantic.body.code,
    ),
  );
console.log("PASS semantic parser endpoint");

assert.equal((await post("/api/replan", {})).status, 400);
console.log("PASS missing replan context");

const localWithoutConfirmation = {
  snapshot: createDeterministicTestSnapshot(),
  mode: "local",
  request: {
    reason: "tired",
    freeText: "我有点累",
    currentState: createDeterministicTestSnapshot().state,
    closedPlaceIds: [],
    variation: 0,
  },
};
assert.equal(
  (await post("/api/replan", localWithoutConfirmation)).status,
  400,
);
console.log("PASS local planning requires confirmed input");

const localWithoutItinerary = {
  ...localWithoutConfirmation,
  snapshot: createStarterSnapshot(),
  confirmation: {
    status: "confirmed",
    confirmedAt: new Date().toISOString(),
  },
};
localWithoutItinerary.snapshot.state.currentLocation = "测试区域";
localWithoutItinerary.request.currentState = localWithoutItinerary.snapshot.state;
assert.equal(
  (await post("/api/replan", localWithoutItinerary)).status,
  400,
);
console.log("PASS local planning requires an itinerary");
console.log("HTTP smoke checks passed.");
