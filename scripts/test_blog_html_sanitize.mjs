#!/usr/bin/env node

/**
 * Offline test for the blog HTML guard (utils/articleHtml.js) and the page
 * template that consumes it (scripts/blogManager.js buildHTML).
 *
 * Production failures this protects against (live 2026-10-26, /blog):
 *   1) Some models answered with a whole HTML document — own <html>/<body> and a
 *      <head> <style> saying `background:#fff`/`color:#fff`. A <style> element
 *      still applies when it sits inside <body>, so the model's palette overrode
 *      the theme and the article vanished into a white page.
 *   2) 27 of 283 published pages carried that second <style> block; a handful
 *      were also fenced in ```html, which showed up as visible backticks.
 *
 * Runs entirely in-process — no network, no database (the Supabase client built
 * by blogManager is never used).
 *
 * Usage: npm run test:blog-html
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */

import chalk from "chalk";
import { sanitizeArticleHTML, auditBlogHTML, escapeAttr } from "../utils/articleHtml.js";
import { isStalePage, needsClosingBlock } from "../utils/ctaBlock.js";
import { isTestArtifact, orphanPageFiles, indexIsStale, articleBodyOf, plainTextOf } from "../utils/blogIndex.js";

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

// ---------------------------------------------------------------------------
// Fixtures shaped like pages that were live-broken.
const BODY_WORDS = "Defense analysts translate raw intelligence into decisions commanders can act on. "
  + "The work is part research, part briefing, and part stakeholder management.";

