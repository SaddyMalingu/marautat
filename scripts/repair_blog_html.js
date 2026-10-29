#!/usr/bin/env node

/**
 * Rebuild blog pages that no longer render properly.
 *
 * Live 2026-10-26: a probe of the 283 published pages on /blog found 105 failing
 * at least one rendering rule — 27 pasting a whole HTML document (own <html>,
 * <body> and a `background:#fff` / `color:#fff` palette, 20 of them carrying the
 * second <style> block), 10 with a white background rule, 97 repeating the page
 * title as their own <h1>, and a handful with literal markdown. A <style> still
 * applies inside <body>, so the model's palette overrode the site theme and some
 * pages rendered white-on-white — a paying tenant opening "its" blog saw a blank
 * page. sanitizeArticleHTML() stops new pages from getting there; this script
 * repairs the ones already stored, because restoreFromDB() copies html_content
 * verbatim on every boot.
 *
 * It also repairs copy that reached the page as literal markdown (`**bold**`,
 * `### heading`, `* bullet`) and pages carrying the model's own h1 on top of the
 * template's: both are part of the audit's rules now.
 *
 * 2026-10-29: and pages that cannot convert. Counting the live corpus found 96
 * pages with no closing block at all and 21 with a block but nothing to press —
 * neither is a readability failure, so the audit passed them and the boot
 * migration never looked at them. A page that persuades and then stops is broken
 * for the same reason a blank one is.
 *
 * It rebuilds each failing page from its stored article body (`content`) with the
 * same template the writers use, writes the static file, and (with --apply) saves
 * the repaired html_content back to Supabase.
 *
 * Dry run by default — it only prints what would be rebuilt.
 *
 * Usage:
 *   node scripts/repair_blog_html.js                 # audit the whole blog
 *   node scripts/repair_blog_html.js --apply         # rebuild + save
 *   node scripts/repair_blog_html.js --slug=<slug>   # one page
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same keys the server uses).
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const APPLY = process.argv.includes("--apply");
const slugArg = process.argv.find((a) => a.startsWith("--slug="));
const ONLY_SLUG = slugArg ? slugArg.slice("--slug=".length).replace(/\.html$/, "") : null;
const BLOG_DIR = path.join(process.cwd(), "public", "blog");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them and re-run.");
  process.exit(2);
}

const sb = createClient(url, key);
// Imported dynamically: blogManager builds its own Supabase client at module load,
// so dotenv.config() above has to run first. auditBlogHTML lives in the pure
// module (blogManager does not re-export it).
const { buildHTML, updateIndex } = await import("./blogManager.js");
const { auditBlogHTML } = await import("../utils/articleHtml.js");
const { needsClosingBlock } = await import("../utils/ctaBlock.js");

async function loadRows() {
  let query = sb
    .from("blog_posts")
    .select("slug, title, content, html_content, category, thumbnail_url, opportunity_id, tenant_id, created_at, updated_at")
    .order("slug", { ascending: true });
  if (ONLY_SLUG) query = query.eq("slug", ONLY_SLUG);
  const { data, error } = await query;
  if (error) throw new Error("Query failed: " + error.message);
  return data || [];
}

async function offersById(ids) {
  const map = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return map;
  const { data, error } = await sb
    .from("opportunities")
    .select("id, title, offer_type, cta_label")
    .in("id", unique);
  if (error) {
    // A missing column must not stop the repair: the template only degrades the
    // CTA wording when the offer row is absent.
    console.warn("  (could not load offers: " + error.message + ")");
    return map;
  }
  for (const row of data || []) map.set(row.id, row);
  return map;
}

async function main() {
  const rows = await loadRows();
  if (!rows.length) {
    console.log(ONLY_SLUG ? `No post found for slug ${ONLY_SLUG}.` : "No posts found.");
    return;
  }

  const offers = await offersById(rows.map((r) => r.opportunity_id));
  const broken = [];

  for (const row of rows) {
    const html = row.html_content || "";
    if (!html) {
      broken.push({ row, issues: ["no-html-content"], fixable: false });
      continue;
    }
    const audit = auditBlogHTML(html);
    if (!audit.ok) broken.push({ row, issues: audit.issues, fixable: !!row.content });
    else if (needsClosingBlock(html)) broken.push({ row, issues: ["no closing block"], fixable: !!row.content });
  }

  console.log(`Checked ${rows.length} post(s); ${broken.length} need attention.`);
  for (const b of broken) {
    const who = b.row.tenant_id ? "tenant " + String(b.row.tenant_id).slice(0, 8) : "no tenant";
    console.log(`  - ${b.row.slug}  (${who})  ${b.issues.join(", ")}${b.fixable ? "" : "  [no stored body — cannot rebuild]"}`);
  }
  if (!broken.length) return;

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to rebuild these pages.");
    return;
  }

  let rebuilt = 0;
  let saved = 0;
  let stillBad = 0;
  for (const b of broken) {
    if (!b.fixable) { stillBad++; continue; }
    const row = b.row;
    const html = buildHTML({
      title: row.title || row.slug,
      slug: row.slug,
      content: row.content,
      thumb: row.thumbnail_url || null,
      date: row.created_at || row.updated_at || null,
    }, offers.get(row.opportunity_id) || (row.opportunity_id ? { id: row.opportunity_id } : null));

    const audit = auditBlogHTML(html);
    if (!audit.ok || needsClosingBlock(html)) {
      stillBad++;
      console.log(`  ! ${row.slug} still fails after rebuild: ${audit.ok ? 'no closing block' : audit.issues.join(", ")}`);
      continue;
    }

    const file = path.join(BLOG_DIR, row.slug + ".html");
    try {
      fs.mkdirSync(BLOG_DIR, { recursive: true });
      fs.writeFileSync(file, html, "utf8");
      rebuilt++;
    } catch (e) {
      console.log(`  ! ${row.slug}: could not write ${file}: ${e.message}`);
      stillBad++;
      continue;
    }

    const { error } = await sb.from("blog_posts").update({ html_content: html }).eq("slug", row.slug);
    if (error) console.log(`  ! ${row.slug}: rebuilt on disk, database update failed: ${error.message}`);
    else saved++;
  }

  try { updateIndex(); } catch (e) { console.warn("Index rebuild failed:", e.message); }

  console.log(`\nRebuilt ${rebuilt} page(s), saved ${saved} row(s), ${stillBad} left broken.`);
}

main().catch((e) => {
  console.error("Repair failed:", e.message);
  process.exit(1);
});
