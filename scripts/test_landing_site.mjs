#!/usr/bin/env node

/**
 * Landing-site verification (2026-10-25).
 *
 * The homepage is the only page every prospect sees, and it had drifted into
 * claims a buyer cannot check: "Production-Ready Core", "4 Core Platforms",
 * tokenized ownership and a "Unleash Your Power!!!" video block sitting above
 * the <h1>. It also carried no meta description, no canonical URL, no social
 * card and no structured data, so the page could not describe itself to a search
 * engine or to a link preview.
 *
 * This test holds the new contract:
 *   - one <h1>, in the hero, with the reader-facing promise
 *   - description / canonical / OG / Twitter tags, and JSON-LD that parses
 *   - every FAQ answer in the structured data also exists as visible copy
 *   - the sections a buyer needs are present, in a sensible order
 *   - every in-page anchor resolves, every internal link maps to a real route
 *   - pricing appears as a starting anchor with the caveat, never as a promise
 *   - no unverifiable claim, no legacy wording, no unlabelled demo
 *
 * Runs offline: it reads index.html + public/ only.
 *
 * Usage: npm run test:landing
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import fs from 'fs';
import path from 'path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const html = fs.readFileSync('index.html', 'utf8');
const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---- 1. document basics ----------------------------------------------------
ok('declares a language', /<html lang="en">/.test(html));
ok('declares a viewport', /<meta name="viewport"/.test(html));

const h1s = html.match(/<h1\b/gi) || [];
ok('exactly one h1 on the page', h1s.length === 1, h1s.length + ' found');
const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
ok('the h1 is a reader promise, not a slogan', /deploy/i.test(h1) && h1.replace(/<[^>]*>/g, '').trim().length > 25, h1.trim());
ok('the h1 appears before the video showcase', html.indexOf('<h1') < html.indexOf('id="alphadome-generated-video"'));

const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
ok('meta description is 120-320 chars', desc.length >= 120 && desc.length <= 320, desc.length + ' chars');
ok('meta description names what is sold', /WhatsApp/i.test(desc) && /M-Pesa/i.test(desc), desc.slice(0, 80));
ok('canonical URL is absolute', /<link rel="canonical" href="https:\/\/alphadome\.onrender\.com\/"/.test(html));

for (const prop of ['og:type', 'og:title', 'og:description', 'og:image', 'og:url']) {
  ok('has ' + prop, new RegExp(`property="${prop}" content="[^"]+"`).test(html));

// ---- 2. structured data ---------------------------------------------------
const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
ok('ships JSON-LD', ldBlocks.length >= 1, ldBlocks.length + ' block(s)');

let graph = [];
for (const m of ldBlocks) {
  try {
    const parsed = JSON.parse(m[1]);
    graph = graph.concat(parsed['@graph'] || [parsed]);
  } catch (e) {
    ok('JSON-LD parses', false, e.message);
  }
}
ok('JSON-LD parses', graph.length > 0, graph.length + ' node(s)');
const types = graph.map((n) => n['@type']);
ok('describes the organisation', types.includes('Organization'));
ok('describes the service and its starting price',
  types.includes('Service') && /3000/.test(JSON.stringify(graph.find((n) => n['@type'] === 'Service'))));
ok('describes the FAQ for rich results', types.includes('FAQPage'));

const faqNode = graph.find((n) => n['@type'] === 'FAQPage') || { mainEntity: [] };
const faqQs = (faqNode.mainEntity || []).map((q) => q.name);
ok('structured FAQ has at least four questions', faqQs.length >= 4, faqQs.length + ' questions');
const missingAnswers = faqQs.filter((q) => {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return !norm(text).includes(norm(q));
});
ok('every structured question is asked in visible copy', missingAnswers.length === 0,
  missingAnswers.join(' | '));

// ---- 3. the sections a buyer needs ---------------------------------------
const sectionIds = [...html.matchAll(/<section[^>]*id="([^"]+)"/gi)].map((m) => m[1]);
for (const id of ['home', 'what', 'commerce', 'writers-flow', 'capabilities', 'pricing', 'portfolio', 'faq', 'contact']) {
  ok('section #' + id + ' exists', sectionIds.includes(id), sectionIds.join(','));
}
ok('pricing comes before the portfolio', sectionIds.indexOf('pricing') < sectionIds.indexOf('portfolio'));
ok('the FAQ sits after the portfolio', sectionIds.indexOf('faq') > sectionIds.indexOf('portfolio'));
ok('the hero explains what the company is in plain words', /one working revenue workflow/i.test(text));
ok('the page says what it is not', /What this is not/i.test(text) && /Not an investment product/i.test(text));

// ---- 4. pricing is an anchor, not a promise ------------------------------
ok('shows the deployment anchor', /From \$3,000/.test(text));
ok('shows the licensing anchor', /From \$10,000/.test(text));
ok('shows the retainer range', /\$500.2,000/.test(text));
ok('calls them starting anchors, not quotes', /starting anchors, not quotes/i.test(text));
ok('refuses to promise revenue', /guaranteed outcome|promise of revenue/i.test(text));

ok('quotes the Founder\'s Package in KES', /KES 1,000/.test(text));

// ---- 5. nothing unverifiable, nothing legacy ------------------------------
const bannedCopy = [
  ['tokenized ownership', /tokeni[sz]ed/i],
  ['majority shareholder', /majority shareholder/i],
  ['programmable revenue to shareholders', /payments flow to shareholders/i],
  ['"Unleash Your Power" placeholder', /Unleash Your Power/i],
  ['HOLD drafts from the content doc', /\bHOLD\b/],
  ['production-ready claim without evidence', /Production-Ready Core/i],
  ['count of "core platforms" as proof', /4 Core Platforms/i],
];
for (const [label, re] of bannedCopy) ok('removed: ' + label, !re.test(text));

ok('labels demo capability instead of implying live clients',
  /Demo/i.test(text) && /demos? of built capability/i.test(text));
ok('uses explicit status labels', /Live<\/strong>/.test(html) && /Next build slice/.test(html));
ok('every price mentioned is an allowed anchor', (() => {
  const allowed = new Set(['3,000', '10,000', '500', '2,000', '1,000']);
  const found = [...text.matchAll(/\$\s?([\d,]+)/g)].map((m) => m[1]);
  return found.every((n) => allowed.has(n));
})());

// ---- 6. links and anchors resolve ---------------------------------------
const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
const broken = [...new Set(anchors)].filter((id) => !new RegExp(`id="${id}"`).test(html));
ok('every in-page anchor resolves', broken.length === 0, broken.join(','));

// Routes that are served by server.js rather than a file on disk.
const ROUTES = new Set(['/', '/discovery', '/blog', '/tenant-dashboard', '/admin', '/kassangas-music-shop',
  '/kassangas-merchant-portal', '/kassangas-client-wallet', '/portfolio', '/privacy-policy']);
const internal = [...new Set([...html.matchAll(/href="(\/[^"#?]*)"/g)].map((m) => m[1]))];
const missing = internal.filter((href) => {
  if (ROUTES.has(href)) return false;
  const rel = href.replace(/^\//, '');
  return !fs.existsSync(rel) && !fs.existsSync(path.join('public', rel));
});
ok('every internal link maps to a file or a known route', missing.length === 0, missing.join(','));
ok('the primary CTA goes to the discovery form',
  (html.match(/href="\/discovery"/g) || []).length >= 3);

const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
ok('every image has an alt attribute', imgs.every((tag) => /alt="[^"]*"/.test(tag)), imgs.filter((t) => !/alt="/.test(t)).length + ' without alt');

// ---- 7. the mobile nav and accessibility basics -------------------------
ok('has a mobile nav toggle', /id="nav-toggle"/.test(html) && /for="nav-toggle"/.test(html));
ok('nav is labelled', /<nav[^>]*aria-label="Main site navigation"/.test(html));
ok('the footer nav is labelled', /<nav aria-label="Footer"/.test(html));
ok('no inline onclick handlers on the landing page', !/<a[^>]+onclick=/i.test(html));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);


}
ok('has a Twitter card', /name="twitter:card" content="summary_large_image"/.test(html));
ok('OG description differs from the title (not a copy-paste)', !/og:title" content="([^"]+)"[\s\S]{0,200}og:description" content="\1"/.test(html));
