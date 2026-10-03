import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { createStarterSnapshot } = require(
  "../work/eval-build/data/session-defaults.js",
);
const origin =
  process.argv[2] || process.env.TEST_ORIGIN || "http://127.0.0.1:3000";

let authToken = null;
if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  const authClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
  const { data, error } = await authClient.auth.signInAnonymously();
  assert.ifError(error);
  authToken = data.session?.access_token ?? null;
  assert(authToken, "Supabase anonymous sign-in returned no access token");
}

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
assert.equal(legacyRoute.status, 404);
console.log("PASS /replan is removed");

async function post(path, body) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let decoded = null;
  try { decoded = text ? JSON.parse(text) : null; } catch { /* Removed routes may return the framework's HTML 404 page. */ }
  return { status: response.status, body: decoded, traceId: response.headers.get("x-trace-id") };
}

const semantic = await post("/api/parse", {
  snapshot: createStarterSnapshot(),
  rawText:
    "有个地方关门了，但是现在已经14点了，我还需要调整今天的安排吗？",
});
const authBoundaryCodes = new Set([
  "AUTH_NOT_CONFIGURED",
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "AUTH_TIMEOUT",
  "AUTH_PROVIDER_ERROR",
  "RATE_LIMITED",
  "RATE_LIMITER_TIMEOUT",
  "RATE_LIMITER_ERROR",
]);
const stoppedAtAuthBoundary = authBoundaryCodes.has(semantic.body?.failure?.code);
if (stoppedAtAuthBoundary) {
  assert([401, 429, 503, 504].includes(semantic.status));
  console.log("PASS protected endpoint fails closed", semantic.body.failure.code);
} else if (semantic.status === 200) assert.equal(semantic.body.parser, "llm");
else {
  assert([502, 503, 504].includes(semantic.status));
  assert(
    ["MODEL_NOT_CONFIGURED", "MODEL_NETWORK_ERROR", "MODEL_TIMEOUT", "MODEL_INVALID_OUTPUT"].includes(
      semantic.body.failure?.code,
    ),
  );
}
if (semantic.status !== 200) assert.equal(semantic.traceId, semantic.body.failure?.traceId);
console.log("PASS semantic parser endpoint");

for (const removedPath of ["/api/replan", "/api/world/context", "/api/world/places"]) {
  assert.equal((await post(removedPath, {})).status, 404);
  console.log("PASS removed legacy endpoint", removedPath);
}
const invalidAssist = await post("/api/assist", {});
if (stoppedAtAuthBoundary) {
  assert(authBoundaryCodes.has(invalidAssist.body?.failure?.code));
} else {
  assert.equal(invalidAssist.status, 400);
  assert.equal(invalidAssist.body?.status, "INVALID_REQUEST");
  assert.equal(invalidAssist.body?.failure?.code, "INVALID_REQUEST");
}
assert.equal(invalidAssist.traceId, invalidAssist.body?.failure?.traceId);
console.log(`PASS assist ${stoppedAtAuthBoundary ? "enforces authentication" : "rejects an invalid request"}`);
const invalidValidate = await post("/api/validate", {});
if (stoppedAtAuthBoundary) {
  assert(authBoundaryCodes.has(invalidValidate.body?.failure?.code));
} else {
  assert.equal(invalidValidate.status, 400);
  assert.equal(invalidValidate.body?.status, "INVALID_REQUEST");
  assert.equal(invalidValidate.body?.failure?.code, "INVALID_REQUEST");
}
assert.equal(invalidValidate.traceId, invalidValidate.body?.failure?.traceId);
console.log(`PASS validate ${stoppedAtAuthBoundary ? "enforces authentication" : "rejects an invalid request"}`);
console.log("HTTP smoke checks passed.");
