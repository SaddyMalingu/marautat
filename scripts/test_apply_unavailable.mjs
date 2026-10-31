// Regression test for the dead CTA (2026-10-29).
//
// At 19:57:20 a real reader pressed a button and got
//   404 {"error":"No destination configured for this offer"}
// — raw JSON on a page they had just read to the end. /ai-jobs/apply/<id>
// answered an unconfigured offer that way, and the click was not recorded
// either, so the leak was invisible in the one place that should show it.
//
// Now: the click is counted (with its own type), the reader gets a page with a
// way back, and only a genuinely missing offer still returns JSON — because API
// clients depend on that.
//
//   node scripts/test_apply_unavailable.mjs
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const src = fs.readFileSync('routes/aiJobs.js', 'utf8');
// The handler is shared by /ai-jobs/apply/:id and /go/:id, so this slice covers the
// one implementation both paths run.
const route = src.slice(src.indexOf('export async function handleOfferClick'), src.indexOf('// POST /api/events'));

// ---- 1. The dead end is gone ---------------------------------------------
ok('an unconfigured offer no longer answers with JSON',
  !/No destination configured for this offer'/.test(route));
ok('an invalid destination no longer answers with 400 JSON',
  !/Invalid destination URL/.test(route));
ok('the reader is sent a page instead', /offerUnavailablePage\(opportunity\.title \|\| opportunity\.slug, back\)/.test(route));
ok('that page is sent as html', /res\.status\(200\)\.type\('html'\)/.test(route));
ok('a missing offer still returns JSON, for the API clients that depend on it',
  /res\.status\(404\)\.json\(\{ error: 'Opportunity not found' \}\)/.test(route));

// ---- 2. The click is counted, and told apart from a working one ----------
ok('a click with no destination is recorded', /trackClick\(sourcePath, dest \? 'apply_bad_destination' : 'apply_no_destination', req\)/.test(route));
ok('a click on an offer that no longer exists is recorded too',
  /trackClick\(missingFrom, 'apply_missing', req\)/.test(route));
ok('the recorded path falls back per route, not to one hard-coded path',
  /pagePathFromReferrer\(req, fallbackPath\)/.test(route));
ok('the offer funnel records it as an unavailable apply',
  /eventType: 'apply_click'[\s\S]{0,220}unavailable: true/.test(route));
ok('the click is recorded before the reader is redirected',
  route.indexOf("trackClick(sourcePath, 'apply', req)") > -1 &&
  route.indexOf("trackClick(sourcePath, 'apply', req)") < route.indexOf('res.redirect(302, dest)'));
ok('a working destination still redirects', /res\.redirect\(302, dest\)/.test(route));
ok('the destination is still validated before it is trusted',
  /isValidReferralUrl\(dest\)/.test(route) && /u\.protocol === 'http:' \|\| u\.protocol === 'https:'/.test(route));
ok('a broken destination cannot become a redirect',
  /usable = wellFormed && trusted;/.test(route));

// ---- 3. The page a reader lands on --------------------------------------
const { offerUnavailablePage } = await import(new URL('../routes/aiJobs.js', import.meta.url).href);

const page = offerUnavailablePage('Senior M&A Advisor', '/blog/investment-banking-m-a-expert-awareness-1');
ok('the page is html', /^<!DOCTYPE html>/.test(page));
ok('it names the offer', page.includes('Senior M&amp;A Advisor') || page.includes('Senior M&A Advisor'));
ok('it offers a way back', page.includes('href="/blog/investment-banking-m-a-expert-awareness-1"'));
ok('it points at the other opportunities', page.includes('href="/ai-jobs"'));
ok('it is not indexable', /name="robots" content="noindex"/.test(page));
ok('it fits a phone', /width=device-width/.test(page));

// Anything a tenant or an offer title controls is untrusted input here.
const nasty = offerUnavailablePage('<script>alert(1)</script>', 'javascript:alert(1)');
ok('a title cannot inject markup', !/<script>alert\(1\)<\/script>/.test(nasty) && nasty.includes('&lt;script&gt;'));
ok('a hostile "back" cannot become a link', !nasty.includes('javascript:alert') && nasty.includes('href="/ai-jobs"'));
ok('a protocol-relative back link is refused', !offerUnavailablePage('x', '//evil.example/path').includes('//evil.example'));
ok('an empty back link falls through to /ai-jobs', offerUnavailablePage('x', '').includes('href="/ai-jobs"'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
