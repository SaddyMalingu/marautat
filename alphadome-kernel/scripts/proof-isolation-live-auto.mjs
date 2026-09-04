import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

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

const supabaseUrl = process.env.SUPABASE_URL || process.env.SB_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing Supabase credentials. Set SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY or SB_URL/SB_SERVICE_ROLE_KEY.");
  process.exit(1);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const sb = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: tenants, error: tenantsError } = await sb
    .from("bot_tenants")
    .select("id")
    .not("id", "is", null)
    .limit(10);

  if (tenantsError) {
    console.error(`Failed to load tenants: ${tenantsError.message}`);
    process.exit(1);
  }

  const tenantIds = [...new Set((tenants || []).map((row) => row.id).filter(Boolean))].slice(0, 2);
  if (tenantIds.length < 2) {
    console.error("Need at least 2 tenant IDs in bot_tenants for strict auto proof.");
    process.exit(1);
  }

  let userIds = [];
  const { data: credits, error: creditsError } = await sb
    .from("user_credits")
    .select("user_id")
    .not("user_id", "is", null)
    .limit(50);

  if (!creditsError) {
    userIds = [...new Set((credits || []).map((row) => row.user_id).filter(Boolean))].slice(0, 2);
  }

  if (userIds.length < 2) {
    const envUserA = process.env.PROBE_USER_A_ID;
    const envUserB = process.env.PROBE_USER_B_ID;
    if (envUserA && envUserB) {
      userIds = [envUserA, envUserB];
    }
  }

  if (userIds.length < 2) {
    // Fallback IDs keep strict mode deterministic even if credits table is absent.
    userIds = [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    ];
  }

  const args = [
    join(kernelDir, "scripts/proof-isolation-live.mjs"),
    "--strict-ids",
    `--output=${join(kernelDir, "..", "docs", "forge", "proof-artifacts", `isolation-proof-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)}`,
    `--latestOutput=${join(kernelDir, "..", "docs", "forge", "proof-artifacts", "latest-isolation-proof.json")}`,
    `--tenantAId=${tenantIds[0]}`,
    `--tenantBId=${tenantIds[1]}`,
    `--userAId=${userIds[0]}`,
    `--userBId=${userIds[1]}`,
  ];

  const exitCode = await runProcess(process.execPath, args, {
    cwd: kernelDir,
    env: process.env,
  });

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
