import assert from "node:assert/strict";
import { AssistRequestSchema, runAgentAssist } from "../agents/agent-orchestrator";
import { createStarterSnapshot } from "../data/session-defaults";
import {
  MAP_REQUEST_TIMEOUT_MS,
  MAX_RAW_INPUT_LENGTH,
  RAW_INPUT_TOO_LONG_MESSAGE,
  REQUEST_DEADLINE_MS,
  WORLD_CONFIRMATION_TTL_MS,
  ConfirmedDraftSchema,
  ItineraryDraftSchema,
  ParsedUserInputSchema,
  PendingInputSchema,
  RealSessionSchema,
  ReplanningRequestSchema,
  SnapshotSchema,
  isRawInputWithinLimit,
  isWorldConfirmationExpired,
  rawInputRemaining,
} from "../types";

async function main() {
  assert.equal(MAX_RAW_INPUT_LENGTH, 4_000);
  assert.equal(WORLD_CONFIRMATION_TTL_MS, 5 * 60 * 1_000);
  assert.equal(REQUEST_DEADLINE_MS, 30_000);
  assert.equal(MAP_REQUEST_TIMEOUT_MS, 8_000);
  assert.equal(RAW_INPUT_TOO_LONG_MESSAGE, "输入最多 4000 个字，请删减后再提交。");

  const atLimit = "行".repeat(MAX_RAW_INPUT_LENGTH);
  const overLimit = `${atLimit}程`;
  assert.equal(isRawInputWithinLimit(atLimit), true);
  assert.equal(isRawInputWithinLimit(overLimit), false);
  assert.equal(rawInputRemaining("行程"), MAX_RAW_INPUT_LENGTH - 2);
  assert.equal(rawInputRemaining(overLimit), 0);

  const rawTextSchemas = [
    ParsedUserInputSchema.shape.rawText,
    ConfirmedDraftSchema.shape.rawText,
    PendingInputSchema.shape.questionRawText,
    ItineraryDraftSchema.shape.rawInput,
    RealSessionSchema.shape.rawInput,
    ReplanningRequestSchema.shape.freeText,
  ];
  for (const schema of rawTextSchemas) {
    assert.equal(schema.safeParse(atLimit).success, true);
    const rejected = schema.safeParse(overLimit);
    assert.equal(rejected.success, false);
    if (!rejected.success) assert.equal(rejected.error.issues[0]?.message, RAW_INPUT_TOO_LONG_MESSAGE);
  }

  const snapshot = createStarterSnapshot();
  assert.equal(AssistRequestSchema.safeParse({ snapshot, rawText: atLimit }).success, true);
  const assistRejected = AssistRequestSchema.safeParse({ snapshot, rawText: overLimit });
  assert.equal(assistRejected.success, false);
  if (!assistRejected.success) assert.equal(assistRejected.error.issues[0]?.message, RAW_INPUT_TOO_LONG_MESSAGE);

  const longRawText = "下雨了，请调整下午行程。".padEnd(3_000, "行");
  const base = createStarterSnapshot();
  const planningSnapshot = SnapshotSchema.parse({
    ...base,
    trip: { ...base.trip, destination: "上海" },
    state: { ...base.state, currentLocation: "人民广场" },
    stateSources: { ...base.stateSources, currentLocation: "user", disruption: "user" },
    itinerary: [{
      id: "museum",
      placeId: "museum-poi",
      name: "城市博物馆",
      category: "user activity",
      startTime: "10:00",
      endTime: "11:00",
      durationSource: "user",
      location: "城市博物馆",
      status: "planned",
      locked: false,
      indoorOutdoor: "mixed",
      openingTime: null,
      closingTime: null,
      travelTimeFromPrevious: null,
      reason: "用户原有安排。",
      constraint: "无",
    }],
  });
  let groundingReached = false;
  const result = await runAgentAssist(
    { snapshot: planningSnapshot, rawText: longRawText },
    undefined,
    {
      parse: async () => ParsedUserInputSchema.parse({
        rawText: longRawText,
        intent: "rescue",
        activityFacts: [],
        disruptions: [{ kind: "weather", label: "下雨", source: "user" }],
        constraints: [],
        context: planningSnapshot.state,
        contextSources: planningSnapshot.stateSources,
        missingFacts: [],
        status: "confirmed",
        parser: "manual",
      }),
      ground: async () => {
        groundingReached = true;
        throw new Error("grounding probe");
      },
    },
  );
  assert.equal(groundingReached, true, `3000-character input must pass request construction and reach grounding: ${JSON.stringify(result)}`);
  assert.equal(result.status, "SYSTEM_ERROR");

  const now = Date.parse("2026-10-03T10:00:00.000Z");
  assert.equal(isWorldConfirmationExpired("2026-10-03T09:55:00.000Z", now), false);
  assert.equal(isWorldConfirmationExpired("2026-10-03T09:54:59.999Z", now), true);
  assert.equal(isWorldConfirmationExpired("not-a-date", now), true);
  assert.equal(isWorldConfirmationExpired("2026-10-03T10:01:00.000Z", now), false);

  console.log("Protocol contract tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