const INJECTED_DOCUMENT = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Defense Analyst Awareness</title>
<style>
  body { font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; background:#f9f9f9; }
  h1, h2, h3 { color:#2c3e50; }
  .section { background:#fff; padding:20px; margin-bottom:20px; border-radius:8px; }
</style>
</head>
<body text="#ffffff">
<h2>What the role actually is</h2>
<div class="section"><p>${BODY_WORDS}</p></div>
<h2>How to prepare</h2>
<ul><li>Learn structured analysis</li><li>Practice writing briefs</li></ul>
<font color="#ffffff">White text the model added</font>
</body>
</html>`;

const FENCED_FRAGMENT = '```html\n<h2>Salary bands</h2>\n<p>' + BODY_WORDS + '</p>\n```';

const INLINE_WHITE = '<h2>Pay</h2><p style="color:#fff;background:#ffffff;padding:1rem">'
  + BODY_WORDS + '</p><table bgcolor="#ffffff"><tr><td>Band</td><td>USD</td></tr></table>';

const CLEAN_FRAGMENT = '<h2>Salary breakdown</h2><p>' + BODY_WORDS + '</p>'
  + '<ul><li>Hourly</li><li>Yearly</li></ul>'
  + '<table style="border:1px solid #333"><tr><th>Band</th><th>USD</th></tr></table>';

// blogManager builds a Supabase client at import time; give it throwaway values
// so the template can be exercised without a host.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role-key";
const { buildHTML } = await import("../scripts/blogManager.js");

const OFFER = { id: "11111111-2222-3333-4444-555555555555", offer_type: "job", cta_label: "Apply Now" };

// ---------------------------------------------------------------------------
await check("full document: <style>, <html>, <head>, <body> are removed", () => {
  const out = sanitizeArticleHTML(INJECTED_DOCUMENT);
  assert(!/<style/i.test(out), "a <style> survived");
  assert(!/<html|<head|<body/i.test(out), "document scaffolding survived");
  assert(!/background/i.test(out), "a background declaration survived");
  assert(!/<font/i.test(out), "<font> survived");
  assert(out.includes("What the role actually is"), "article headings were lost");
  return `${out.length} chars kept`;
});

await check("full document: body text is preserved, not blanked", () => {
  const out = sanitizeArticleHTML(INJECTED_DOCUMENT);
  const words = textOf(out).split(" ").length;
  assert(words > 20, "body text lost (" + words + " words)");
  return `${words} words`;
});

await check("fenced answer: ```html fences are stripped", () => {
  const out = sanitizeArticleHTML(FENCED_FRAGMENT);
  assert(!out.includes("```"), "backticks survived");
  assert(out.startsWith("<h2>"), "fragment does not start with the heading: " + out.slice(0, 24));
  return "fence removed";
});

await check("inline styles: colour/background dropped, layout kept", () => {
  const out = sanitizeArticleHTML(INLINE_WHITE);
  assert(!/color\s*:\s*#fff/i.test(out), "inline white colour survived");
  assert(!/background/i.test(out), "inline background survived");
  assert(/padding:1rem/.test(out), "padding was dropped with the colour");
  assert(!/bgcolor/i.test(out), "bgcolor attribute survived");
  assert(/<table/.test(out), "table was removed");
  return "layout hints kept";
});

await check("clean fragment is left alone", () => {
  const out = sanitizeArticleHTML(CLEAN_FRAGMENT);
  assert(out === CLEAN_FRAGMENT, "clean copy was rewritten");
  return "unchanged";
});

await check("sanitizer is idempotent", () => {
  const once = sanitizeArticleHTML(INJECTED_DOCUMENT);
  const twice = sanitizeArticleHTML(once);
  assert(once === twice, "second pass changed the copy");
  return "stable";
});

await check("empty input stays empty", () => {
  assert(sanitizeArticleHTML("") === "", "empty string changed");
  assert(sanitizeArticleHTML(null) === "", "null changed");
  return "no throw";
});

// ---------------------------------------------------------------------------
await check("audit: rejects a page carrying the model's document", () => {
  const broken = '<!DOCTYPE html><html><head><style>body{background:var(--bg)}</style></head><body>'
    + '<article><h1>T</h1>' + INJECTED_DOCUMENT + '</article></body></html>';
  const audit = auditBlogHTML(broken);
  assert(!audit.ok, "broken page passed the audit");
  assert(audit.issues.includes("ai-document-in-article"), "did not name the injected document: " + audit.issues.join(","));
  return audit.issues.join(", ");
});

await check("audit: accepts the rebuilt page", () => {
  const html = buildHTML({ title: "Defense Analyst Awareness", slug: "defense-analyst-awareness", content: INJECTED_DOCUMENT }, OFFER);
  const audit = auditBlogHTML(html);
  assert(audit.ok, "rebuilt page still fails: " + audit.issues.join(","));
  return `${audit.textLen} chars of article text`;
});

await check("buildHTML: one <style>, one <html>, one <body>", () => {
  const html = buildHTML({ title: "T", slug: "s", content: INJECTED_DOCUMENT }, OFFER);
  assert((html.match(/<style/gi) || []).length === 1, "style count != 1");
  assert((html.match(/<html/gi) || []).length === 1, "html count != 1");
  assert((html.match(/<body/gi) || []).length === 1, "body count != 1");
  return "single theme";
});

await check("buildHTML: page keeps the dark theme and readable text", () => {
  const html = buildHTML({ title: "T", slug: "s", content: INJECTED_DOCUMENT }, OFFER);
  assert(/body\{[^}]*background:var\(--bg\)/.test(html), "theme background missing");
  assert(/p,li\{color:var\(--muted\)\}/.test(html), "body text colour missing");
  assert(!/background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b/i.test(html), "a white background is still present");
  return "var(--bg) / var(--muted)";
});

await check("buildHTML: quotes in a title cannot break the meta/title tags", () => {
  const html = buildHTML({ title: 'The "real" <script> job', slug: "t", content: CLEAN_FRAGMENT }, OFFER);
  assert(!html.includes("<script>"), "raw <script> from the title reached the page");
  assert(html.includes("&quot;real&quot;"), "title was not escaped");
  assert(/<meta name="description" content="[^"]*">/.test(html), "description tag is malformed");
  return "escaped";
});

await check("buildHTML: an empty article is flagged, not silently shipped", () => {
  const html = buildHTML({ title: "Empty", slug: "empty", content: "   " }, OFFER);
  assert(html.includes("<h1>Empty</h1>"), "no page heading");
  const audit = auditBlogHTML(html);
  assert(audit.issues.some((i) => i.startsWith("thin-content:")), "thin content not flagged: " + audit.issues.join(","));
  return audit.issues.join(", ");
});

// A model that ignores "HTML only" and answers in markdown, like the live pages
// that showed `**SolidWorks Premium Skills Guide**` and `### Application Usage`
// as literal characters.
const MARKDOWN_ANSWER = `**SolidWorks Premium Skills Guide for STEM Users**

## Technical Skills

### Application Usage

Application usage involves understanding the SolidWorks interface and menus.

* Start with the official tutorials
* Practice creating and managing parts, assemblies and drawings

1. Learn sketching
2. Build assemblies

> Ask a senior engineer to review your first drawing.
`;

await check("markdown answer: headings, bold and bullets become HTML", () => {
  const out = sanitizeArticleHTML(MARKDOWN_ANSWER);
  assert(!/\*\*/.test(out), "asterisks survived: " + out.slice(0, 120));
  assert(!/(^|\n)#{1,6}\s/.test(out), "a markdown heading survived");
  assert(out.includes("<strong>SolidWorks Premium Skills Guide for STEM Users</strong>"), "bold was not converted");
  assert(out.includes("<h2>Technical Skills</h2>"), "## did not become an h2");
  assert(out.includes("<h3>Application Usage</h3>"), "### did not become an h3");
  assert(/<ul>\s*<li>Start with the official tutorials<\/li>/.test(out), "bullets were not converted: " + out);
  assert(/<ol>\s*<li>Learn sketching<\/li>/.test(out), "numbered list was not converted: " + out);
  assert(/<p>Application usage involves understanding/.test(out), "paragraph text was dropped");
  assert(/<blockquote><p>Ask a senior engineer/.test(out), "blockquote was not converted");
  return "markdown converted";
});

await check("markdown answer: the converter is idempotent", () => {
  const once = sanitizeArticleHTML(MARKDOWN_ANSWER);
  const twice = sanitizeArticleHTML(once);
  assert(once === twice, "second pass changed the converted copy");
  return "stable";
});

await check("article h1: demoted so the page keeps one h1", () => {
  const out = sanitizeArticleHTML("<h1>Comprehensive Salary Guide</h1><p>" + BODY_WORDS + "</p>");
  assert(!/<h1/i.test(out), "the model's h1 survived");
  assert(out.startsWith("<h2>Comprehensive Salary Guide</h2>"), "title was not demoted: " + out.slice(0, 40));
  const page = buildHTML({ title: "Page title", slug: "s", content: out }, OFFER);
  assert((page.match(/<h1/gi) || []).length === 1, "page has more than one h1");
  return "single h1";
});

await check("audit: flags literal markdown and a repeated title", () => {
  const page = '<!DOCTYPE html><html><head><style>body{background:var(--bg)}</style></head><body><article>'
    + '<h1>Page title</h1><h1>Dup title</h1>\n<p>**not bold** and ' + BODY_WORDS + '</p>\n### Leftover heading\n<ul><li>x</li></ul>'
    + '</article></body></html>';
  const audit = auditBlogHTML(page);
  assert(!audit.ok, "page with literal markdown passed the audit");
  assert(audit.issues.includes("article-h1:2"), "duplicate h1 not named: " + audit.issues.join(","));
  assert(audit.issues.includes("markdown-bold"), "literal ** not named: " + audit.issues.join(","));
  assert(audit.issues.includes("markdown-heading"), "literal ### not named: " + audit.issues.join(","));
  return audit.issues.join(", ");
});

await check("escapeAttr covers the four dangerous characters", () => {
  const out = escapeAttr('a&b"c<d>e');
  assert(out === "a&amp;b&quot;c&lt;d&gt;e", "escapeAttr output: " + out);
  return '& " < >';
});

// ---------------------------------------------------------------------------
// The closing block (2026-10-29). Every page on the site used to end with the
// same three lines — "Ready to Start? / This opportunity is available now. /
// [Apply Now]" — on a job, a product and a course alike, and the button pointed
// at a redirect that 404s when the offer had no destination configured.
await check("cta: the generic block is gone from every page", () => {
  const html = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, OFFER);
  assert(!/Ready to Start\?/.test(html), "the old 'Ready to Start?' heading is still on the page");
  assert(!/This opportunity is available now/.test(html), "the old availability line survived");
  return "old block removed";
});

await check("cta: the heading names the actual offer", () => {
  const job = { id: "abc", offer_type: "job", title: "ML Engineer", compensation_max: 75, compensation_currency: "USD", location_text: "Remote" };
  const html = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, job);
  assert(html.includes("Apply for ML Engineer"), "the heading does not name the role");
  assert(/USD 75 per hour/.test(html), "the rate is missing from the block");
  assert(/Remote/.test(html), "the location is missing from the block");
  const svc = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, { id: "x", offer_type: "service", title: "Studio Session" });
  assert(svc.includes("Get Studio Session priced"), "service heading is not a quote ask");
  assert(!/Learn More/.test(svc), "'Learn More' — the weakest verb in commercial copy — came back");
  return "job names the role and rate; service asks for a quote";
});

