#!/usr/bin/env node
/*
  Admin suite smoke test for post-deploy verification.

  Usage:
    node scripts/admin_suite_smoke.cjs --base https://alphadome.onrender.com --key <ADMIN_PASS>

  Env fallback:
    ADMIN_BASE_URL, ADMIN_PASS
*/

const axios = require("axios");

function parseArgs(argv) {
  const out = {
    base: process.env.ADMIN_BASE_URL || process.env.DEPLOY_BASE_URL || "https://alphadome.onrender.com",
    key: process.env.ADMIN_PASS || "",
    role: "super_admin",
    actor: "deploy-smoke",
    timeoutMs: 30000,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--base" && next) {
      out.base = next;
      i += 1;
    } else if (arg === "--key" && next) {
      out.key = next;
      i += 1;
    } else if (arg === "--role" && next) {
      out.role = next;
      i += 1;
    } else if (arg === "--actor" && next) {
      out.actor = next;
      i += 1;
    } else if (arg === "--timeout" && next) {
      out.timeoutMs = Number(next) > 0 ? Number(next) : out.timeoutMs;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    }
  }

  return out;
}

function fmtResult(ok, label, detail) {
  const icon = ok ? "OK" : "FAIL";
  console.log(`[${icon}] ${label}${detail ? ` - ${detail}` : ""}`);
}

async function get(client, label, path) {
  try {
    const res = await client.get(path);
    fmtResult(true, label, `HTTP ${res.status}`);
    return { ok: true, data: res.data };
  } catch (err) {
    const status = err.response?.status || "n/a";
    const msg = err.response?.data?.error || err.message;
    fmtResult(false, label, `HTTP ${status} ${msg}`);
    return { ok: false, error: msg, status };
  }
}

async function post(client, label, path, body) {
  try {
    const res = await client.post(path, body);
    fmtResult(true, label, `HTTP ${res.status}`);
    return { ok: true, data: res.data };
  } catch (err) {
    const status = err.response?.status || "n/a";
    const msg = err.response?.data?.error || err.message;
    fmtResult(false, label, `HTTP ${status} ${msg}`);
    return { ok: false, error: msg, status };
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log("Usage: node scripts/admin_suite_smoke.cjs --base <url> --key <ADMIN_PASS> [--role super_admin] [--actor name]");
    process.exit(0);
  }

  if (!args.key) {
    console.error("Missing admin key. Provide --key or set ADMIN_PASS.");
    process.exit(1);
  }

  const client = axios.create({
    baseURL: args.base,
    timeout: args.timeoutMs,
    headers: {
      "x-admin-role": args.role,
      "x-admin-actor": args.actor,
    },
    params: {
      key: args.key,
      role: args.role,
      actor: args.actor,
    },
  });

  console.log(`Running admin suite smoke against ${args.base}`);

  const checks = [];
  checks.push(await get(client, "Health", "/admin/health"));
  checks.push(await get(client, "Ops Overview", "/admin/api/ops-overview"));
  checks.push(await get(client, "Policies", "/admin/api/policies"));
  checks.push(await get(client, "Audit Feed", "/admin/api/audit/feed?limit=20"));
  checks.push(await get(client, "Action Trail", "/admin/api/audit/actions?limit=20"));
  checks.push(await get(client, "Tenant Risk", "/admin/api/tenants/risk?limit=10"));
  checks.push(await get(client, "SLA Recovery", "/admin/api/sla/recovery-board?limit=10"));
  checks.push(await get(client, "Tenant Readiness", "/admin/api/tenants/readiness?limit=10"));
  checks.push(await get(client, "Revenue Center", "/admin/api/revenue/command-center"));
  checks.push(await get(client, "Support Inbox", "/admin/api/support/inbox?limit=10"));
  checks.push(await get(client, "Finance Recon", "/admin/api/finance/reconciliation?limit=10"));
  checks.push(await get(client, "Template Ops", "/admin/api/templates/ops"));
  checks.push(await get(client, "Incident Active", "/admin/api/incidents/active"));
  checks.push(await get(client, "Approvals", "/admin/api/approvals"));
  checks.push(await get(client, "Executive Snapshot", "/admin/api/executive-snapshot"));

  const tenants = await get(client, "Tenant List", "/admin/api/tenants/list?limit=1");
  checks.push(tenants);

  let bulkDryRun = { ok: false };
  if (tenants.ok && Array.isArray(tenants.data?.tenants) && tenants.data.tenants.length > 0) {
    const tenantId = String(tenants.data.tenants[0].id || "");
    if (tenantId) {
      bulkDryRun = await post(client, "Bulk Tenant Dry Run", "/admin/api/tenants/bulk", {
        action: "activate",
        tenant_ids: [tenantId],
        dry_run: true,
      });
    }
  }
  checks.push(bulkDryRun);

  const failed = checks.filter((c) => !c.ok).length;
  const passed = checks.length - failed;
  console.log(`\nSummary: ${passed}/${checks.length} checks passed.`);

  if (failed > 0) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`Unexpected smoke failure: ${err.message}`);
  process.exit(1);
});
