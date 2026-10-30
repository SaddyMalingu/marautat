#!/usr/bin/env node

/**
 * Did the page rebuild change the article, or only the page around it?
 *
 * Why this exists (2026-10-29): `restoreFromDB()` re-renders a page from
 * `blog_posts.content` whenever the stored `html_content` is stale, and writes
 * the result back to `html_content` only. That is a change to the page —
 * header, footer, CSS, meta description — and to nothing else. This script
 * proves it per post, read-only, so nobody has to take that on faith.
 *
 * For every published row it compares:
 *   · the article body inside the stored page (`html_content`, <article> minus
 *     the <h1>, the "Published … | N min read" line and the lead image), against
 *   · `sanitizeArticleHTML(content)` — the same function the rebuild applies.
 *
 * A match means the page's prose is exactly the stored article. A mismatch is
 * reported with both word counts so it can be inspected by hand.
 *
 * Read-only: it issues SELECTs and writes nothing, anywhere.
 *
 * Usage:
 *   node scripts/audit_page_fidelity.mjs                 # every published post
 *   node scripts/audit_page_fidelity.mjs --slug=foo-bar  # one post, full text
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the same keys the server uses).
 * Exit codes: 0 = every page matches, 1 = at least one mismatch, 2 = config error.
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { sanitizeArticleHTML, auditBlogHTML } from '../utils/articleHtml.js';
import { isStalePage, needsClosingBlock, pageNeedsRebuild } from '../utils/ctaBlock.js';
import { articleBodyOf, plainTextOf } from '../utils/blogIndex.js';

dotenv.config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them and re-run.');
  process.exit(2);
}

const onlySlugArg = process.argv.find((a) => a.startsWith('--slug='));
const onlySlug = onlySlugArg ? onlySlugArg.slice('--slug='.length) : '';

const words = (s) => String(s || '').split(/\s+/).filter(Boolean).length;

const sb = createClient(url, key);

/** The article body as stored inside a rendered page. */

async function main() {
  let query = sb
    .from('blog_posts')
    .select('slug, title, status, content, html_content, opportunity_id')
    .eq('status', 'published')
    .order('slug', { ascending: true });
  if (onlySlug) query = sb
    .from('blog_posts')
    .select('slug, title, status, content, html_content, opportunity_id')
    .eq('slug', onlySlug);

  const { data, error } = await query;
  if (error) { console.error('Query failed:', error.message); process.exit(2); }
  const rows = data || [];
  if (!rows.length) { console.log('No published posts found.'); return; }

  const match = [];
  const differ = [];
  const noBody = [];
  const stale = [];
  const noBlock = [];
  const willRebuild = [];
  const stranded = [];

  for (const row of rows) {
    const stored = articleBodyOf(row.html_content);
    if (!stored) { noBody.push(row); continue; }
    const expected = sanitizeArticleHTML(row.content || '');
    const a = plainTextOf(stored);
    const b = plainTextOf(expected);
    if (a === b) match.push(row);
    else differ.push({ row, storedWords: words(a), expectedWords: words(b), stored: a, expected: b });
    if (isStalePage(row.html_content)) stale.push(row);
    // A page that persuades and then stops. Counted separately from the old
    // footer because it is a different failure: nothing to press at all.
    if (needsClosingBlock(row.html_content)) noBlock.push(row);
    // The number the operator actually wants: how many pages will the *next*
    // deploy rewrite? Computed by the same function the boot restore calls, so it
    // cannot disagree with the boot log. A row that needs rebuilding but has no
    // stored `content` is stranded: the restore will look at it and move on.
    const verdict = pageNeedsRebuild({ html: row.html_content, auditOk: auditBlogHTML(row.html_content).ok });
    if (verdict.rebuild) {
      willRebuild.push({ row, reason: verdict.reason });
      if (!row.content) stranded.push(row);
    }
  }

  console.log(`Checked ${rows.length} published post(s).\n`);
  console.log(`  prose identical to stored content ......... ${match.length}`);
  console.log(`  prose differs .............................. ${differ.length}`);
  console.log(`  no <article> body in stored page ........... ${noBody.length}`);
  console.log(`  still on the pre-2026-10-29 footer ......... ${stale.length}`);
  console.log(`  no closing block / nothing to press ........ ${noBlock.length}`);
  console.log(`  the next boot would rebuild ............... ${willRebuild.length}   (same rule the restore runs)`);
  if (stranded.length) {
    console.log(`  ...of those, no stored content to rebuild .. ${stranded.length}   (stranded — the restore skips them)`);
  }

  if (differ.length) {
    console.log('\nDIFFERENCES — inspect these by hand:');
    for (const d of differ) {
      console.log(`\n  ${d.row.slug}`);
      console.log(`    stored page body: ${d.storedWords} words | stored content: ${d.expectedWords} words`);
      if (onlySlug) {
        console.log('    --- page body ---');
        console.log('    ' + d.stored.slice(0, 1200));
        console.log('    --- stored content ---');
        console.log('    ' + d.expected.slice(0, 1200));
      } else {
        console.log(`    page body starts: ${d.stored.slice(0, 120)}`);
        console.log(`    content starts:   ${d.expected.slice(0, 120)}`);
      }
    }
  }

  if (noBody.length) {
    console.log('\nNO ARTICLE BODY (the stored page has no <article> element):');
    for (const r of noBody) console.log('  ' + r.slug);
  }

  if (stale.length) {
    console.log('\nSTILL ON THE OLD FOOTER (the boot rebuild has not processed these yet):');
    for (const r of stale.slice(0, 40)) console.log('  ' + r.slug);
    if (stale.length > 40) console.log(`  … and ${stale.length - 40} more`);
  }

  if (stranded.length) {
    console.log('\nNEEDS REBUILDING BUT HAS NO STORED BODY (fix the content, not the page):');
    for (const r of stranded) console.log('  ' + r.slug);
  }

  console.log('\nRead-only audit: no rows or files were modified.');
  process.exitCode = differ.length || noBody.length ? 1 : 0;
}

main().catch((e) => {
  console.error('Audit failed:', e.message);
  process.exit(1);
});
