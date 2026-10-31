#!/usr/bin/env node

/**
 * The tracked hop in front of every CTA (2026-10-31).
 *
 * On 2026-10-31, 378 of the 434 published pages linked the provider directly.
 * Those readers converted and this server learned nothing: no page_path, no CTR,
 * no way to say which article earned an enquiry. `/go/:id` is the fix — the click
 * is recorded, then the reader is 302'd to the offer's own URL.
 *
 * Two properties have to hold, and both are easy to break silently:
 *
 *   1. The redirect target is delivered **unchanged**. No wrapper URL, no added
 *      query string, no rewritten affiliate parameter. If this ever changes, the
 *      partner stops crediting the click and the tenant's enquiries disappear —
 *      while every dashboard still shows traffic.
 *   2. The click is recorded **before** the redirect, against the page that
 *      earned it, so /tenant/writers-flow/analytics has something to count.
 *
 * This suite reads the real handler and the real template. It runs in-process.
 *
 * Usage: npm run test:go-redirect
 */
import fs from 'fs';
import { ctaTarget, usesUnmeteredLink, pageNeedsRebuild } from '../utils/ctaBlock.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const routeSrc = fs.readFileSync('routes/aiJobs.js', 'utf8');
const serverSrc = fs.readFileSync('server.js', 'utf8');
const handler = routeSrc.slice(
  routeSrc.indexOf('export async function handleOfferClick'),
  routeSrc.indexOf('// POST /api/events'),
);

// ---- 1. One implementation, two paths --------------------------------------
ok('/go/:id is mounted at the root', /app\.get\('\/go\/:id'/.test(serverSrc));
ok('/go/:id runs the same handler as /ai-jobs/apply/:id',
  /app\.get\('\/go\/:id',[^;]*handleOfferClick\(req, res, \{ fallbackPath: '\/go', humanFacing: true \}\)/.test(serverSrc));
ok('/ai-jobs/apply/:id still works for every page already published',
  /router\.get\('\/apply\/:id', \(req, res\) => handleOfferClick\(req, res, \{ fallbackPath: '\/ai-jobs\/apply' \}\)/.test(routeSrc));
ok('the redirect logic exists once, not once per path',
  (routeSrc.match(/res\.redirect\(302, dest\)/g) || []).length === 1);

// ---- 2. The click is counted, before the reader leaves --------------------
ok('/go is human-facing, so a dead offer cannot answer JSON',
  /const humanFacing = options\.humanFacing === true;/.test(handler));
ok('a missing offer sends a person to a page, not a JSON body',
  /if \(humanFacing\)[\s\S]{0,200}offerUnavailablePage\('This opportunity'/.test(handler));
ok('the API contract on /ai-jobs/apply/:id is untouched',
  /res\.status\(404\)\.json\(\{ error: 'Opportunity not found' \}\)/.test(handler));
ok('the click is recorded before the redirect',
  handler.indexOf("trackClick(sourcePath, 'apply', req)") > -1 &&
  handler.indexOf("trackClick(sourcePath, 'apply', req)") < handler.indexOf('res.redirect(302, dest)'));
ok('the click is attributed to the page that earned it',
  /pagePathFromReferrer\(req, fallbackPath\)/.test(handler));
ok('an offer with no usable destination still records the click',
  /trackClick\(sourcePath, dest \? 'apply_bad_destination' : 'apply_no_destination', req\)/.test(handler));

// ---- 3. The destination is delivered unchanged ----------------------------
// The redirect must be the resolved URL itself: nothing concatenated on, nothing
// escaped, nothing re-encoded.
ok('the redirect hands over the resolved destination as-is',
  /res\.redirect\(302, dest\);/.test(handler));
ok('no parameter is appended to the destination on the way out',
  !/res\.redirect\(302,[^)]*(?:\?|&|encodeURIComponent|buildUrl)/.test(handler));
ok('the destination is still validated before it becomes a redirect',
  /isValidReferralUrl\(dest\)/.test(handler) && /usable = wellFormed && trusted;/.test(handler));

// ---- 4. What the CTA block writes ----------------------------------------
ok('an offer with an id routes through /go',
  ctaTarget({ id: 'abc-123', destination_url: 'https://jobs.example/x?ref=1' }) === '/go/abc-123');
ok('the same offer keeps its id-based link whatever its destination is',
  ctaTarget({ id: 'abc-123', referral_url: 'https://t.mercor.com/r/9' }) === '/go/abc-123' &&
  ctaTarget({ id: 'abc-123', application_url: 'https://ats.example/apply' }) === '/go/abc-123');
ok('an offer with no id keeps its raw URL (there is nothing to count it against)',
  ctaTarget({ destination_url: 'https://shop.example/item' }) === 'https://shop.example/item');
ok('a non-http destination is never turned into a link',
  ctaTarget({ id: '', destination_url: 'javascript:alert(1)' }) === '');
ok('no offer at all yields no target', ctaTarget(null) === '' && ctaTarget({}) === '');

// ---- 5. The pages that predate /go are rebuilt, and stop after that ------
const stored = '<article><p>' + 'word '.repeat(60) + '</p></article>'
  + '<div class="cta"><h2>Apply for Desk</h2><a class="cta-btn" href="https://shop.example/item">Order now</a></div>';
ok('a stored page whose button leaves for the provider is detected',
  usesUnmeteredLink(stored));
ok('…and the boot restore rebuilds it, for a reason the log can print',
  pageNeedsRebuild({ html: stored, auditOk: true }).reason === 'unmetered provider link');
const rebuilt = '<article><p>' + 'word '.repeat(60) + '</p></article>'
  + '<div class="cta"><h2>Apply for Desk</h2><a class="cta-btn" href="/go/abc-123">Order now</a></div>';
ok('a rebuilt page is not flagged again — the migration converges',
  !usesUnmeteredLink(rebuilt) && pageNeedsRebuild({ html: rebuilt, auditOk: true }).rebuild === false);
ok('an external link inside the article body does not trigger a rebuild',
  !usesUnmeteredLink('<article><p>See https://source.example/study</p><a href="https://source.example/x">source</a></article>'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
