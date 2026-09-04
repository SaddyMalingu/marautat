import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, "..", ".env.local");
const fallbackEnvPath = join(__dirname, "..", ".env");

if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}
if (existsSync(fallbackEnvPath)) {
  dotenv.config({ path: fallbackEnvPath });
}

const baseUrl = process.env.KERNEL_BASE_URL || "http://127.0.0.1:4310";
const supabaseUrl = process.env.SUPABASE_URL || process.env.SB_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const readArg = (name) => {
  const prefix = `--${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
};
const hasFlag = (name) => args.includes(`--${name}`);

const tenantAIdOverride = readArg("tenantAId") || process.env.PROBE_TENANT_A_ID;
const tenantBIdOverride = readArg("tenantBId") || process.env.PROBE_TENANT_B_ID;
const userAIdOverride = readArg("userAId") || process.env.PROBE_USER_A_ID;
const userBIdOverride = readArg("userBId") || process.env.PROBE_USER_B_ID;
const outputPath = readArg("output") || process.env.PROOF_OUTPUT_FILE;
const latestOutputPath = readArg("latestOutput") || process.env.PROOF_LATEST_OUTPUT_FILE;
const strictIds = hasFlag("strict-ids") || process.env.PROOF_STRICT_IDS === "true";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing Supabase credentials. Set SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY or SB_URL/SB_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const sb = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

if (strictIds) {
  if (!tenantAIdOverride || !tenantBIdOverride || !userAIdOverride || !userBIdOverride) {
    console.error(
      "Strict ID mode requires tenantAId, tenantBId, userAId, and userBId via args or PROBE_* env vars.",
    );
    process.exit(1);
  }
}

let tenantA;
let tenantB;

if (tenantAIdOverride && tenantBIdOverride) {
  const { data: explicitTenants, error: explicitTenantsError } = await sb
    .from("bot_tenants")
    .select("id, client_name")
    .in("id", [tenantAIdOverride, tenantBIdOverride]);

  if (explicitTenantsError) {
    console.error(`Failed to load explicit tenants: ${explicitTenantsError.message}`);
    process.exit(1);
  }

  const tenantMap = new Map((explicitTenants || []).map((row) => [String(row.id), row]));
  tenantA = tenantMap.get(String(tenantAIdOverride)) || { id: tenantAIdOverride, client_name: null };
  tenantB = tenantMap.get(String(tenantBIdOverride)) || { id: tenantBIdOverride, client_name: null };
} else {
  const { data: tenants, error: tenantsError } = await sb
    .from("bot_tenants")
    .select("id, client_name, status")
    .limit(10);

  if (tenantsError) {
    console.error(`Failed to load tenants: ${tenantsError.message}`);
    process.exit(1);
  }

  const usableTenants = (tenants || []).filter((row) => row?.id).slice(0, 2);
  if (usableTenants.length < 2) {
    console.error("Need at least 2 tenants in bot_tenants to run cross-tenant probe.");
    process.exit(1);
  }

  [tenantA, tenantB] = usableTenants;
}

let userAId = userAIdOverride;
let userBId = userBIdOverride;

if (!userAId || !userBId) {
  const { data: creditsA } = await sb
    .from("user_credits")
    .select("user_id")
    .limit(1)
    .maybeSingle();

  const { data: creditsB } = await sb
    .from("user_credits")
    .select("user_id")
    .neq("user_id", creditsA?.user_id || "")
    .limit(1)
    .maybeSingle();

  userAId = userAId || creditsA?.user_id;
  userBId = userBId || creditsB?.user_id;
}

const params = new URLSearchParams({
  mode: "probe",
  tenantAId: String(tenantA.id),
  tenantBId: String(tenantB.id),
});

if (userAId && userBId) {
  params.set("userAId", String(userAId));
  params.set("userBId", String(userBId));
}

const url = `${baseUrl}/kernel/api/isolation-check?${params.toString()}`;
const response = await fetch(url);
const payload = await response.json();

const result = {
  ok: payload.ok,
  mode: payload.mode,
  strictIds,
  timestamp: new Date().toISOString(),
  tenants: {
    tenantA: { id: tenantA.id, name: tenantA.client_name || null },
    tenantB: { id: tenantB.id, name: tenantB.client_name || null },
  },
  probe: payload.probe,
};

console.log(
  JSON.stringify(result, null, 2),
);

const writeArtifact = async (targetPath) => {
  const outDir = dirname(targetPath);
  await mkdir(outDir, { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
};

if (outputPath) {
  await writeArtifact(outputPath);
}

if (latestOutputPath) {
  await writeArtifact(latestOutputPath);
}

if (!response.ok || payload.ok === false) {
  process.exit(2);
}