await check("cta: one at the top, one at the end, both real links", () => {
  const html = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, { id: "offer-1", offer_type: "job", title: "ML Engineer" });
  const buttons = html.match(/class="cta-btn"/g) || [];
  assert(buttons.length === 2, `expected 2 buttons, found ${buttons.length}`);
  assert((html.match(/href="\/ai-jobs\/apply\/offer-1"/g) || []).length === 2, "the buttons do not point at the tracked redirect");
  assert(html.indexOf('cta-top') < html.indexOf("<article>"), "the top CTA is not above the article");
  assert(html.lastIndexOf('class="cta-btn"') > html.indexOf("</article>"), "the closing CTA is not after the article");
  return "2 buttons, top before article, end after";
});

await check("cta: an offer with no destination gets a real next step, not a dead button", () => {
  const orphan = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, { offer_type: "service", title: "Studio Session" });
  assert(/no link configured/.test(orphan), "the reader is not told what to do instead");
  assert(!/href="\/ai-jobs\/apply\//.test(orphan), "a button still points at the tracker for an offer with no destination");
  assert(/class="cta-btn cta-btn--alt" href="\/ai-jobs"/.test(orphan), "the reader is left with nothing to press");
  const direct = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, { offer_type: "product", title: "Desk", destination_url: "https://shop.example/item" });
  assert(direct.includes('href="https://shop.example/item"'), "the offer's own destination URL was ignored");
  assert(direct.includes('rel="noopener"'), "an external destination has no rel=noopener");
  return "orphan: honest message + a way on; direct URL: used with noopener";
});

