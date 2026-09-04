import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const kernelDir = join(__dirname, "..");

const envLocalPath = join(kernelDir, ".env.local");
const envPath = join(kernelDir, ".env");

if (existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath });
}
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const healthUrl = "http://127.0.0.1:4310/kernel/health";
const proofArgs = process.argv.slice(2);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(maxAttempts = 40, delayMs = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting; continue polling.
    }
    await sleep(delayMs);
  }

  throw new Error("Kernel health check timed out.");
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.on("exit", (code) => {
      resolve(code ?? 1);
    });

    child.on("error", () => {
      resolve(1);
    });
  });
}

async function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.killed) {
    return;
  }

  if (process.platform === "win32") {
    await runProcess("taskkill", ["/PID", String(serverProcess.pid), "/T", "/F"]);
    return;
  }

  serverProcess.kill("SIGTERM");
}

async function main() {
  const server = spawn(process.execPath, [join(kernelDir, "dist/server.js")], {
    cwd: kernelDir,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  let exitCode = 1;
  try {
    await waitForHealth();
    exitCode = await runProcess(
      process.execPath,
      [join(kernelDir, "scripts/run-isolation-proof.mjs"), ...proofArgs],
      {
        cwd: kernelDir,
        env: process.env,
      },
    );
  } finally {
    await stopServer(server);
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
