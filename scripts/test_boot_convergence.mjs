#!/usr/bin/env node

/**
 * Offline proof that the boot restore converges.
 *
 * The repair that shipped on 2026-10-29 rebuilds up to 117 stored pages on the
 * first boot (96 with no closing block at all, 21 with a block and nothing to
 * press). The thing that can go wrong next is not "it misses a page" — it is
 * "it rebuilds the same pages on every boot, forever", silently, on every
 * deploy. That is what this file tests, and it is the reason the predicate and
 * the template have to agree: pageNeedsRebuild() must return false for anything
 * buildHTML() produces.
 *
 * The restore loop itself needs a database, so it cannot be imported here. The
 * *decision* can, and does: pageNeedsRebuild() is the same function
 * restoreFromDB() calls, so this exercises production logic rather than a copy
 * of it. What is mirrored here is only the six-line loop around it (rebuild from
 * `content`, keep it only if the rebuild passes the audit), and the checks below
 * would catch that mirror drifting because they assert on the resulting pages.
 *
 * Runs entirely in-process — no network, no database.
 *
 * Usage: npm run test:boot-convergence
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */

import chalk from "chalk";
import { auditBlogHTML } from "../utils/articleHtml.js";
import { pageNeedsRebuild, needsClosingBlock } from "../utils/ctaBlock.js";

const results = [];
const record = (status, name, detail = "") => {
  results.push({ status, name, detail });
  const line = `${name}${detail ? " — " + detail : ""}`;
  if (status === "PASS") console.log(chalk.green(`+ ${line}`));
  else console.log(chalk.red(`x ${line}`));
};