// 2026-10-29. Counting the live corpus found 96 pages with no closing block and
// 21 with a block but nothing to press. Neither fails the readability audit, so
// the boot migration had never looked at them: isStalePage() only knew the old
// generic footer. These are the checks that would have caught it — and the last
// one is the one that matters most, because a predicate that disagrees with the
// template rebuilds the same page on every boot, forever.
await check("cta: a page that cannot convert is detected, and the rebuild converges", () => {
  const fresh = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, OFFER);
  assert(!needsClosingBlock(fresh), "a freshly built page was flagged — restoreFromDB would rebuild it on every boot");

  const noBlock = '<html><body><article><h1>T</h1><p>' + BODY_WORDS + '</p></article></body></html>';
  assert(needsClosingBlock(noBlock), "a page with no closing block was not detected — the 96 live pages stay broken");

  const blockNoButton = '<article><p>' + BODY_WORDS + '</p></article><div class="cta"><h2>Talk to us</h2><p>No link yet.</p></div>';
  assert(needsClosingBlock(blockNoButton), "a block with nothing to press was not detected — the 21 live pages stay broken");

  const legacy = '<article><p>' + BODY_WORDS + '</p></article><div style="text-align:center"><h2>Ready to Start?</h2></div>';
  assert(needsClosingBlock(legacy), "the old footer page was not detected");

  const noArticle = '<html><body><p>just text</p></body></html>';
  assert(!needsClosingBlock(noArticle), "a page with no <article> was flagged — there is nothing to rebuild from");

  // Convergence: whatever the template produces must satisfy the predicate, or
  // every boot rewrites the same page. The no-destination branch is the one that
  // used to produce a block with no button at all.
  const orphan = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, { offer_type: "service", title: "Studio Session" });
  assert(!needsClosingBlock(orphan), "the no-destination page does not converge — it would be rebuilt on every boot");
  const noOffer = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, null);
  assert(!needsClosingBlock(noOffer), "a page built with no offer at all does not converge");
  return "missing block, button-less block and legacy footer detected; every rebuild is stable";
});

await check("cta: the page tells the reader what to have ready", () => {
  const job = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, { id: "j1", offer_type: "job", title: "ML Engineer" });
  assert(/Before you apply/.test(job), "a job page has no readiness list above the button");
  assert(/CV saved as a PDF/.test(job), "the readiness list does not mention the CV");
  const shop = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, { id: "p1", offer_type: "product", title: "Desk" });
  assert(/Before you order/.test(shop), "a product page inherited the wrong readiness heading");
  assert(!/CV saved as a PDF/.test(shop), "the product page was given the candidate list");
  return "job: CV list; product: order list";
});

await check("cta: a stored page on the old template is detected as stale", () => {
  const legacy = '<div class="c"><article><h1>Old</h1><p>' + BODY_WORDS + '</p></article>'
    + '<div style="text-align:center"><h2>Ready to Start?</h2><p>This opportunity is available now.</p>'
    + '<a href="/ai-jobs/apply/abc">Apply Now</a></div></div>';
  assert(isStalePage(legacy), "the legacy footer was not recognised, so restoreFromDB would never migrate it");
  const fresh = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, OFFER);
  assert(!isStalePage(fresh), "a freshly built page was flagged as stale — restoreFromDB would rebuild it on every boot");
  assert(!isStalePage(""), "empty input was treated as a legacy page");
  return "legacy footer detected, new page clear";
});

