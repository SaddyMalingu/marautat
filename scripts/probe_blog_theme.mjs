#!/usr/bin/env node

/**
 * Verify "one theme per page" on the live blog.
 *
 * scripts/test_blog_html_sanitize.mjs proves the guard offline and
 * scripts/repair_blog_html.js fixes stored rows, but neither answers the question
 * a tenant asks: "does the page I can actually open render?" This fetches every
 * page linked from /blog and runs the same auditBlogHTML() rules the writers are
 * held to — one <style>, one <html>, one <body>, no model CSS in the article, no
 * literal markdown, no white-on-white palette, real article text.
 *
 * Usage:
 *   node scripts/probe_blog_theme.mjs                       # audit the live blog
 *   node scripts/probe_blog_theme.mjs --base=http://localhost:3000
 *   node scripts/probe_blog_theme.mjs --out=.blog_probe.json
 *
 * Exit codes: 0 = every page passes, 1 = at least one page fails, 2 = the index
 * itself could not be read (deploy down, wrong base URL).
 */

import fs from "node:fs";
import { auditBlogHTML } from "../utils/articleHtml.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg("base", process.env.SITE_URL || "https://alphadome.onrender.com").replace(/\/+$/, "");
const OUT = arg("out", ".blog_probe.json");
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "6")) || 6);

async function get(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "alphadome-blog-probe/1.0" },
    // A page that never answers must not hang the whole audit.
    signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, text: await res.text() };
}

const index = await get(BASE + "/blog");
if (index.status !== 200) {
  console.error("Cannot read " + BASE + "/blog (HTTP " + index.status + ").");
  process.exit(2);
}

const slugs = [...new Set([...index.text.matchAll(/\/blog\/([a-z0-9][a-z0-9-]*)(?:\.html)?["'?]/gi)].map((m) => m[1]))]
  .filter((s) => s !== "index");
console.log("Probing " + slugs.length + " page(s) on " + BASE + " ...");

const rows = [];
let cursor = 0;

async function worker() {
  while (cursor < slugs.length) {
    const slug = slugs[cursor++];
    let page;
    try {
      page = await get(BASE + "/blog/" + slug);
    } catch (e) {
      rows.push({ slug, status: "ERR", note: e.message, ok: false, issues: ["fetch-failed"] });
      continue;
    }
    const audit = auditBlogHTML(page.text);
    // The audit reads the page; these two catches what a reader *sees*: an
    // unreadable palette anywhere on the page, and literal backticks.
    const whiteOnWhite = /background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b/i.test(page.text);
    const issues = audit.issues.slice();
    if (whiteOnWhite) issues.push("white-background-anywhere");
    rows.push({
      slug,
      status: page.status,
      bytes: page.text.length,
      textLen: audit.textLen,
      ok: page.status === 200 && issues.length === 0,
      issues,
    });
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const bad = rows.filter((r) => !r.ok).sort((a, b) => a.slug.localeCompare(b.slug));
fs.writeFileSync(OUT, JSON.stringify({ base: BASE, checked: rows.length, failing: bad.length, rows }, null, 2), "utf8");

console.log("");
for (const r of bad) console.log("FAIL " + r.slug + "  [" + r.issues.join(", ") + "]");
console.log("Checked " + rows.length + " page(s) at " + BASE + "/blog: " + bad.length + " failing. Details: " + OUT);
process.exitCode = bad.length ? 1 : 0;
