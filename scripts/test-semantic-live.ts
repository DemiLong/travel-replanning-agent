import assert from "node:assert/strict";
import { createStarterSnapshot } from "../data/session-defaults";
import { OpenAISemanticParser } from "../services/semantic-parser";
import { regressionText } from "../evals/world-tests";

const text =
  "15:00 按摩，晚上预订了8点的游乐场，但是现在已经14点了，按摩需要1个小时，我还去吗？";
const result = await new OpenAISemanticParser().parse(
  createStarterSnapshot(),
  text,
);
const activities = [...result.existingPlans, ...result.activityMentions];

assert.equal(result.parser, "llm");
assert.equal(result.context.currentTime, "14:00");
assert.equal(result.context.weather, undefined);
assert.equal(result.context.energyLevel, undefined);
assert(activities.some((item) => item.name.includes("按摩")));
assert(
  result.activityMentions.some(
    (item) => item.name.includes("游乐场") && item.locked === "yes",
  ) ||
    result.existingPlans.some(
      (item) => item.name.includes("游乐场") && item.locked,
    ),
);
assert(activities.every((item) => item.name.length < 40));
console.log("PASS live semantic parser kept time, duration and booking separate");
const regression = await new OpenAISemanticParser().parse(createStarterSnapshot(), regressionText);
const facts = [...regression.existingPlans, ...regression.activityMentions];
assert(facts.length >= 3);
assert.equal(regression.context.currentTime, "11:46");
assert(facts.some(x => x.name.includes("故宫") && x.startTime === "10:00"));
assert(facts.some(x => x.startTime === "15:00"));
assert(facts.some(x => x.startTime === "17:00" && (x.locked === true || x.locked === "yes")));
assert(regression.disruptions.some(x => x.kind === "late"));
assert.equal(regression.context.weather, undefined);
assert.equal(regression.context.energyLevel, undefined);
console.log("PASS live DeepSeek complex regression", JSON.stringify({model:regression.parserModel, facts: facts.map(x=>({name:x.name,time:x.startTime})), currentTime:regression.context.currentTime, questions:regression.parseWarnings}));
