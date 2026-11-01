#!/usr/bin/env node

/**
 * Micro1 adapter, verified without a browser (2026-11-02).
 *
 * Every rule here was learned from the live dashboard, and each one fails silently if it
 * regresses:
 *
 *   1. **A link without the tenant's `referralCode` earns nothing.** It opens the right
 *      job and pays nobody, which looks identical to success in a list of URLs.
 *   2. **The code is account-level; the job id is per-role.** So the same code on two
 *      roles is correct, while a *different* code on one role means somebody else gets
 *      paid — the distinction `planCodeIntegrity` already encodes.
 *   3. **The card exposes no id.** An import can only be completed after the referral
 *      click, so a role without a job id must never be written as a link-less offer that
 *      looks captured.
 *
 * Usage: npm run test:micro1
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  MICRO1_JOB_HOST,
  micro1JobIdFromUrl,
  micro1JobUrl,
  pickMicro1ReferralUrl,
  parseMicro1Pay,
  parseMicro1ReferralBonus,
  parseMicro1Openings,
  normalizeMicro1Item,
  toMicro1OfferDraft,
  micro1OpenReferralExpr,
  MICRO1_LIST_EXPR,
  MICRO1_DETAIL_CONTENT_EXPR
} from '../utils/browserActor/tasks/micro1.js';
import { CONTENT_EXTRACTORS, contentExprFor } from '../utils/browserActor/enrichment.js';
import { planCodeIntegrity } from '../utils/browserActor/referralVerify.js';
import { planOfferImport } from '../utils/browserActor/offersImport.js';

let pass = 0;
let fail = 0;
function ok(name, condition) {
  if (condition) { pass += 1; console.log(`PASS  ${name}`); } else { fail += 1; console.log(`FAIL  ${name}`); }
}
function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) console.log(`      got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  ok(name, same);
}

const JOB_ID = '13caa411-9f96-46b1-a762-9b9bd0604cfb';
const CODE = '98fb722e-dde7-40cc-977b-f40871bdb2e6';
const codedLink = `https://jobs.micro1.ai/post/${JOB_ID}?referralCode=${CODE}&utm_source=referral&utm_medium=share&utm_campaign=job_referral`;

// ---------------------------------------------------------------------------
// The link that earns
// ---------------------------------------------------------------------------

eq('the job host is jobs.micro1.ai', MICRO1_JOB_HOST, 'jobs.micro1.ai');
eq('a job id is read out of a share link', micro1JobIdFromUrl(codedLink), JOB_ID);
eq('a bare job page still yields its id', micro1JobIdFromUrl(`https://jobs.micro1.ai/post/${JOB_ID}`), JOB_ID);
eq('a non-job URL yields nothing', micro1JobIdFromUrl('https://refer.micro1.ai/opportunities'), null);
eq('the clean job page is rebuilt from the id', micro1JobUrl(JOB_ID), `https://jobs.micro1.ai/post/${JOB_ID}`);
eq('and an empty id yields nothing', micro1JobUrl(''), null);

eq('a coded link is accepted', pickMicro1ReferralUrl([codedLink]), codedLink);
// The whole point: right job, no code, nobody paid.
eq('a link without a referralCode is refused', pickMicro1ReferralUrl([`https://jobs.micro1.ai/post/${JOB_ID}`]), null);
// A code on somebody else's domain is not this marketplace.
eq('a lookalike host is refused',
  pickMicro1ReferralUrl([`https://jobs.micro1.ai.evil.test/post/${JOB_ID}?referralCode=${CODE}`]), null);
eq('a page with no candidates yields nothing', pickMicro1ReferralUrl([]), null);
// `utm_source=referral` is a hint, not a requirement.
eq('the link is picked even without campaign parameters',
  pickMicro1ReferralUrl([`https://jobs.micro1.ai/post/${JOB_ID}?referralCode=${CODE}`]),
  `https://jobs.micro1.ai/post/${JOB_ID}?referralCode=${CODE}`);

// ---------------------------------------------------------------------------
// The card fields
// ---------------------------------------------------------------------------

eq('an hourly range parses', parseMicro1Pay('Pay: $30 - $45/hour'), { min: 30, max: 45, unit: 'hour' });
eq('a yearly range parses', parseMicro1Pay('Pay: $250,000 - $450,000/year'), { min: 250000, max: 450000, unit: 'year' });
eq('a single amount parses as both ends', parseMicro1Pay('Pay: $500'), { min: 500, max: 500, unit: null });
eq('no pay text parses to nulls', parseMicro1Pay(''), { min: null, max: null, unit: null });

eq('the referral bonus parses', parseMicro1ReferralBonus('Refer and earn $1,500'), 1500);
eq('a bonus without a comma parses', parseMicro1ReferralBonus('Refer and earn $300'), 300);
eq('no bonus parses to null', parseMicro1ReferralBonus('Refer and earn'), null);

eq('openings parse', parseMicro1Openings('micro1 10 Openings'), 10);
eq('a single opening parses', parseMicro1Openings('1 Opening'), 1);

const card = normalizeMicro1Item({
  index: 0,
  title: 'Enterprise Client Partner, U.S. Government',
  text: 'Posted Yesterday New High demand Enterprise Client Partner, U.S. Government micro1 1 Opening Required skills Client acquisition Pay: $250,000 - $450,000/year Refer and earn $1,500',
  openingsText: '1 Opening',
  payText: 'Pay: $250,000 - $450,000/year',
  referButton: 'Refer and earn $1,500',
  skills: ['Client acquisition', 'Outbound prospecting'],
  badges: ['New', 'High demand']
});
eq('the card title is kept verbatim', card.title, 'Enterprise Client Partner, U.S. Government');
eq('the card openings are read', card.openings, 1);
eq('the card pay is read', card.pay.max, 450000);
eq('the card bonus is read', card.referralBonus, 1500);
eq('the high-demand badge sets priority', card.priority, true);
// The card cannot know its job id: only the share link carries one.
eq('a card has no job id until a link is read', card.jobId, null);
eq('and therefore no external id either', card.externalId, null);

// ---------------------------------------------------------------------------
// The offer that gets written
// ---------------------------------------------------------------------------

const draft = toMicro1OfferDraft({ ...card, jobId: JOB_ID, description: 'body' }, { tenantSlug: 'malingu-ventures', referralUrl: codedLink });
eq('the draft is a job', draft.offer_type, 'job');
eq('the draft is never published by an agent', draft.status, 'draft');
eq('the destination is the clean job page', draft.destination_url, `https://jobs.micro1.ai/post/${JOB_ID}`);
eq('the destination carries no code', /referralCode/.test(draft.destination_url), false);
eq('the referral link is the coded one', draft.referral_url, codedLink);
eq('the external id is the job id', draft.external_id, `micro1:${JOB_ID}`);
eq('the marketplace is recorded', draft.source_slug, 'micro1');
// A yearly salary is not a per-offer price.
eq('a yearly salary is not stored as a price', draft.compensation_max, null);

const hourlyDraft = toMicro1OfferDraft({ ...card, jobId: JOB_ID, pay: { min: 30, max: 45, unit: 'hour' } }, { tenantSlug: 't' });
eq('an hourly rate is stored as a price', hourlyDraft.compensation_max, 45);

let threw = false;
try { toMicro1OfferDraft({ title: 'x' }, {}); } catch { threw = true; }
ok('a draft without a tenant is refused', threw);

// ---------------------------------------------------------------------------
// The same code on every role is correct; a different one is not
// ---------------------------------------------------------------------------

const integrity = planCodeIntegrity([
  { id: '1', title: 'Role A', referral_url: `https://jobs.micro1.ai/post/${JOB_ID}?referralCode=${CODE}` },
  { id: '2', title: 'Role B', referral_url: `https://jobs.micro1.ai/post/aaaaaaaa-1111-2222-3333-444444444444?referralCode=${CODE}` },
  { id: '3', title: 'Role C', referral_url: `https://jobs.micro1.ai/post/bbbbbbbb-1111-2222-3333-444444444444?referralCode=someone-else` }
]);
eq('one account code across roles is not flagged', integrity.issues.filter((i) => i.reason === 'shared_code').length, 0);
eq('a foreign code on one role is flagged',
  integrity.issues.filter((i) => i.reason === 'foreign_code').map((i) => i.offerId), ['3']);

// ---------------------------------------------------------------------------
// The extractor registry — this is what "add Micro1" was supposed to cost
// ---------------------------------------------------------------------------

ok('micro1 is registered as a content extractor', Boolean(CONTENT_EXTRACTORS.micro1));
ok('and resolves through the accessor', contentExprFor('micro1') === MICRO1_DETAIL_CONTENT_EXPR);
ok('turing is still registered', Boolean(CONTENT_EXTRACTORS.turing));
// A missing marketplace must be reported, not silently captured as empty text.
eq('an unknown marketplace has no extractor', contentExprFor('mercor'), null);

// ---------------------------------------------------------------------------
// Page expressions must be valid JavaScript before they reach a browser
// ---------------------------------------------------------------------------

const expressions = {
  list: MICRO1_LIST_EXPR,
  detail: MICRO1_DETAIL_CONTENT_EXPR,
  'open referral': micro1OpenReferralExpr(0)
};
for (const [name, expression] of Object.entries(expressions)) {
  let valid = true;
  try { new Function(expression); } catch (error) { valid = false; console.log(`      ${error.message}`); }
  ok(`the ${name} expression is valid JavaScript`, valid);
  // These run inside the page: an un-interpolated template shows up as the literal `${`.
  ok(`the ${name} expression has no unexpanded interpolation`, !expression.includes('${'));
}

// ---------------------------------------------------------------------------
// Import behaviour
// ---------------------------------------------------------------------------

const existing = [{ id: 'x', title: 'Enterprise Client Partner, U.S. Government', slug: 'malingu-ventures-micro1-enterprise-client-partner-u-s-government', external_id: null }];
const plan = planOfferImport({
  items: [
    { title: 'Enterprise Client Partner, U.S. Government', externalId: `micro1:${JOB_ID}`, url: micro1JobUrl(JOB_ID) },
    { title: 'Music & Sound Annotation Expert', externalId: 'micro1:ffffffff-1111-2222-3333-444444444444', url: micro1JobUrl('ffffffff-1111-2222-3333-444444444444') }
  ],
  existingOffers: existing,
  tenantSlug: 'malingu-ventures',
  tenantId: 't1',
  sourceSlug: 'micro1',
  sourceId: 'src-1'
});
eq('only the new role is created', plan.create.length, 1);
eq('the existing one is skipped by title', plan.skipped.map((s) => s.reason), ['exists_by_title']);
eq('the new offer carries the source row', plan.create[0].source_id, 'src-1');
eq('the new offer is a draft', plan.create[0].status, 'draft');
ok('the new offer is scoped to the tenant and marketplace in its slug',
  plan.create[0].slug.startsWith('malingu-ventures-micro1-'));

// ---------------------------------------------------------------------------
// The runner exists and uses the shared rules
// ---------------------------------------------------------------------------

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const script = fs.readFileSync(path.join(root, 'scripts/browser_actor_micro1.mjs'), 'utf8');
ok('the runner opens the Micro1 listing', script.includes('MICRO1_PLATFORM.listUrl'));
ok('the runner reads the share link from the page', script.includes('MICRO1_READ_REFERRAL_EXPR'));
ok('the runner verifies links before writing', script.includes('verifyReferralLink'));
ok('the runner imports through the shared planner', script.includes('planOfferImport'));
ok('the runner cannot report a run it never claimed', /if \(!runIdFlag\) return/.test(script));
ok('the runner refuses to start without a tenant', /usage: --tenant/.test(script));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);


