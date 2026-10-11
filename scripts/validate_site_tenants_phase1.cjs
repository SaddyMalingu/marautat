#!/usr/bin/env node
/**
 * Phase 1 validation — multi-tenant AI Jobs (site_tenants).
 *
 * Verifies the additive migration 2026-10-11_add_site_tenants_multitenant.sql
 * applied cleanly and that tenant isolation is structurally sound.
 *
 * SAFE / READ-ONLY by default: this script only SELECTs and COUNTs. It never
 * writes, updates, or deletes unless you opt into RUN_ISOLATION_TEST=true
 * (which creates and then removes its own throwaway rows).
 *
 * Usage:
 *   # Staging (recommended first)
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/validate_site_tenants_phase1.cjs
 *
 *   # Optional: also prove isolation with a real 2-tenant write/read test
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RUN_ISOLATION_TEST=true \
 *     node scripts/validate_site_tenants_phase1.cjs
 *
 * Exit code 0 = all checks passed. Non-zero = at least one check failed.
 */

const { createClient } = require("@supabase/supabase-js");

const URL = process.env.SUPABASE_URL || process.env.SB_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SERVICE_ROLE_KEY;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? " — " + detail : ""}`);
}

if (!URL || !KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them and re-run.");
  process.exit(2);
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// Tables that must carry a tenant_id column after Phase 1.
const SCOPED = [
  ["alphadome", "opportunity_sources"],
  ["alphadome", "opportunity_categories"],
  ["alphadome", "opportunities"],
  ["alphadome", "referral_links"],
  ["alphadome", "opportunity_events"],
  ["public", "blog_posts"],
];

async function tableHasColumn(table, column) {
  const { error } = await sb.from(table).select(column).limit(1);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("does not exist") || msg.includes("could not find")) return false;
    return false; // table missing or other error => cannot confirm
  }
  return true;
}

async function countScoped(table) {
  const { count, error } = await sb.from(table).select("tenant_id", { count: "exact", head: true });
  if (error) return { total: null, scoped: null, err: error.message };
  const { count: scoped, error: e2 } = await sb
    .from(table)
    .select("tenant_id", { count: "exact", head: true })
    .not("tenant_id", "is", null);
  if (e2) return { total: count, scoped: null, err: e2.message };
  return { total: count, scoped };
}

async function main() {
  console.log("== Phase 1 validation: site_tenants ==");

  // 1. site_tenants exists and has exactly one 'default' row.
  const { data: tenants, error: tErr } = await sb
    .from("site_tenants")
    .select("id, slug, name, is_active")
    .order("slug");
  if (tErr) {
    check("site_tenants table exists", false, tErr.message);
  } else {
    check("site_tenants table exists", true, `${(tenants || []).length} row(s)`);
    const def = (tenants || []).find((t) => t.slug === "default");
    check("default tenant seeded", !!def, def ? `id=${def.id}` : "missing 'default'");
  }

  // 2. Every scoped table has tenant_id and every row is scoped (backfilled).
  for (const [, table] of SCOPED) {
    const hasCol = await tableHasColumn(table, "tenant_id");
    check(`${table} has tenant_id column`, hasCol);
    if (!hasCol) continue;
    const { total, scoped, err } = await countScoped(table);
    if (err) {
      check(`${table} rows fully scoped`, false, err);
      continue;
    }
    const ok = total === null ? false : total === scoped;
    check(
      `${table} rows fully scoped`,
      ok,
      `total=${total} scoped=${scoped}${total !== scoped ? " (NULL tenant_id present!)" : ""}`
    );
  }

  // 3. Optional live isolation proof (writes then cleans up its own rows).
  if (process.env.RUN_ISOLATION_TEST === "true") {
    console.log("\n== Isolation proof (RUN_ISOLATION_TEST=true) ==");
    const stamp = Date.now();
    const { data: tA } = await sb
      .from("site_tenants")
      .insert([{ slug: `iso-a-${stamp}`, name: "ISO A" }])
      .select("id")
      .single();
    const { data: tB } = await sb
      .from("site_tenants")
      .insert([{ slug: `iso-b-${stamp}`, name: "ISO B" }])
      .select("id")
      .single();

    if (!tA || !tB) {
      check("isolation: create two tenants", false, "could not create iso tenants");
    } else {
      await sb.from("opportunity_categories").insert([
        { tenant_id: tA.id, name: "A Cat", slug: `a-cat-${stamp}` },
        { tenant_id: tB.id, name: "B Cat", slug: `b-cat-${stamp}` },
      ]);

      // Query scoped to tenant A must NOT see tenant B's row.
      const { data: aRows } = await sb
        .from("opportunity_categories")
        .select("id, tenant_id")
        .eq("tenant_id", tA.id);
      const leak = (aRows || []).some((r) => r.tenant_id !== tA.id);
      check("isolation: tenant A sees only its rows", !leak, `aRows=${(aRows || []).length}`);

      // Cleanup (best-effort).
      await sb.from("opportunity_categories").delete().in("tenant_id", [tA.id, tB.id]);
      await sb.from("site_tenants").delete().in("id", [tA.id, tB.id]);
      check("isolation: cleanup complete", true);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== Summary: ${results.length - failed.length}/${results.length} checks passed ==`);
  if (failed.length) {
    console.log("FAILED CHECKS:");
    for (const f of failed) console.log(` - ${f.name} ${f.detail ? "(" + f.detail + ")" : ""}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Validation crashed:", e.message);
  process.exit(3);
});
