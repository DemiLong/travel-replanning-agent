import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localBrowsers = path.join(projectRoot, ".playwright-browsers");

const environment = { ...process.env };
if (!environment.PLAYWRIGHT_BROWSERS_PATH && existsSync(localBrowsers)) {
  environment.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
}

const playwrightCli = path.join(
  projectRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);

const child = spawn(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: environment,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Playwright 被信号 ${signal} 中断。`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
