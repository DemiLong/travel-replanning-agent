import assert from "node:assert/strict";
import { demo, event } from "../data/demo";
import { buildContext } from "../agents/context-builder";
import { DemoPlanner } from "../agents/demo-planner";
import { replan } from "../agents/replanning-agent";
import { validatePlan } from "../validators";
import type { ProposedPlan, Violation } from "../types";
async function main() {
  const input = {
    snapshot: structuredClone(demo),
    mode: "demo" as const,
    request: {
      reason: "tired",
      freeText: "rain",
      currentState: demo.state,
      closedPlaceIds: [],
      variation: 0,
    },
  };
  const context = buildContext(input);
  const good = await new DemoPlanner().generate(context);
  assert.deepEqual(validatePlan(context, good), []);
  const tests: [string, Violation["code"], (p: ProposedPlan) => void][] = [
    [
      "deleted lock",
      "locked_event",
      (p) => {
        p.events = p.events.filter((e) => !e.locked);
      },
    ],
    [
      "retimed lock",
      "locked_event",
      (p) => {
        p.events.find((e) => e.locked)!.startTime = "19:05";
      },
    ],
    [
      "renamed lock",
      "locked_event",
      (p) => {
        p.events.find((e) => e.locked)!.name = "Different dinner";
      },
    ],
    [
      "overlap",
      "time_conflict",
      (p) => {
        p.events[0].endTime = "19:15";
      },
    ],
    [
      "first transfer",
      "travel_time",
      (p) => {
        p.events[0].startTime = "15:00";
      },
    ],
    [
      "between transfer",
      "travel_time",
      (p) => {
        p.events[1].startTime = p.events[0].endTime;
      },
    ],
    [
      "closed hour",
      "opening_hours",
      (p) => {
        p.events.unshift(
          event("national-museum", "late-museum", "16:00", "17:00"),
        );
      },
    ],
    [
      "over budget",
      "budget",
      (p) => {
        p.events.push(event("sea-life", "expensive", "21:00", "22:00"));
      },
    ],
    [
      "past",
      "past_event",
      (p) => {
        p.events[0].startTime = "14:59";
      },
    ],
    [
      "zero duration",
      "duration",
      (p) => {
        p.events[0].endTime = p.events[0].startTime;
      },
    ],
    [
      "negative duration",
      "duration",
      (p) => {
        p.events[0].endTime = "14:00";
      },
    ],
    [
      "forged price",
      "place_data",
      (p) => {
        p.events[0].estimatedCost += 1;
      },
    ],
    [
      "forged hours",
      "place_data",
      (p) => {
        p.events[0].closingTime = "23:58";
      },
    ],
    [
      "unknown venue",
      "place_data",
      (p) => {
        p.events[0].placeId = "imaginary";
      },
    ],
    [
      "duplicate id",
      "schema",
      (p) => {
        p.events.push(p.events[0]);
      },
    ],
    [
      "hidden original removal",
      "change_accounting",
      (p) => {
        p.movedEvents = [];
        p.removedEvents = [];
      },
    ],
    [
      "unapproved lock",
      "locked_event",
      (p) => {
        p.events[0].locked = true;
      },
    ],
    [
      "historical output",
      "past_event",
      (p) => {
        p.events.push(demo.itinerary[0]);
      },
    ],
  ];
  for (const [name, code, mutate] of tests) {
    const bad = structuredClone(good);
    mutate(bad);
    assert(
      validatePlan(context, bad).some((v) => v.code === code),
      name,
    );
    console.log(`PASS ${name}`);
  }
  assert(
    validatePlan(context, { summary: "malformed" }).some(
      (v) => v.code === "schema",
    ),
  );
  let calls = 0;
  const repaired = await replan(
    input,
    {
      name: "repair-fixture",
      async generate(_c, feedback) {
        calls++;
        if (calls === 1) return {};
        assert(feedback.some((v) => v.code === "schema"));
        return good;
      },
    },
    "demo",
  );
  assert(repaired.ok && calls === 2);
  calls = 0;
  const failed = await replan(
    input,
    {
      name: "always-invalid",
      async generate() {
        calls++;
        return {};
      },
    },
    "demo",
  );
  assert(!failed.ok && calls === 3 && failed.plan === null);
  calls = 0;
  const apiFailure = await replan(
    input,
    {
      name: "api-error",
      async generate() {
        calls++;
        throw new Error("API failure");
      },
    },
    "live",
  );
  assert(!apiFailure.ok && calls === 3);
  const closed = structuredClone(context);
  closed.disruption.closedPlaceIds = ["dinner"];
  assert(validatePlan(closed, good).some((v) => v.code === "opening_hours"));
  const boundary = structuredClone(context);
  boundary.state.remainingBudget = good.events.reduce(
    (s, e) => s + e.estimatedCost,
    0,
  );
  assert(!validatePlan(boundary, good).some((v) => v.code === "budget"));
  assert.throws(() => buildContext({}), /./);
  console.log(
    "PASS schema, bounded regeneration, failure fallback, closure, exact budget and missing context",
  );
  console.log("25 validator / agent-loop checks passed.");
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