await check("index rules: only files a published post owns survive a boot", () => {
  const disk = [
    "index.html",
    "chief-of-staff-awareness-1.html",
    "defense-analyst-awareness-1.html",
    "verify-writers-flow-20261022080548-awareness.html",
    "test-ai-specialist-1.html",
    "orphan-from-a-deleted-offer.html",
    "sitemap.xml",
  ];
  const keep = ["chief-of-staff-awareness-1.html", "defense-analyst-awareness-1.html"];
  const orphans = orphanPageFiles(disk, keep);
  assert(orphans.length === 3, `expected 3 orphans, got ${orphans.length}: ${orphans.join(", ")}`);
  assert(orphans.includes("verify-writers-flow-20261022080548-awareness.html"), "a verifier page would survive");
  assert(orphans.includes("orphan-from-a-deleted-offer.html"), "an orphaned article would survive");
  assert(!orphans.includes("index.html"), "the index would have been deleted");
  assert(!orphans.includes("sitemap.xml"), "a non-HTML asset would have been deleted");
  assert(!orphans.includes("chief-of-staff-awareness-1.html"), "a live page would have been deleted");
  const asSet = orphanPageFiles(disk, new Set(keep));
  assert(asSet.length === 3, "a Set and an array disagreed");
  return `${orphans.length} orphans from ${disk.length} files`;
});

await check("index rules: a stale /blog index is dropped, a clean one is kept", () => {
  assert(indexIsStale('<a href="/blog/verify-writers-flow-20261022080548-awareness.html">x</a>'), "verifier link not detected");
  assert(indexIsStale('<div><h2>Ready to Start?</h2></div>'), "legacy footer not detected");
  const clean = buildHTML({ title: "T", slug: "s", content: CLEAN_FRAGMENT }, OFFER);
  assert(!indexIsStale(clean), "a freshly built page was treated as a stale index");
  assert(!indexIsStale(""), "empty input flagged as stale");
  assert(!indexIsStale(null), "null flagged as stale");
  return "verifier link and legacy footer both caught";
});

await check("index rules: test artifacts are recognised by slug or filename", () => {
  assert(isTestArtifact("verify-writers-flow-20261022080548-awareness"), "slug not recognised");
  assert(isTestArtifact("verify-writers-flow-20261022080548-awareness.html"), "filename not recognised");
  assert(isTestArtifact("test-ai-specialist-1"), "smoke-test slug not recognised");
  assert(!isTestArtifact("chief-of-staff-awareness-1"), "a real page was flagged");
  assert(!isTestArtifact(""), "empty slug flagged");
  return "3 artifact shapes caught, real slugs clear";
});

await check("fidelity audit: a rebuilt page still carries the stored article verbatim", () => {
  // This is the check scripts/audit_page_fidelity.mjs runs against production:
  // the body inside the rebuilt page must equal sanitize(content) exactly, so a
  // template change cannot be mistaken for a rewrite of the prose.
  const article = CLEAN_FRAGMENT + "<p>" + BODY_WORDS + "</p><h2>Pay</h2><ul><li>Hourly band</li><li>Annual band</li></ul>";
  const page = buildHTML({ title: "A title the template owns", slug: "s", content: article, thumb: "/images/blog/x.png" }, OFFER);
  const body = articleBodyOf(page);
  assert(body !== null, "no <article> found in the built page");
  const bodyText = plainTextOf(body);
  const articleText = plainTextOf(sanitizeArticleHTML(article));
  assert(bodyText === articleText,
    "the page body differs from the stored article:\n  page:    " + bodyText.slice(0, 160) + "\n  article: " + articleText.slice(0, 160));
  assert(!/\bPublished\b/.test(bodyText), "the 'Published …' line was not stripped");
  assert(!/A title the template owns/.test(bodyText), "the <h1> was not stripped");
  assert(/Annual band/.test(bodyText), "the article's own list was lost");
  // A hand-edited page must be detected, or the audit would be worthless.
  const tampered = page.replace("Annual band", "Annual band, now with extra words");
  assert(plainTextOf(articleBodyOf(tampered)) !== articleText, "an edited body was not detected");
  return `${bodyText.split(/\s+/).length} words identical in and out of the template`;
});

// ---------------------------------------------------------------------------
const failed = results.filter((r) => r.status === "FAIL");
console.log("");
if (failed.length) {
  console.log(chalk.red(`${failed.length} of ${results.length} checks failed`));
  process.exitCode = 1;
} else {
  console.log(chalk.green(`All ${results.length} checks passed`));
}
