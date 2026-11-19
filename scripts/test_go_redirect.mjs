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
import { ctaTarget, ctaBlock, usesUnmeteredLink, pageNeedsRebuild, hasOfferLine, offerShowsKit } from '../utils/ctaBlock.js';
import { offerMeta } from '../utils/aiJobsService.js';

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
// Soft delete (2026-11-01): a click on a deleted offer must not reach the tenant's
// affiliate URL, and deleting must not destroy the row the referral link lives on.
ok('a soft-deleted offer cannot redirect a click', /\.is\('deleted_at', null\)/.test(handler));
ok('deleting an offer stamps deleted_at instead of removing the row',
  /app\.delete\('\/tenant\/blogger\/offers\/:id'[\s\S]{0,700}deleted_at/.test(serverSrc));
ok('the old hard delete is gone',
  !/app\.delete\('\/tenant\/blogger\/offers\/:id'[\s\S]{0,700}\.delete\(\)/.test(serverSrc));
ok('a deleted offer can be restored', /app\.post\('\/tenant\/blogger\/offers\/:id\/restore'/.test(serverSrc));
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

// ---- 4b. The CTA earns: a coded URL outranks a bare one (2026-11-18) ------
// Live symptom: a minted pair link showed its referral code in the tenant portal, and the article generated for the same
// offer sent every reader to `jobs.micro1.ai/post/<id>` — the plain posting — because the destination resolved as
// `destination_url || referral_url`. The pages converted and the tenant earned nothing, which is the whole business.
const coded = 'https://jobs.micro1.ai/post/c8cdec0c?referralCode=98fb722e';
const bare = 'https://jobs.micro1.ai/post/c8cdec0c';
const paired = 'https://refer.micro1.ai/referral/jobs?referralCode=98fb722e&linkId=a1f48ab6';
const earning = { id: 'o1', title: 'STEM Expert', offer_type: 'job', destination_url: bare, referral_url: coded };

ok('the redirect resolves the coded URL, not the plain posting', offerMeta(earning).destination === coded);
ok('a pair link wins when that is what was minted',
  offerMeta({ ...earning, referral_url: paired }).destination === paired);
ok('an offer with no code at all still resolves its destination',
  offerMeta({ id: 'o2', destination_url: bare }).destination === bare);
ok('a coded destination is preferred to a coded referral only when the referral has none',
  offerMeta({ id: 'o3', destination_url: coded, referral_url: 'https://jobs.micro1.ai/post/c8cdec0c' }).destination === coded);
ok('the tracked hop is still what the CTA carries', ctaTarget(earning) === '/go/o1');
ok('and with no id the CTA is the coded URL itself',
  ctaTarget({ referral_url: coded, destination_url: bare }) === coded);
ok('the closing block points at the tracked hop, which now earns',
  /href="\/go\/o1"/.test(ctaBlock(earning)));
ok('and an id-less offer carries the code inline rather than the bare posting',
  /referralCode=98fb722e/.test(ctaBlock({ referral_url: coded, destination_url: bare })));

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

// ---- 6. The application pack under the button (2026-11-19) ----------------
// Its whole reason for existing: 930 Apply clicks left for a marketplace and this
// side earned nothing at the moment of intent. The rule it must not break is that
// the Apply button still goes exactly where it went before, with nothing in front
// of it — no interstitial, no countdown, no redirect.
{
  const job = { id: 'o1', slug: 'stem-expert', title: 'STEM Expert', offer_type: 'job', referral_url: coded };
  const block = ctaBlock(job);

  ok('a job page carries the pack line', hasOfferLine(block));
  ok('the pack link is tracked, so the click is countable', /href="\/go\/kit\?from=stem-expert"/.test(block));
  ok('the pack is named with its price', /AI Work Application Kit/.test(block) && /KES 1,500/.test(block));
  ok('the Apply button is still the tracked hop and comes first',
    block.indexOf('class="cta-btn"') > -1 && block.indexOf('class="cta-btn"') < block.indexOf('cta-offer'));
  ok('the Apply button was not rewritten', /class="cta-btn" href="\/go\/o1"/.test(block));
  ok('nothing auto-redirects: there is no meta refresh or script',
    !/http-equiv="refresh"|<script/i.test(block));

  ok('a product page does not carry the pack', !hasOfferLine(ctaBlock({ id: 'p1', title: 'Desk', offer_type: 'product' })));
  ok('a course page does not carry the pack', !hasOfferLine(ctaBlock({ id: 'c1', title: 'Course', offer_type: 'course' })));
  ok('the kill switch removes it', !hasOfferLine(ctaBlock(job, { env: { CTA_OFFER_OFF: '1' } })));
  ok('the kill switch accepts true', !hasOfferLine(ctaBlock(job, { env: { CTA_OFFER_OFF: 'true' } })));
  ok('a tenant outside the allowlist is not sold our pack',
    !offerShowsKit(job, { tenantSlug: 'someone-elses-shop' }));
  ok('the platform tenant is allowed', offerShowsKit(job, { tenantSlug: 'malingu-ventures' }));
  ok('a configured product slug is used instead', /\/go\/kit\?from=stem-expert/.test(
    ctaBlock(job, { env: { CTA_OFFER_SLUG: 'another-kit' } })));

  // The predicate and the template have to agree, or the boot rewrites these pages
  // on every deploy. `rebuiltPage` is what the template now produces.
  const rebuiltPage = '<article><p>' + 'word '.repeat(60) + '</p></article>' + block;
  ok('a page without the pack line is rebuilt, for a reason the log prints',
    pageNeedsRebuild({ html: rebuilt, auditOk: true, expectOffer: true }).reason === 'no application pack offer');
  ok('…and stops being rebuilt once it carries one',
    pageNeedsRebuild({ html: rebuiltPage, auditOk: true, expectOffer: true }).rebuild === false);
  ok('a product page is never flagged for the pack', pageNeedsRebuild({
    html: '<article><p>' + 'word '.repeat(60) + '</p></article>'
      + ctaBlock({ id: 'p1', title: 'Desk', offer_type: 'product' }),
    auditOk: true,
    expectOffer: false
  }).rebuild === false);
}

// ---- 7. The kit route is mounted where it can actually be reached ----------
{
  const { readFileSync } = await import('fs');
  const routesSrc = readFileSync('routes/aiJobs.js', 'utf8');
  const kitHandler = routesSrc.slice(
    routesSrc.indexOf('export async function handleKitOfferClick'),
    routesSrc.indexOf('// GET /go/:id and GET /ai-jobs/apply/:id')
  );
  ok('the kit handler records its own click type',
    kitHandler.includes("trackClick(from, 'kit_offer', req)"));
  ok('a stripped Referer still attributes the click, through the slug the link carries',
    kitHandler.includes('req.query.from') && kitHandler.includes("'/blog/' + safeSlug"));
  ok('that slug is validated, not trusted into a page path',
    routesSrc.includes('[a-z0-9][a-z0-9-]{0,79}') && routesSrc.includes('.test(slug)'));
  ok('a switched-off offer sends the reader to the jobs board, not to a dead link',
    /if \(!cfg\.enabled\) return res\.redirect\(302, '\/ai-jobs'\)/.test(routesSrc));
  ok('the kit route is mounted before /go/:id, or "kit" is read as an offer id',
    serverSrc.indexOf("app.get('/go/kit'") > -1
    && serverSrc.indexOf("app.get('/go/kit'") < serverSrc.indexOf("app.get('/go/:id'"));
}

// The offer page must keep the job's structure. Descriptions were a single <p>, so a
// 2,000-character job rendered as one run-on paragraph and read as "no detail" — which
// is exactly how a tenant reported it.
{
  const { renderOfferPage } = await import('../utils/aiJobsViewsOpp.js');
  const demo = renderOfferPage({
    id: 'x', title: 'Demo Role', slug: 'demo', offer_type: 'job', compensation_max: 100,
    description: 'About Turing:\nTuring advances AI systems.\nRequired Qualifications\nFive years of experience.'
  }, {});
  ok('a multi-line description renders as separate lines', (demo.match(/<br>/g) || []).length >= 3);
  ok('section headings are emphasised', demo.includes('<strong>About Turing:</strong>'));
  ok('the description is escaped, not injected raw',
    renderOfferPage({ id: 'y', title: 'T', slug: 't', offer_type: 'job', description: '<script>alert(1)</script>' }, {})
      .includes('&lt;script&gt;'));
  const summaryOnly = renderOfferPage({ id: 'z', title: 'T', slug: 't2', offer_type: 'job', description: 'One line only.' }, {});
  ok('a one-line summary still renders', summaryOnly.includes('One line only.'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
