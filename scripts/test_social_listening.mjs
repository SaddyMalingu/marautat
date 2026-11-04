#!/usr/bin/env node

/**
 * Social listening, verified without a browser, a network or a database (2026-11-04)
 *
 * The listening pipeline has three parts and only the middle one is new: the taxonomy and its
 * scorer came from the ABOSS work, the browser is the tenant's own, and this suite covers the
 * judgement in between. What it has to prove is narrower than it looks:
 *
 *   1. **A quiet week looks quiet.** A post that matches no intent is dropped, never scored low.
 *      A padded digest costs a tenant their credibility the first time they send one.
 *   2. **An exclusion beats an inclusion.** "Job vacancy" and "dealer ad" contain the trigger
 *      words for a fleet purchase, and are most of what such a search returns.
 *   3. **The evidence travels with the score**, so a human can disagree with the machine.
 *   4. **Nothing in this path sends anything.** The most a signal can do is sit there with a
 *      first line the tenant may copy.
 *
 * Usage: npm run test:listening
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  MIN_OUTREACH_SCORE,
  confidenceOf,
  dedupeByPostUrl,
  draftFirstLine,
  extractContact,
  isOutreachReady,
  normalizeKenyaPhone,
  planSearchQueries,
  recommendedChannel,
  scorePost
} from '../utils/socialIntent.js';
import {
  MAX_POST_TEXT,
  buildSignalRows,
  loadTaxonomy,
  publicSignal,
  sanitizeListeningPosts
} from '../utils/socialSignals.js';
import {
  LINKEDIN_MAX_POSTS_PER_QUERY,
  LINKEDIN_PACE,
  classifyLinkedInSession,
  describeLinkedInTask,
  linkedInPaceMs,
  linkedInSearchUrl
} from '../utils/browserActor/tasks/linkedinListen.js';
import { LISTEN_RUN_KIND, RUN_KINDS, WORKER_PLATFORMS, canRunOnWorker, runPlatform } from '../utils/browserActor/runs.js';

let pass = 0;
let fail = 0;
function ok(label, condition) {
  if (condition) { pass += 1; console.log(`PASS  ${label}`); } else { fail += 1; console.log(`FAIL  ${label}`); }
}
function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok(label, same);
}

const root = path.resolve(import.meta.dirname, '..');
const taxonomy = loadTaxonomy();

// ---------------------------------------------------------------------------
// The taxonomy is there, and it is the one the scorer expects
// ---------------------------------------------------------------------------

eq('the taxonomy loads from the repo', taxonomy.intents.length, 12);
ok('and it has a market and trigger phrases to search for',
  Boolean(taxonomy.default_market)
  && taxonomy.intents.every((intent) => Array.isArray(intent.trigger_phrases) && intent.trigger_phrases.length));
ok('every intent can be scored against',
  taxonomy.intents.every((intent) => intent.intent_id && intent.intent_name && Array.isArray(intent.exclusion_phrases)));
eq('a missing taxonomy file is reported, not thrown', loadTaxonomy(path.join(root, 'data', 'nope.json')).intents.length, 0);

// ---------------------------------------------------------------------------
// Scoring: the judgement this whole slice rests on
// ---------------------------------------------------------------------------

const fleetInquiry = {
  postText: 'Our operations manager is looking for a car for the fleet — budget KES 2.8M, need it this month. WhatsApp 0712 345 678.',
  authorName: 'Jane Wanjiru'
};
const strong = scorePost(fleetInquiry, taxonomy);
ok('a real fleet inquiry is a signal', Boolean(strong));
eq('and it matches the fleet intent', strong.intentId, 'vehicle_purchase');
ok('with a score worth acting on', strong.intentScore >= MIN_OUTREACH_SCORE);
eq('and high confidence', strong.confidence, 'HIGH');
ok('the trigger phrase is kept as evidence', strong.triggerHits.includes('looking for a car'));
eq('the phone number is normalised', strong.contactPhone, '+254712345678');
eq('and WhatsApp is the channel', strong.recommendedChannel, 'whatsapp');

// Rule 1: no fabrication.
eq('an unrelated post is dropped, not scored',
  scorePost({ postText: 'Lovely sunset over Nairobi today, grateful for this city.' }, taxonomy), null);
eq('a one-word fragment is not a post', scorePost({ postText: 'car' }, taxonomy), null);
ok('and an empty taxonomy scores nothing instead of guessing', scorePost(fleetInquiry, { intents: [] }) === null);

// Rule 2: exclusion beats inclusion.
const vendorAd = scorePost({
  postText: 'Job vacancy: driver wanted. Need a vehicle licence, urgent. Dealer ad follows.',
  authorName: 'Fleet Recruiters'
}, taxonomy);
ok('a job advert that mentions a vehicle is recognised', Boolean(vendorAd));
ok('and it is excluded rather than promoted', vendorAd.exclusionHits.length > 0);
ok('so it is never outreach-ready', isOutreachReady(vendorAd) === false);
ok('while the real inquiry is', isOutreachReady(strong) === true);

// The weights, stated as behaviour rather than as constants.
const bare = scorePost({ postText: 'need a vehicle' }, taxonomy);
const richer = scorePost({ postText: 'need a vehicle, budget KES 900,000, urgent, Nairobi, call me on 0722 111 222' }, taxonomy);
ok('budget, timing, place and a contact raise the score above a bare trigger', bare.intentScore < richer.intentScore);
eq('confidence follows the score, not the prose', confidenceOf(80), 'HIGH');
eq('medium band', confidenceOf(60), 'MEDIUM');
eq('low band', confidenceOf(10), 'LOW');

// Phone and email extraction, which decides the channel.
eq('a Kenyan mobile is normalised to +254', normalizeKenyaPhone('0712 345 678'), '+254712345678');
eq('an international Kenyan number too', normalizeKenyaPhone('+254 712 345 678'), '+254712345678');
eq('a landline is not guessed at', normalizeKenyaPhone('020 123 4567'), null);
eq('an email is found and lowercased', extractContact('Reach me on Jane.W@Example.COM please').email, 'jane.w@example.com');
eq('no contact is no contact', extractContact('just a post').phone, null);
eq('WhatsApp wins over email when both exist',
  recommendedChannel({ phone: '+254712345678', email: 'a@b.co', postUrl: 'x' }), 'whatsapp');
eq('with only a post, the channel is a direct message',
  recommendedChannel({ postUrl: 'https://example.com/p' }), 'social_dm');
eq('with nothing at all, research comes first', recommendedChannel({}), 'research_needed');

// The draft.
const draft = draftFirstLine({ intentName: 'Vehicle Purchase and Fleet Upgrade', authorName: 'Jane Wanjiru' });
ok('the draft addresses the person by name', draft.startsWith('Hi Jane Wanjiru'));
ok('and names what they wrote about', /saw your post about vehicle purchase/i.test(draft));
ok('it asks rather than asserts', /want me to send it\?/i.test(draft));
ok('and it invents no price', !/KES|USD|\$/.test(draft));
ok('a nameless author still gets a usable line', /Hi there/.test(draftFirstLine({ intentName: 'X' })));

// ---------------------------------------------------------------------------
// Which searches to run, and the fact that the adapter only reads
// ---------------------------------------------------------------------------

const queries = planSearchQueries(taxonomy);
eq('three intents, two phrases each', queries.length, 6);
ok('all six are different phrases', new Set(queries.map((row) => row.phrase.toLowerCase())).size === 6);
eq('the hottest intents are searched first', queries[0].intentId, 'vehicle_purchase');
ok('every query names its intent', queries.every((row) => row.intentId));
eq('a wider plan is capped by what was asked for', planSearchQueries(taxonomy, { intents: 4, perIntent: 3 }).length, 12);

const searchUrl = linkedInSearchUrl('looking for a car');
ok('the search URL encodes the phrase', searchUrl.includes('keywords=looking%20for%20a%20car'));
ok('and is pinned to the last week, newest first',
  searchUrl.includes('datePosted=%22past-week%22') && searchUrl.includes('sortBy=%22date_posted%22'));
ok('it asks LinkedIn, nothing else', searchUrl.startsWith('https://www.linkedin.com/search/results/content/'));

eq('the adapter says it writes nothing', describeLinkedInTask().writes, false);
eq('and that it is a listen job', describeLinkedInTask().kind, 'listen');
ok('the per-query cap is a reading budget, not a crawl', LINKEDIN_MAX_POSTS_PER_QUERY <= 20);
const fastPace = linkedInPaceMs({ rng: () => 0 });
const slowPace = linkedInPaceMs({ rng: () => 1 });
eq('the pace floor is the minimum', fastPace, LINKEDIN_PACE.minMs);
eq('and the ceiling the maximum', slowPace, LINKEDIN_PACE.maxMs);
ok('the two ends differ, so waits are jittered rather than fixed', fastPace !== slowPace);

eq('a signed-in page with results reads as signed in', classifyLinkedInSession({ me: true, posts: 3 }), 'signed_in');
eq('a login wall reads as a wall even with an empty DOM',
  classifyLinkedInSession({ wall: true, me: false, posts: 0 }), 'login_wall');
eq('an unreadable page is unknown, not "signed in"', classifyLinkedInSession(null), 'unknown');
eq('and a page with neither signal is unknown too',
  classifyLinkedInSession({ me: false, wall: false, posts: 0 }), 'unknown');

// ---------------------------------------------------------------------------
// The transport: bounded, deduped, HTTP-only
// ---------------------------------------------------------------------------

const cleanPosts = sanitizeListeningPosts([
  { postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/', postText: 'x'.repeat(MAX_POST_TEXT + 500), authorName: 'A' },
  { postUrl: 'javascript:alert(1)', postText: 'looking for a car, budget KES 900000, urgent' },
  { postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:2/', postText: 'too short' },
  { postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:3/', postText: 'We need a vehicle for the logistics team this week.' },
  { postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:3/', postText: 'We need a vehicle for the logistics team this week.' }
]);
eq('only the two usable posts survive', cleanPosts.length, 2);
eq('long text is cut to the limit', cleanPosts[0].postText.length, MAX_POST_TEXT);
ok('a non-web permalink is discarded', !cleanPosts.some((row) => row.postUrl.startsWith('javascript')));
ok('the in-batch duplicate is collapsed',
  cleanPosts.filter((row) => row.postUrl.endsWith('activity:3/')).length === 1);
eq('and a body that is not a list is empty, not a crash', sanitizeListeningPosts('nope').length, 0);
eq('dedupe keeps order and drops repeats',
  dedupeByPostUrl([{ postUrl: 'a' }, { postUrl: 'b' }, { postUrl: 'A' }, {}]).length, 2);

const plan = buildSignalRows({ posts: cleanPosts, taxonomy, tenantId: 'tenant-1', platform: 'linkedin', runId: 'run-1' });
ok('the plan stores the matched post', plan.matched >= 1);
eq('with the tenant attached', plan.rows[0].tenant_id, 'tenant-1');
eq('and the run id', plan.rows[0].run_id, 'run-1');
ok('scores are integers inside the band',
  plan.rows.every((row) => Number.isInteger(row.intent_score) && row.intent_score >= 0 && row.intent_score <= 100));
ok('a stored row never carries an exclusion', plan.rows.every((row) => row.exclusion_hits.length === 0));
ok('and every row has a draft for the tenant to send',
  plan.rows.every((row) => /saw your post about/i.test(row.draft_first_line)));

const vendorPlan = buildSignalRows({
  posts: sanitizeListeningPosts([
    { postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:9/', postText: 'Job vacancy: need a vehicle licence, urgent. Dealer ad follows.' },
    { postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:8/', postText: 'Sunset over Nairobi.' }
  ]),
  taxonomy,
  tenantId: 'tenant-1'
});
eq('a vendor advert is not stored at all', vendorPlan.rows.length, 0);
eq('and is counted so the run message is honest', vendorPlan.excluded, 1);

// ---------------------------------------------------------------------------
// What the panel may see, and what the run is
// ---------------------------------------------------------------------------

const shown = publicSignal({
  id: 'signal-1',
  platform: 'linkedin',
  post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
  post_text: 'y'.repeat(2000),
  author_name: 'Jane',
  intent_id: 'vehicle_purchase',
  intent_name: 'Vehicle Purchase and Fleet Upgrade',
  intent_score: 85,
  confidence: 'HIGH',
  trigger_hits: ['looking for a car'],
  draft_first_line: 'Hi Jane',
  status: 'new',
  run_id: 'run-1',
  contact_email: 'jane@example.com',
  captured_at: '2026-11-04T08:00:00.000Z'
});
eq('the panel never sees the raw column names', 'post_url' in shown, false);
ok('it sees a permalink it can link to', shown.postUrl.endsWith('activity:1/'));
eq('the post text is cut for the panel', shown.postText.length, 600);
eq('and the run id stays server-side', 'runId' in shown, false);
eq('an empty row is null, not an object of undefineds', publicSignal(null), null);

eq('listen is a real run kind', RUN_KINDS.includes(LISTEN_RUN_KIND), true);
eq('a listen run belongs to LinkedIn',
  runPlatform({ kind: 'listen', detail: { platform: 'linkedin' } }), 'linkedin');
eq('and the worker will claim it',
  canRunOnWorker({ kind: 'listen', detail: { platform: 'linkedin' } }), true);
eq('linkedin is a worker platform', WORKER_PLATFORMS.includes('linkedin'), true);
eq('a capture run does not become a listen run', runPlatform({ kind: 'referrals' }), 'turing');

// The migration must be safe to re-run and must not touch anything a capture writes.
const migration = fs.readFileSync(path.join(root, 'migrations', '2026-11-04_social_signals.sql'), 'utf8');
ok('the migration creates the table it is named for', /CREATE TABLE IF NOT EXISTS social_signals/.test(migration));
ok('with one row per post per tenant', /UNIQUE \(tenant_id, post_url\)/.test(migration));
ok('and it widens the run kinds to include listen', /kind IN \([^)]*'listen'[^)]*\)/.test(migration));
ok('it does not touch offers', !/ALTER TABLE (public\.)?opportunities/.test(migration));

// Nothing in this slice can send. That is a product decision, so it is asserted, not assumed.
const intentSrc = fs.readFileSync(path.join(root, 'utils', 'socialIntent.js'), 'utf8');
const signalsSrc = fs.readFileSync(path.join(root, 'utils', 'socialSignals.js'), 'utf8');
const adapterSrc = fs.readFileSync(path.join(root, 'utils', 'browserActor', 'tasks', 'linkedinListen.js'), 'utf8');
const listenerSrc = fs.readFileSync(path.join(root, 'scripts', 'browser_actor_linkedin_listen.mjs'), 'utf8');
ok('no module in the listening path can message anyone',
  !/sendMessage|connectRequest|invite|\/messaging/i.test(`${intentSrc}${signalsSrc}${adapterSrc}${listenerSrc}`));
ok('and the listener holds no database credential',
  !/from '@supabase\/supabase-js'|createClient\(/.test(listenerSrc));
ok('the adapter only reads the page', !/\.click\(|dispatchEvent/.test(adapterSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