async function check(name, fn) {
  try {
    const detail = await fn();
    record("PASS", name, detail || "");
  } catch (e) {
    record("FAIL", name, e.message);
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const textOf = (html) => String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const articleOf = (html) => (String(html).match(/<article>([\s\S]*?)<\/article>/) || [])[1] || "";

// blogManager builds a Supabase client at import time; give it throwaway values
// so the page template can be exercised without a host.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role-key";
const { buildHTML } = await import("../scripts/blogManager.js");

// ---------------------------------------------------------------------------
// Fixtures: stored pages in the four shapes the live corpus actually had.

const BODY = "<h2>What the pay actually looks like</h2>"
  + "<p>Salary pages fail when they quote one number and stop. The band a reader is offered depends on the "
  + "county, the shift pattern and whether the employer is covering transport, so a single figure is a claim "
  + "the page cannot support and an interviewer can unpick in one question.</p>"
  + "<p>The useful shape is a range with its assumptions printed next to it: base, allowances, and what is "
  + "deducted before the figure reaches a bank account. A reader who can see the assumptions can tell whether "
  + "the number applies to them without asking anyone.</p>"
  + "<p>Where an employer publishes only a maximum, say so. A page that admits the ceiling is unknown is more "
  + "persuasive than one that quietly implies the ceiling is the offer, and it is the difference between a "
  + "reader who applies informed and one who leaves at the first payslip.</p>"
  + "<ul><li>Hourly band, before deductions</li><li>Annual band, before deductions</li></ul>";

const SHELL = (inner) => '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
  + "<style>body{background:var(--bg);color:var(--fg);font-family:system-ui}</style></head>"
  + "<body>" + inner + "</body></html>";

const ARTICLE = "<h1>Defense Analyst Salary In Kenya</h1><article>" + BODY + "</article>";

// The closing block the old template wrote on every page, job or not.
const LEGACY_TAIL = '<div style="text-align:center"><h2>Ready to Start?</h2>'
  + "<p>This opportunity is available now.</p>"
  + '<a href="/ai-jobs/apply/abc">Apply Now</a></div>';

// A block that talks but gives the reader nothing to press — the 21 pages.
const SILENT_TAIL = '<div class="cta"><h2>Apply for this role</h2>'
  + "<p>Send a message and the business will reply with the details.</p></div>";

// A page carrying the no-destination note twice — the state 56 of the 434 live
// pages were in on 2026-10-31, when the fallback branch returned the full block
// before checking for the compact variant and printed it above the article too.
const NOTE = "This offer has no link configured yet, so send a message and the business will reply with the details.";
const FULL_FALLBACK = '<div class="cta"><h2>Apply for this role</h2><p>' + NOTE + "</p>"
  + '<a class="cta-btn cta-btn--alt" href="/ai-jobs">Browse other opportunities</a></div>';
const DOUBLE_NOTE = SHELL(ARTICLE + FULL_FALLBACK + FULL_FALLBACK);

// A page whose button leaves for the provider without passing through this server —
// the state 378 of 434 live pages were in on 2026-10-31. It converts; nobody can
// count it.
const PROVIDER_LINK = SHELL(ARTICLE
  + '<div class="cta"><h2>Apply for Defense Analyst</h2>'
  + '<a class="cta-btn" href="https://careers.example/jobs/7">Apply now</a></div>');

// A page that fails the readability audit for a reason of its own.
const UNREADABLE = SHELL("<h1>T</h1><article><p>"
  + '<span style="background:#fff">**bold** copy that reached the page as literal characters</span></p></article>');

const OFFERS = new Map([
  ["job-with-url", { id: "o1", offer_type: "job", title: "Defense Analyst", destination_url: "https://careers.example/jobs/7", compensation_max: 180000, compensation_currency: "KES", location_text: "Nairobi" }],
  ["job-no-url", { id: "o2", offer_type: "job", title: "Watch Officer" }],
]);

const CORPUS = [
  { slug: "no-block", title: "Defense Analyst Salary In Kenya", content: BODY, opportunity_id: "job-with-url", html_content: SHELL(ARTICLE), expect: "no closing block" },
  { slug: "silent-block", title: "Defense Analyst Salary In Kenya", content: BODY, opportunity_id: "job-with-url", html_content: SHELL(ARTICLE + SILENT_TAIL), expect: "no closing block" },
  { slug: "legacy-footer", title: "Defense Analyst Salary In Kenya", content: BODY, opportunity_id: "job-with-url", html_content: SHELL(ARTICLE + LEGACY_TAIL), expect: "old closing block" },
  // The state 56 live pages were in on 2026-10-31: a real button, but the same
  // "nothing configured" sentence above and below the article.
  { slug: "double-note", title: "Defense Analyst Salary In Kenya", content: BODY, opportunity_id: null, html_content: DOUBLE_NOTE, expect: "repeated fallback note" },
  { slug: "unmetered", title: "Defense Analyst Salary In Kenya", content: BODY, opportunity_id: "job-with-url", html_content: PROVIDER_LINK, expect: "unmetered provider link" },
  { slug: "unreadable", title: "T", content: BODY, opportunity_id: "job-with-url", html_content: UNREADABLE, expect: "audit" },
  // A page with no article body at all. It has stored content, so it is rebuilt on
  // its own merit — it fails the readability audit for thin content. The predicate's
  // "requires an <article>" rule exists so the *closing-block* checks never flag a
  // page like this; test:blog-html asserts that directly.
  { slug: "no-article-stub", title: "Redirect", content: BODY, opportunity_id: null, html_content: SHELL("<p>This page moved.</p>"), expect: "audit" },
  { slug: "no-content", title: "Orphan", content: null, opportunity_id: null, html_content: SHELL("<p>Nothing stored to rebuild from.</p>"), expect: null },
];

// A published page the current template already built: it must not be touched.
const HEALTHY = buildHTML(
  { title: "Defense Analyst Salary In Kenya", slug: "healthy", content: BODY },
  OFFERS.get("job-with-url"),
);
CORPUS.push({ slug: "healthy", title: "Defense Analyst Salary In Kenya", content: BODY, opportunity_id: "job-with-url", html_content: HEALTHY, expect: null });

/**
 * One boot, as restoreFromDB() runs it: decide, rebuild from `content`, keep the
 * rebuild only if it passes the audit, and persist it (the corpus stands in for
 * blog_posts.html_content).
 */
function boot(corpus, opts = {}) {
  const mayRebuildFooter = opts.mayRebuildFooter !== false;
  const log = [];
  const out = corpus.map((post) => {
    if (!post.html_content) return post;
    const audit = auditBlogHTML(post.html_content);
    const decision = pageNeedsRebuild({
      html: post.html_content,
      auditOk: audit.ok,
      issues: audit.issues,
      mayRebuildFooter,
    });
    if (!decision.rebuild || !post.content) return post;
    const offer = post.opportunity_id ? (OFFERS.get(post.opportunity_id) || { id: post.opportunity_id }) : null;
    const fixed = buildHTML({ title: post.title || post.slug, slug: post.slug, content: post.content }, offer);
    if (!auditBlogHTML(fixed).ok) {
      log.push({ slug: post.slug, reason: "rebuild still fails the audit" });
      return post;
    }
    log.push({ slug: post.slug, reason: decision.reason });
    return { ...post, html_content: fixed };
  });
  return { corpus: out, log };
}

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";

// ---------------------------------------------------------------------------
await check("boot 1: rebuilds exactly the pages that cannot convert", () => {
  const rebuilt = boot(CORPUS).log.map((l) => l.slug).sort();
  assert(!rebuilt.includes("healthy"), "a page the template just built was rebuilt — it would be rebuilt on every deploy");
  assert(!rebuilt.includes("no-content"), "a row with no stored content was counted as rebuilt");
  for (const post of CORPUS.filter((p) => p.expect)) {
    assert(rebuilt.includes(post.slug), post.slug + " was not rebuilt — it stays broken in production");
  }
  return `${rebuilt.length} rebuilt: ${rebuilt.join(", ")}`;
});

await check("boot 1: the log names the rule that fired", () => {
  const byslug = Object.fromEntries(boot(CORPUS).log.map((l) => [l.slug, l.reason]));
  assert(byslug["no-block"] === "no closing block", "no-block logged '" + byslug["no-block"] + "'");
  assert(byslug["silent-block"] === "no closing block", "silent-block logged '" + byslug["silent-block"] + "'");
  assert(byslug["legacy-footer"] === "old closing block", "legacy-footer logged '" + byslug["legacy-footer"] + "'");
  assert(byslug["double-note"] === "repeated fallback note", "double-note logged '" + byslug["double-note"] + "'");
  assert(byslug["unmetered"] === "unmetered provider link", "unmetered logged '" + byslug["unmetered"] + "'");
  assert(/markdown-bold|white-background/.test(byslug["unreadable"] || ""),
    "the unreadable page logged '" + byslug["unreadable"] + "' instead of its audit issues");
  return "no closing block / old closing block / repeated fallback note / audit issues";
});

await check("boot 2: rebuilds nothing at all — the fixed point", () => {
  const second = boot(boot(CORPUS).corpus);
  assert(second.log.length === 0,
    "the second boot rebuilt " + second.log.length + " page(s) ("
    + second.log.map((l) => `${l.slug}: ${l.reason}`).join(", ") + ") — every deploy would rewrite them again");
  return "0 rebuilt";
});

await check("boot 3+: still nothing — stable, not oscillating", () => {
  let state = boot(CORPUS).corpus;
  for (let i = 0; i < 3; i++) {
    const pass = boot(state);
    assert(pass.log.length === 0, "pass " + (i + 2) + " rebuilt " + pass.log.map((l) => l.slug).join(", "));
    state = pass.corpus;
  }
  return "3 further boots, 0 rewrites";
});

await check("a rebuilt page keeps every sentence the reader already had", () => {
  const { corpus } = boot(CORPUS);
  for (const post of CORPUS.filter((p) => p.expect && p.slug !== "unreadable")) {
    const after = textOf(articleOf(corpus.find((p) => p.slug === post.slug).html_content));
    // Every paragraph, heading and list item of the stored body must survive the
    // rebuild verbatim. The template adds its own <h1> and a published line, so
    // comparing whole-article text would fail for the right rebuild.
    const chunks = (String(post.content).match(/<(p|li|h2|h3)[^>]*>([\s\S]*?)<\/\1>/g) || [])
      .map(textOf).filter((t) => t.length > 20);
    assert(chunks.length >= 4, post.slug + " fixture is too thin to prove anything (" + chunks.length + " chunks)");
    for (const c of chunks) {
      assert(after.includes(c), post.slug + " dropped a sentence: \"" + c.slice(0, 60) + "...\"");
    }
  }
  return "every paragraph and list item intact";
});

await check("a healthy page is not rewritten at all", () => {
  const after = boot(CORPUS).corpus.find((p) => p.slug === "healthy").html_content;
  assert(after === HEALTHY, "the healthy page was rewritten");
  return "byte-identical";
});

await check("every rebuilt page ends with something to press", () => {
  const { corpus } = boot(CORPUS);
  for (const post of corpus.filter((p) => p.expect)) {
    assert(!needsClosingBlock(post.html_content), post.slug + " still has nothing to press after its rebuild");
    assert(/<a class="cta-btn[^"]*" href="[^"]+"/.test(post.html_content), post.slug + " has a cta-btn with no destination");
  }
  return "all rebuilt pages have a live button";
});

await check("kill switch: BLOG_REBUILD_STALE_PAGES=off leaves stored pages alone", () => {
  const rebuilt = boot(CORPUS, { mayRebuildFooter: false }).log.map((l) => l.slug).sort();
  assert(!rebuilt.includes("no-block"), "the kill switch did not protect the no-block page");
  assert(!rebuilt.includes("silent-block"), "the kill switch did not protect the silent-block page");
  assert(!rebuilt.includes("legacy-footer"), "the kill switch did not protect the legacy-footer page");
  assert(rebuilt.includes("unreadable"), "the kill switch stopped a real readability repair — that is not what it is for");
  return "stale pages kept, unreadable pages still repaired";
});

await check("a row that cannot be rebuilt is visible, not silently dropped", () => {
  const { log } = boot(CORPUS);
  assert(!log.some((l) => l.slug === "no-content"), "a row with no content was counted as rebuilt");
  const stranded = CORPUS.filter((p) => !p.content && p.html_content
    && pageNeedsRebuild({ html: p.html_content, auditOk: auditBlogHTML(p.html_content).ok }).rebuild);
  assert(stranded.length === 1, "a page that needs rebuilding but has no content to rebuild from was not detectable");
  return `${stranded.length} stranded row — countable by the audit, never rewritten`;
});

await check("convergence across every offer type and destination shape", () => {
  const shapes = [
    { name: "destination_url", extra: { destination_url: "https://shop.example/item" } },
    { name: "referral_url", extra: { referral_url: "https://partner.example/landing" } },
    { name: "application_url", extra: { application_url: "https://ats.example/apply/9" } },
    { name: "tracked id only", extra: {} },
    { name: "no offer at all", noOffer: true },
  ];
  const types = ["job", "product", "service", "course", "affiliate", "brand"];
  const unstable = [];
  let seen = 0;
  for (const t of types) {
    for (const shape of shapes) {
      const offer = shape.noOffer ? null : {
        id: "offer-" + t, offer_type: t, title: "Sample Offer", ...shape.extra,
      };
      const page = buildHTML({ title: "T", slug: "s", content: BODY }, offer);
      const audit = auditBlogHTML(page);
      const decision = pageNeedsRebuild({ html: page, auditOk: audit.ok, issues: audit.issues });
      seen++;
      if (decision.rebuild) unstable.push(`${t}/${shape.name}: ${decision.reason}`);
      if (!/<a class="cta-btn[^"]*" href="[^"]+"/.test(page)) unstable.push(`${t}/${shape.name}: no button with a destination`);
    }
  }
  assert(unstable.length === 0, "not converged — these would be rebuilt on every boot: " + unstable.join(" | "));
  return `${seen} combinations, all stable`;
});

await check("an offer with no destination still gives the reader a route", () => {
  const page = buildHTML({ title: "T", slug: "s", content: BODY }, { id: "x1", offer_type: "service", title: "Studio Session" });
  assert(/href="\/go\/x1"/.test(page), "an unconfigured offer did not fall back to the tracked redirect");
  const orphan = buildHTML({ title: "T", slug: "s", content: BODY }, { offer_type: "service", title: "Studio Session" });
  assert(/href="\/ai-jobs"/.test(orphan), "an offer with no id and no URL left the reader with nowhere to go");
  return "tracked redirect, then /ai-jobs";
});

// ---------------------------------------------------------------------------
const failed = results.filter((r) => r.status === "FAIL");
console.log("");
console.log(`Summary: ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(chalk.red(`  FAIL ${f.name}: ${f.detail}`));
  process.exit(1);
}
