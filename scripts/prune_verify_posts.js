#!/usr/bin/env node

/**
 * Remove verifier noise from the public blog.
 *
 * Every scripts/verify_writers_flow.js run generates real, published posts whose
 * titles start with "verify-writers-flow-". Runs before 2026-10-22 had no
 * post-delete path, so those rows (tenant_id IS NULL, offer already deleted) are
 * still visible on /blog. New runs clean up after themselves via
 * DELETE /tenant/blogger/posts/:slug; this script is for the leftovers.
 *
 * Dry run by default — it only prints what would go.
 *
 * Usage:
 *   node scripts/prune_verify_posts.js             # list matches, delete nothing
 *   node scripts/prune_verify_posts.js --apply     # delete rows + static files
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same keys the server uses).
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const APPLY = process.argv.includes("--apply");
const BLOG_DIR = path.join(process.cwd(), "public", "blog");

// Only test artifacts. Real tenant posts must never match these prefixes.
const PREFIXES = ["verify-writers-flow-", "test-ai-specialist"];

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them and re-run.");
  process.exit(2);
}

const sb = createClient(url, key);

async function main() {
  const filter = PREFIXES.map((p) => `slug.like.${p}*`).join(",");
  const { data, error } = await sb
    .from("blog_posts")
    .select("slug, title, status, tenant_id, created_at")
    .or(filter)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  const rows = data || [];
  if (!rows.length) {
    console.log("Nothing to prune — no verify-* posts on the blog.");
    return;
  }

  console.log(`${rows.length} matching post(s):`);
  for (const r of rows) {
    const owner = r.tenant_id ? `tenant ${String(r.tenant_id).slice(0, 8)}` : "no tenant";
    console.log(`  - ${r.slug}  (${r.status}, ${owner}, ${String(r.created_at).slice(0, 10)})`);
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to delete these rows.");
    return;
  }

  const slugs = rows.map((r) => r.slug);
  const { error: delErr } = await sb.from("blog_posts").delete().in("slug", slugs);
  if (delErr) {
    console.error("Delete failed:", delErr.message);
    process.exit(1);
  }
  console.log(`\nDeleted ${slugs.length} row(s).`);

  let files = 0;
  for (const slug of slugs) {
    const file = path.join(BLOG_DIR, slug + ".html");
    try {
      if (fs.existsSync(file)) { fs.unlinkSync(file); files++; }
    } catch (e) {
      console.warn(`  could not remove ${slug}.html: ${e.message}`);
    }
  }
  console.log(`Removed ${files} static file(s) from ${BLOG_DIR}.`);
  console.log("Restart the service (or wait for the next boot) so the blog index rebuilds.");
}

main().catch((e) => {
  console.error("Prune failed:", e.message);
  process.exit(1);
});
