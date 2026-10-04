import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
const isolatedBuildDirectory = path.resolve(projectRoot, ".next-playwright");

if (!npmCli) {
  throw new Error("请通过 npm run test:e2e 启动隔离的浏览器回归。");
}

const environment = {
  ...process.env,
  COVEREDYOU_E2E_AUTH_ISOLATED: "1",
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
};

if (path.dirname(isolatedBuildDirectory) !== projectRoot || path.basename(isolatedBuildDirectory) !== ".next-playwright") {
  throw new Error("浏览器回归构建目录超出项目范围。");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`子进程被信号 ${signal} 中断。`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`子进程退出码为 ${code ?? "unknown"}。`));
        return;
      }
      resolve();
    });
  });
}

await rm(isolatedBuildDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
await run(process.execPath, [npmCli, "run", "build"]);
await run(process.execPath, [path.join(projectRoot, "scripts", "run-playwright.mjs"), ...process.argv.slice(2)]);
