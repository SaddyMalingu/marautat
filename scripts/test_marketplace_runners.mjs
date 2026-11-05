#!/usr/bin/env node

/**
 * Will the marketplace runs still work tomorrow? (2026-11-05)
 *
 * Turing and Micro1 were paused for a day, which is exactly the situation that breaks a browser
 * runner: a MoreLogin profile comes back signed out, and the code that handled that best was the
 * *social* listener, not the two runners that earn money. This suite covers the four things an audit
 * found, each of which would have cost a window on the next run:
 *
 *   1. **A wall was indistinguishable from a markup change.** Neither marketplace runner asked the
 *      browser whether it was still signed in. Five failures in a row then stopped the run with
 *      `card_not_found`, which reads like "Turing changed its HTML" and sends everyone to the wrong
 *      file.
 *   2. **`--only-missing` was parsed by one runner and ignored by the other.** The worker has always
 *      passed it. Micro1 honoured it; Turing did not, so it re-opened every role it already held a
 *      link for — 120 page loads to re-mint links the tenant already owned.
 *   3. **A fresh worker folder has no resume file.** `tmp/referrals.json` lives inside the folder
 *      that gets replaced, so every download started from card 0. The durable answer is the portal's
 *      own rows.
 *   4. **The link verdict was decided twice and disagreed with itself.** The server learned that a
 *      JS-rendered page is `unresolvable` and may be answered by the browser that minted the link;
 *      the runner's own (manual) path still accepted only `match`.
 *
 * Usage: npm run test:marketplace
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CHALLENGE_RE,
  blocksRun,
  classifyMarketplaceSession,
  sessionGateExpr,
  sessionWallError
} from '../utils/browserActor/sessionGate.js';
import { judgeReferralLink, looksLikeShellTitle, resolveLinkVerdict } from '../utils/browserActor/referralVerify.js';
import { linkedTitleSet, slugifyTitle } from '../utils/browserActor/referrals.js';
import { buildRunArgs } from '../utils/browserActor/runArgs.js';
import { MICRO1_PLATFORM } from '../utils/browserActor/tasks/micro1.js';
import { TURING_PLATFORM } from '../utils/browserActor/tasks/turing.js';

const root = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
function ok(label, condition) {
  if (condition) { pass += 1; console.log(`PASS  ${label}`); } else { fail += 1; console.log(`FAIL  ${label}`); }
}
function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) { pass += 1; console.log(`PASS  ${label}`); } else {
    fail += 1;
    console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// ---------------------------------------------------------------------------
// 1. The wall
// ---------------------------------------------------------------------------
// A password field is not a judgement call: it is the login form.
eq('a password field means signed out',
  classifyMarketplaceSession({ url: 'https://work.turing.com/jobs', title: 'Turing', hasPasswordField: true }).state,
  'login_wall');
eq('being redirected to /login means signed out',
  classifyMarketplaceSession({ url: 'https://work.turing.com/login?next=/jobs', title: 'Jobs' }).state,
  'login_wall');
eq('a sign-in page title means signed out',
  classifyMarketplaceSession({ url: 'https://work.turing.com/jobs', title: 'Sign In | Turing' }).state,
  'login_wall');
eq('a Cloudflare interstitial is a challenge, not a login',
  classifyMarketplaceSession({ title: 'Just a moment...', bodyStart: 'Checking your browser before accessing' }).state,
  'challenge');
eq('and so is a human check',
  classifyMarketplaceSession({ title: 'Attention Required', bodyStart: 'Please verify you are human' }).state,
  'challenge');
eq('a listing with no wall is signed in',
  classifyMarketplaceSession({ url: 'https://work.turing.com/jobs', title: 'Jobs', hasListing: true }).state,
  'signed_in');

// The expensive mistake would be the other direction: a signed-in page whose footer offers a
// "Sign in" link must not be refused, or the runner stops working on a perfectly good session.
eq('a signed-in page that merely mentions signing in is still signed in',
  classifyMarketplaceSession({
    url: 'https://work.turing.com/jobs',
    title: 'Jobs at Turing',
    bodyStart: 'Recommended roles  Sign in  Apply now',
    hasListing: true
  }).state,
  'signed_in');
eq('a page we cannot read is unknown, not broken',
  classifyMarketplaceSession({ url: 'https://work.turing.com/jobs', title: '', bodyStart: '' }).state,
  'unknown');
ok('only a wall stops the run', blocksRun('login_wall') && blocksRun('challenge'));
ok('and a readable page does not', !blocksRun('signed_in') && !blocksRun('unknown'));

// The error carries the fix, because the tenant reads it in a window they are about to close.
{
  const error = sessionWallError(classifyMarketplaceSession({ hasPasswordField: true }));
  eq('the wall error names the state in its code', error.code, 'session_login_wall');
  ok('says what happened', /sign-in page is showing/.test(error.message));
  ok('and what to do about it', /MoreLogin/.test(error.message));
}

// The expression is generated, so it is executed against a fake DOM rather than trusted.
{
  const expression = sessionGateExpr({ listingSelector: TURING_PLATFORM.listSelector });
  const run = (document) => JSON.parse(new Function('document', 'location', `return ${expression};`)(document, {
    href: 'https://work.turing.com/jobs'
  }));
  const fake = ({ password = false, cards = 0, body = 'page text', title = 'Jobs' }) => ({
    title,
    body: { innerText: body },
    querySelector: (selector) => (password && selector === 'input[type="password"]' ? {} : null),
    querySelectorAll: (selector) => (selector === TURING_PLATFORM.listSelector
      ? Array.from({ length: cards }, () => ({}))
      : [])
  });
  const readable = run(fake({ cards: 12 }));
  eq('the gate sees the listing when it is there', readable.hasListing, true);
  eq('and no password field', readable.hasPasswordField, false);
  eq('so the page reads as signed in', classifyMarketplaceSession(readable).state, 'signed_in');
  const walled = run(fake({ password: true, cards: 0 }));
  eq('a login page reports the password field', walled.hasPasswordField, true);
  eq('and is refused', classifyMarketplaceSession(walled).state, 'login_wall');
  ok('the detector names the interstitials we actually saw',
    CHALLENGE_RE.test('Just a moment...') && CHALLENGE_RE.test('Please verify you are human'));
  ok('and not a normal job listing', !CHALLENGE_RE.test('Senior Data Engineer, remote, apply now'));
}

// ---------------------------------------------------------------------------
// 2. One verdict, decided once
// ---------------------------------------------------------------------------
// The 2026-11-04 failure: a shell title on an SPA, which is not evidence about the role.
{
  const shell = judgeReferralLink({ expectedTitle: 'Business Analyst - US', resolvedTitle: 'Turing Jobs' });
  eq('a brand-only title cannot be read', shell.verdict, 'unresolvable');
  ok('and a sign-in title is the same kind of nothing', looksLikeShellTitle('Sign in | Turing'));

  eq('a real fetch match is accepted as server evidence',
    resolveLinkVerdict({ check: { verdict: 'match', reason: 'title_identical' }, expectedTitle: 'Role' }).verdict,
    'match');
  eq('and attributed to the server',
    resolveLinkVerdict({ check: { verdict: 'match' }, expectedTitle: 'Role' }).source,
    'server');
  eq('a fetch that names another role is refused',
    resolveLinkVerdict({
      check: { verdict: 'mismatch', reason: 'title_differs' },
      expectedTitle: 'Business Analyst',
      pageTitle: 'Business Analyst | Turing'
    }).verdict,
    'mismatch');
  eq('and the browser title cannot overrule it',
    resolveLinkVerdict({
      check: { verdict: 'mismatch' },
      expectedTitle: 'Business Analyst',
      pageTitle: 'Business Analyst | Turing'
    }).source,
    'server');
  eq('an unreadable page plus a matching browser title is accepted',
    resolveLinkVerdict({
      check: { verdict: 'unresolvable', reason: 'shell_page' },
      expectedTitle: 'Business Analyst - US',
      pageTitle: 'Business Analyst - US | Turing'
    }).verdict,
    'match');
  eq('as the browser evidence, not the server\'s',
    resolveLinkVerdict({
      check: { verdict: 'unresolvable' },
      expectedTitle: 'Business Analyst - US',
      pageTitle: 'Business Analyst - US | Turing'
    }).source,
    'worker');
  eq('an unreadable page and no browser title stays unreadable',
    resolveLinkVerdict({ check: { verdict: 'unresolvable', reason: 'shell_page' }, expectedTitle: 'Role' }).verdict,
    'unresolvable');
  eq('and a browser title naming another role is refused',
    resolveLinkVerdict({
      check: { verdict: 'unresolvable' },
      expectedTitle: 'Business Analyst',
      pageTitle: 'Software Engineer | Turing'
    }).verdict,
    'mismatch');
  eq('a verifier that returned nothing is not a match',
    resolveLinkVerdict({ check: null, expectedTitle: 'Role' }).verdict,
    'unresolvable');
}

// ---------------------------------------------------------------------------
// 3. `--only-missing` means something now
// ---------------------------------------------------------------------------
{
  const titles = linkedTitleSet({
    offers: [
      { title: 'Business Analyst - US', referral_url: 'https://work.turing.com/r/abc' },
      { title: 'Data Engineer', referral_url: null },
      { title: 'QA Engineer', referral_url: '   ' }
    ],
    captures: [{ title: 'Prompt Engineer', referralUrl: 'https://work.turing.com/r/xyz' }]
  });
  ok('a role with a link is known', titles.has(slugifyTitle('Business Analyst - US')));
  ok('a capture that carries a link counts too', titles.has(slugifyTitle('Prompt Engineer')));
  ok('a role without one is not', !titles.has(slugifyTitle('Data Engineer')));
  ok('and neither is a blank link', !titles.has(slugifyTitle('QA Engineer')));
  eq('an empty tenant has no titles', linkedTitleSet().size, 0);
}

// The worker has always passed it, so the flag must reach a runner that reads it.
{
  const argv = buildRunArgs({ relative: 'x', platform: 'turing', tenantSlug: 't', runId: 'r', limit: 40, api: 'https://a' });
  ok('the Turing run still asks for only the missing links', argv.includes('--only-missing'));
  ok('and still reports into a run id', argv.includes('--run-id'));
}
{
  const referrals = read('scripts/browser_actor_referrals.mjs');
  ok('the Turing runner honours --only-missing', /const onlyMissing = flag\('only-missing'/.test(referrals));
  ok('and skips a role before opening it', /onlyMissing && !refresh/.test(referrals));
  ok('reading the card title alone is enough to decide', /probeCard\(\{ host, port, index \}\)/.test(referrals));
  ok('the skip is paced, so it cannot become its own burst', /await sleep\(Math\.min\(400, pace\)\)/.test(referrals));
  {
    // `continue` inside a `try` still runs `finally`, so a skip counted inside the block would be
    // counted twice and then marked as a failure. The skip has to finish before the try opens.
    const tail = referrals.slice(referrals.indexOf('if (onlyMissing && !refresh)'));
    const beforeTry = tail.slice(0, Math.max(0, tail.indexOf('try {')));
    ok('a skipped role is counted outside the try/finally', /runState\.done \+= 1/.test(beforeTry));
    ok('and reaches the next role without falling through', /continue;/.test(beforeTry));
  }
}

// ---------------------------------------------------------------------------
// 4. A wall is detected before the window is spent
// ---------------------------------------------------------------------------
{
  const referrals = read('scripts/browser_actor_referrals.mjs');
  ok('Turing checks the session after loading the listing',
    /const gate = await readGate\(\{ host, port \}\)/.test(referrals));
  ok('and stops instead of clicking into a wall', /throw wallError\(gate\)/.test(referrals));
  ok('it repeats the check when failures pile up', /const gateNow = await readGate/.test(referrals));
  ok('so "signed out" is never reported as a markup change',
    /stopping after \$\{consecutiveFailures\} failures: \$\{gateNow\.state\}/.test(referrals));
  ok('the manual path uses the shared verdict', /resolveLinkVerdict\(\{/.test(referrals));
  ok('and matches the browser title to the role by title',
    /pageTitleByRole\.get\(slugifyTitle\(update\.title\)\)/.test(referrals));
  ok('offers reach the capture loop', /offers:\s*\n\s*skip, limit/.test(referrals) === false
    ? /offers,/.test(referrals)
    : true);

  const micro1 = read('scripts/browser_actor_micro1.mjs');
  ok('Micro1 checks the session too', /classifyMarketplaceSession\(await evaluateJson/.test(micro1));
  ok('and throws rather than returning an empty capture list', /throw sessionWallError\(gate\)/.test(micro1));
  ok('its "nothing rendered" line names the session state',
    /listing did not render .*session=\$\{gate\.state\}/.test(micro1));
  ok('Micro1 already honoured --only-missing', /onlyMissing/.test(micro1) && /planMicro1Window/.test(micro1));
}

// The portal has to send the links, or the worker cannot know what it already owns.
{
  const route = read('routes/agentRuns.js');
  ok('the run context carries referral_url to the worker',
    /select\('title, slug, external_id, referral_url'\)/.test(route));
  ok('and a listen run still gets no offer list', /known: isListen \? \[\]/.test(route));
  const apply = read('utils/browserActor/applyCaptures.js');
  ok('the server uses the one verdict function', /resolveLinkVerdict\(\{/.test(apply));
  ok('for new offers as well as existing ones', (apply.match(/resolveLinkVerdict\(\{/g) || []).length >= 2);
}

// Nothing may grow a way to spend a session without asking the page first.
{
  const gateSrc = read('utils/browserActor/sessionGate.js');
  ok('the wall detector lives in one module', /export function classifyMarketplaceSession/.test(gateSrc));
  ok('and the runners do not re-implement it',
    !/CHALLENGE_RE\s*=/.test(read('scripts/browser_actor_referrals.mjs'))
    && !/CHALLENGE_RE\s*=/.test(read('scripts/browser_actor_micro1.mjs')));
  ok('the platforms still declare the addresses the gate reads',
    Boolean(TURING_PLATFORM.listSelector) && Boolean(MICRO1_PLATFORM.listUrl));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

