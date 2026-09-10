import { writeFileSync, mkdirSync } from "node:fs";
import { runEvals } from "./harness";
import { DemoPlanner } from "../agents/demo-planner";
import { OpenAIPlanner } from "../services/openai";
async function main() {
  const live = process.argv.includes("--live");
  const models = live
    ? (process.env.EVAL_MODELS || process.env.OPENAI_MODEL || "")
        .split(",")
        .filter(Boolean)
    : ["demo"];
  if (!models.length)
    throw new Error(
      "Set OPENAI_MODEL or EVAL_MODELS before running live evals.",
    );
  mkdirSync("outputs", { recursive: true });
  mkdirSync("data", { recursive: true });
  for (const model of models) {
    const report = await runEvals(
      live ? new OpenAIPlanner(model) : new DemoPlanner(),
      live ? "live" : "demo",
    );
    const suffix = model.replace(/[^a-zA-Z0-9_-]/g, "-");
    writeFileSync(
      `outputs/eval-${suffix}.json`,
      JSON.stringify(report, null, 2),
    );
    if (!live)
      writeFileSync("data/eval-report.json", JSON.stringify(report, null, 2));
    console.log(
      `\n${report.mode.toUpperCase()} / ${report.model} / ${report.total} synthetic cases`,
    );
    console.table(
      report.results.map((r) => ({
        id: r.id,
        scenario: r.name,
        result: r.pass ? "PASS" : "FAIL",
        validPlan: r.validPlan,
        attempts: r.attempts.length,
        violations: [...new Set(r.violations.map((v) => v.code))].join(","),
      })),
    );
    console.log(
      JSON.stringify(
        {
          hardConstraintPassRate: report.hardConstraintPassRate,
          feasibleCasePassRate: report.feasibleCasePassRate,
          scenarioPassRate: report.scenarioPassRate,
          averageRegenerationCount: report.averageRegenerationCount,
          violationRates: report.violationRates,
        },
        null,
        2,
      ),
    );
    if (!live && report.scenarioPassRate < 1) process.exitCode = 1;
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
