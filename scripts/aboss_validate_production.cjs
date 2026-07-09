#!/usr/bin/env node

const BASE = process.env.ABOSS_BASE_URL || "https://alphadome.onrender.com";
const KEY = process.env.ABOSS_ADMIN_KEY || "myverify123";

async function getJson(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, url, data };
}

async function main() {
  const checks = [
    { name: "Ops Overview", path: `/admin/api/ops-overview?key=${encodeURIComponent(KEY)}` },
    { name: "Revenue Command Center", path: `/admin/api/revenue/command-center?key=${encodeURIComponent(KEY)}` },
    { name: "WF Stats", path: `/admin/api/wf/stats?key=${encodeURIComponent(KEY)}` },
    { name: "WF Campaigns", path: `/admin/api/wf/campaigns?key=${encodeURIComponent(KEY)}` },
  ];

  const lines = [];
  lines.push("=== ABoss Production Validation ===");
  lines.push(`Base: ${BASE}`);
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push("");

  for (const c of checks) {
    try {
      const r = await getJson(c.path);
      const marker = r.ok ? "PASS" : "FAIL";
      const summary = r.data?.error
        ? r.data.error
        : r.data?.kpis
          ? `revenue_30d=${r.data.kpis.total_revenue_kes_30d || 0}, attempts=${r.data.kpis.payment_attempts_30d || 0}`
          : "ok";
      lines.push(`[${marker}] ${c.name} (${r.status}) - ${summary}`);
    } catch (err) {
      lines.push(`[FAIL] ${c.name} - ${err.message}`);
    }
  }

  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error("Validation failed:", err.message);
  process.exit(1);
});
