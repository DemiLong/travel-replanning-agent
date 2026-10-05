import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import * as tripService from "../services/trip-service";
import * as types from "../types";
import { ActivityFactSchema } from "../types/activity";
import { AgentResultSchema } from "../types/agent";
import { RealSessionSchema } from "../types/session";
import { SnapshotSchema } from "../types/travel";
import { ParsedUserInputSchema } from "../types/workflow";

// Existing callers and the split modules must see the same schema instances.
assert.equal(types.ActivityFactSchema, ActivityFactSchema);
assert.equal(types.AgentResultSchema, AgentResultSchema);
assert.equal(types.RealSessionSchema, RealSessionSchema);
assert.equal(types.SnapshotSchema, SnapshotSchema);
assert.equal(types.ParsedUserInputSchema, ParsedUserInputSchema);
assert.equal(types.RealSessionSchema.shape.schemaVersion.value, 5);
assert.equal(tripService.realSessionKey, "travel-session-real-v5");

assert.equal("accepted" in types.PendingPlanSchema.shape, false);
assert.equal("stage" in types.PendingInputSchema.shape, false);
assert.equal(
  types.ProtectionPolicySchema.shape.source.safeParse("legacy").success,
  false,
);
for (const name of [
  "resultKey",
  "activeTripMode",
  "localTrip",
  "loadTrip",
  "migrateV2SessionValue",
  "migrateV3SessionValue",
]) {
  assert.equal(name in tripService, false, `removed facade export: ${name}`);
}

if (false) {
  // @ts-expect-error accepted is no longer part of the pending plan contract
  void types.PendingPlanSchema.parse({}).accepted;
  // @ts-expect-error a pending input no longer has a stage discriminator
  void types.PendingInputSchema.parse({}).stage;
  // @ts-expect-error migration-only policies cannot be created at runtime
  const source: types.ProtectionPolicy["source"] = "legacy";
  void source;
}

const retiredSymbols = [
  "existingPlans",
  "activityMentions",
  "unscheduledOriginals",
  "originalActivityIds",
  "existingItinerary",
  "lockedEvents",
  "remainingEvents",
  "legacyActivitiesFromFacts",
  "parsedToEvent",
  "mergePlans",
  "legacyProtectionPolicy",
  "effectiveProtectionPolicy",
  "migrateV2SessionValue",
  "migrateV3SessionValue",
  "resultKey",
  "activeTripMode",
  "localTrip",
  "loadTrip",
  "TripMode",
];
const retiredPattern = new RegExp(`\\b(?:${retiredSymbols.join("|")})\\b`);

function checkSources(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      checkSources(file);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      assert.equal(
        retiredPattern.test(readFileSync(file, "utf8")),
        false,
        file,
      );
    }
  }
}

for (const directory of [
  "types",
  "services",
  "agents",
  "validators",
  "components",
  "app",
  "data",
]) {
  checkSources(path.join(process.cwd(), directory));
}

console.log("Cleanup contract and retired-field checks passed.");
