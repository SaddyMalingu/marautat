#!/usr/bin/env node

/**
 * Post-deploy check for the public blog.
 *
 * Why this exists (2026-10-29): the blog is generated at boot from
 * `blog_posts`, so a deploy can silently (a) leave the old page footer in place,
 * (b) keep advertising the verifier's own pages on /blog, or (c) delete a page a
 * visitor can still reach. Each of those is invisible from the build log. This
 * checks the site people actually see.
 *
 * Read-only: fetches public URLs and reports. Exit 0 = every check passed.
 *
 * Usage:
 *   node scripts/verify_blog_deploy.mjs
 *   SITE_URL=https://staging.example.com node scripts/verify_blog_deploy.mjs
 */

const BASE = (process.env.SITE_URL || 'https://alphadome.onrender.com').replace(/\/+$/, '');
const SAMPLES = 14;

async function get(path) {
  const r = await fetch(BASE + path, { redirect: 'follow' });
  return { status: r.status, text: await r.text() };
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ ok, line: (ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : '') });
};

async function main() {
  const idx = await get('/blog');
  const links = [...new Set((idx.text.match(/href="\/blog\/([a-z0-9-]+)\.html"/g) || [])
    .map((h) => h.match(/\/blog\/([a-z0-9-]+)\.html/)[1]))];
  const artifacts = links.filter((s) => /^(?:verify-writers-flow-|test-ai-specialist-)/.test(s));

  console.log(`Site: ${BASE}`);
  console.log(`Index: ${idx.status}, ${idx.text.length} bytes, ${links.length} article links\n`);

  check('index responds', idx.status === 200, 'status ' + idx.status);
  check('index advertises no verifier page', artifacts.length === 0, artifacts.length + ' found');
  check('index still lists the corpus', links.length >= 250, links.length + ' links');

  // Spread the sample across the list so one broken region cannot hide.
  const sample = [];
  const step = Math.max(1, Math.floor(links.length / SAMPLES));
  for (let i = 0; i < links.length && sample.length < SAMPLES; i += step) sample.push(links[i]);

  const broken = [];
  const legacy = [];
  for (const slug of sample) {
    const p = await get('/blog/' + slug + '.html');
    if (p.status !== 200 || !/<article>/.test(p.text) || p.text.length < 1200) {
      broken.push(`${slug} (${p.status}, ${p.text.length}b)`);
      continue;
    }
    if (/Ready to Start\?|This (?:opportunity|offer) is available now\./.test(p.text)) legacy.push(slug);
  }
  check('every sampled article still serves', broken.length === 0, broken.join('; ') || `${sample.length} pages ok`);
  check('every sampled page is on the current footer', legacy.length === 0, legacy.join('; ') || `${sample.length} pages ok`);

  const first = sample[0] || links[0];
  if (first) {
    const p = await get('/blog/' + first + '.html');
    const buttons = (p.text.match(/class="cta-btn"/g) || []).length;
    check('closing block names the offer', /class="cta"/.test(p.text), first);
    check('two buttons, one above the article', buttons === 2, buttons + ' found');
  }

  const gone = await get('/blog/verify-writers-flow-20261022080548-awareness.html');
  check('verifier pages are no longer public', gone.status === 404, 'status ' + gone.status);

  console.log(results.map((r) => r.line).join('\n'));
  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(failed ? `${failed} of ${results.length} checks failed` : `All ${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error('Verification failed:', e.message);
  process.exit(1);
});
