#!/usr/bin/env node

/**
 * How much of the live blog can actually convert, and how much of it can be
 * measured? (2026-10-29)
 *
 * The question came from a log line: a reader pressed a button at 19:57:20 and
 * got `404 {"error":"No destination configured for this offer"}`. Counting the
 * corpus by hand answered three things at once, none of which was visible from
 * the database alone because they depend on what each stored page actually
 * renders:
 *
 *   - pages whose button goes straight to the provider  → converts, but the click
 *     is answered by someone else, so this server cannot count it
 *   - pages whose button goes through /ai-jobs/apply/<id> → measurable here
 *   - pages with no button at all                        → cannot convert however
 *     good the writing is
 *
 * Read-only: fetches public pages and reports. Nothing is written anywhere.
 *
 *   node scripts/audit_cta_coverage.mjs
 *   SITE_URL=https://staging.example.com node scripts/audit_cta_coverage.mjs --slow
 */

const BASE = (process.env.SITE_URL || 'https://alphadome.onrender.com').replace(/\/+$/, '');
const CONCURRENCY = process.argv.includes('--slow') ? 3 : 6;

async function pool(list, size, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
    while (i < list.length) {
      const n = i++;
      out[n] = await fn(list[n]);
    }
  }));
  return out;
}

async function main() {
  const idx = await fetch(BASE + '/blog');
  const html = await idx.text();
  const slugs = [...new Set((html.match(/href="\/blog\/([a-z0-9-]+)\.html"/g) || [])
    .map((h) => h.match(/\/blog\/([a-z0-9-]+)\.html/)[1]))];

  console.log(`Site: ${BASE}`);
  console.log(`Blog index: ${idx.status}, ${slugs.length} article links\n`);
  if (!slugs.length) {
    console.log('Nothing to measure: the index lists no articles.');
    process.exitCode = 1;
    return;
  }

  const direct = [];
  const tracked = [];
  const noButton = [];
  const noCtaBlock = [];
  const failed = [];
  const ids = new Set();

  await pool(slugs, CONCURRENCY, async (slug) => {
    let body;
    try {
      const r = await fetch(`${BASE}/blog/${slug}.html`);
      if (r.status !== 200) { failed.push(`${slug} (${r.status})`); return; }
      body = await r.text();
    } catch (e) {
      failed.push(`${slug} (${e.message})`);
      return;
    }
    const hrefs = [...body.matchAll(/class="cta-btn" href="([^"]+)"/g)].map((m) => m[1]);
    if (!hrefs.length) {
      noButton.push(slug);
      if (!/class="cta/.test(body)) noCtaBlock.push(slug);
      return;
    }
    const apply = hrefs.filter((h) => h.startsWith('/ai-jobs/apply/'));
    if (apply.length) {
      tracked.push(slug);
      apply.forEach((h) => ids.add(h.split('/').pop()));
    } else {
      direct.push(slug);
    }
  });

  const statuses = new Map();
  await pool([...ids], CONCURRENCY, async (id) => {
    try {
      const r = await fetch(`${BASE}/ai-jobs/apply/${id}`, { redirect: 'manual' });
      statuses.set(id, r.status);
    } catch (e) {
      statuses.set(id, 'ERR');
    }
  });
  const dead = [...statuses.entries()].filter(([, s]) => s !== 302);

  const pct = (n) => `${n} (${Math.round((n / slugs.length) * 100)}%)`;
  console.log(`Button goes straight to the provider .... ${pct(direct.length)}`);
  console.log(`Button goes through this site ........... ${pct(tracked.length)}   measurable`);
  console.log(`No button at all ....................... ${pct(noButton.length)}   cannot convert`);
  console.log(`  ...of those, no CTA block at all ..... ${pct(noCtaBlock.length)}   template never added one`);
  console.log(`Pages that did not load ................ ${pct(failed.length)}`);
  if (failed.length) console.log('  ' + failed.slice(0, 10).join(', '));
  console.log('');
  if (ids.size) {
    console.log(`Distinct offers behind a tracked button . ${ids.size}`);
    console.log(`  redirect cleanly (302) ............... ${ids.size - dead.length}`);
    console.log(`  do not redirect ...................... ${dead.length}`);
    for (const [id, s] of dead.slice(0, 10)) console.log(`    ${id} -> ${s}`);
  }
  console.log('');
  console.log('A page in the middle row is the only kind whose clicks this server can');
  console.log('count. A page in the third row persuades and then stops.');
}

main().catch((e) => {
  console.error('Audit failed:', e.message);
  process.exit(1);
});
