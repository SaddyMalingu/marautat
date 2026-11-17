/**
 * Writer's Flow view (2026-11-02)
 *
 * One per-tenant answer to three questions the portal could not answer before:
 *
 *   - What is the *flow* doing right now — queued, running, stalled, finished?
 *   - Where does the work stand: captured -> imported -> live -> linked -> verified,
 *     per marketplace, with the drop-off at each step?
 *   - Which referral links can I act on today, and what should I do about each?
 *
 * Design rules that matter more than the layout:
 *
 *   **Unknown is never rendered as healthy.** A link with no verdict is `unchecked`,
 *   not `ok`; a database without the runs table reports `runsAvailable: false` instead
 *   of "no runs", because those two mean opposite things while a run is in flight.
 *
 *   **A human decision outranks the robot.** If a tenant accepted a mismatch (the
 *   marketplace renamed the role, say), re-running verification must not flip it back.
 *   `shouldSkipVerification` is that rule, and it is why `link_note` exists.
 *
 *   **Every next action carries its own fix.** The portal does not show a number with
 *   the word "warning" beside it; the row says what to press.
 *
 * Pure: no network, no database. The route passes rows.
 */
import { summarizeCoverage, coverageHeadline, sourceOf } from './coverage.js';
import { summarizeRuns, isActiveStatus, isStalled, runPlatform } from './browserActor/runs.js';
// The one rule for "does this URL credit anyone", shared with the tenant's worker. See the module header.
import { referralCodeOf, creditsSomebody } from './browserActor/referralCode.js';

/**
 * A link needs attention when it is absent, unproven, provably wrong — or when it credits nobody.
 *
 * `unpayable` is the state that cost this tenant months: a URL is attached, it looks done, and it carries no referral
 * code, so every click through it earns nothing. It is not `unchecked` (nothing to verify) and it is not `missing`
 * (there is a URL to replace), which is why it gets its own word (2026-11-17).
 */
export const LINK_STATES = Object.freeze(['wrong', 'unpayable', 'unchecked', 'missing', 'verified']);

/** Severity order for the action list: money lost first, cosmetics last. */
export const SEVERITY_ORDER = Object.freeze(['critical', 'high', 'medium', 'low']);

/**
 * The referral code, which host, and how it is carried — or null when there is none.
 *
 * Defined in `utils/browserActor/referralCode.js` because the tenant's worker must be able to import it too; this module
 * only re-exports it so the portal and the runner cannot answer the same question differently.
 */
export { referralCodeOf } from './browserActor/referralCode.js';

/**
 * What this offer's referral link is, in one word.
 *
 * `missing` and `unchecked` are different problems with different fixes: one needs a capture, the other needs a click.
 * And `unpayable` is a third: the fix is to mint a proper link, which no amount of verifying will produce.
 */
export function linkStateOf(offer) {
  const url = String(offer?.referral_url || '').trim();
  if (!url) return 'missing';
  const verdict = String(offer?.link_verdict || '').toLowerCase();
  // A mismatch leads the queue even among code-less links: it is the one state that pays somebody else, and a human
  // has to look at where it lands before anything is replaced.
  if (verdict === 'mismatch') return 'wrong';
  // A link with no referral code cannot credit anyone, whatever else is true of it — including a "verified" link, where
  // verification proved it lands on the right role and said nothing about whether a click earns. That is the state that
  // cost this tenant months: the row looks done, and every click through it earns nothing.
  if (!creditsSomebody(url)) return 'unpayable';
  if (verdict === 'match') return 'verified';
  return 'unchecked';
}

/**
 * Has a human already ruled on this link?
 *
 * Only `accepted` counts. A `cleared` note belongs to a link that no longer exists, so
 * there is nothing there to protect from the verifier.
 */
export function shouldSkipVerification(offer) {
  return String(offer?.link_note || '').trim().toLowerCase().startsWith('accepted');
}

/** The write a verification result becomes. Pure so the route cannot invent one. */
export function buildVerdictPatch(check, now = new Date()) {
  const verdict = ['match', 'mismatch', 'unresolvable'].includes(String(check?.verdict || '').toLowerCase())
    ? String(check.verdict).toLowerCase()
    : 'unresolvable';
  return {
    link_verdict: verdict,
    link_checked_at: new Date(now).toISOString()
  };
}

/** Drops the URL and keeps the reason: the audit trail outlives the wrong link. */
export function buildClearPatch({ pointsAt = null, now = new Date() } = {}) {
  return {
    referral_url: null,
    link_verdict: null,
    link_checked_at: null,
    link_note: pointsAt ? `cleared by tenant: pointed at ${pointsAt}` : 'cleared by tenant',
    updated_at: new Date(now).toISOString()
  };
}

/**
 * The offers a tenant should look at, worst first.
 *
 * Wrong links lead because they are the only state here that actively pays somebody
 * else while looking fine. Capped: a queue of 96 is a report, not a to-do list.
 */
export function linkQueue(offers = [], { limit = 25 } = {}) {
  const rank = { wrong: 0, unchecked: 1, missing: 2, verified: 3 };
  return (Array.isArray(offers) ? offers : [])
    .filter(Boolean)
    .map((offer) => ({
      id: offer.id || null,
      title: offer.title || '(untitled)',
      slug: offer.slug || null,
      status: offer.status || null,
      url: offer.referral_url || null,
      state: linkStateOf(offer),
      verdict: offer.link_verdict || null,
      checkedAt: offer.link_checked_at || null,
      note: offer.link_note || null,
      platform: sourceOf(offer).name
    }))
    .filter((row) => row.state !== 'verified')
    .sort((a, b) => rank[a.state] - rank[b.state] || String(a.title).localeCompare(String(b.title)))
    .slice(0, Math.max(0, Number(limit) || 0));
}

/**
 * The funnel per marketplace.
 *
 * Each stage is a *subset* of the one before, so the drop-off between rows is
 * meaningful. A published offer with no link counts as live and as unlinked — both are
 * true, and hiding either one would flatter the numbers.
 */
export function buildPlatformFunnel(offers = []) {
  const rows = (Array.isArray(offers) ? offers : []).filter(Boolean);
  const byPlatform = new Map();

  for (const offer of rows) {
    const { slug, name } = sourceOf(offer);
    const row = byPlatform.get(slug) || {
      slug, name, captured: 0, draft: 0, live: 0, linked: 0, verified: 0, wrong: 0, unchecked: 0, missing: 0,
      // The money axis, separate from verification: `payable` means the URL carries a referral code, whatever else is
      // true of it (2026-11-17).
      payable: 0, unpayable: 0
    };
    const live = String(offer.status || '').toLowerCase() === 'published';
    const state = linkStateOf(offer);
    // Payability is decided by the URL, not by the verdict. Keeping it independent is what stops a link from being
    // counted as payable because somebody once clicked "verify" on it (2026-11-17).
    const credits = creditsSomebody(offer.referral_url);
    row.captured += 1;
    if (live) row.live += 1; else row.draft += 1;
    if (state === 'missing') row.missing += 1; else row.linked += 1;
    if (state === 'verified') row.verified += 1;
    if (state === 'wrong') row.wrong += 1;
    if (state === 'unchecked') row.unchecked += 1;
    if (state === 'unpayable') row.unpayable += 1;
    // A URL that carries no code earns nothing, whatever its verdict says — including a mismatch, where the row is also
    // counted as `wrong`. Both statements are true, and hiding either one flatters the catalogue.
    if (!credits && state !== 'missing') row.unpayable += state === 'unpayable' ? 0 : 1;
    // Payable = carries a code AND has not been proven to point at a different role.
    if (credits && state !== 'wrong') row.payable += 1;
    byPlatform.set(slug, row);
  }

  return [...byPlatform.values()]
    .map((row) => ({
      ...row,
      // "How much of this marketplace is actually earning?" — verified links as a share
      // of captured roles. 0 is honest; 100 means every role is provably paid.
      verifiedShare: row.captured ? Math.round((row.verified / row.captured) * 100) : 0,
      // The share a tenant should watch: a role with a code can be bought from, one without cannot.
      payableShare: row.captured ? Math.round((row.payable / row.captured) * 100) : 0
    }))
    .sort((a, b) => b.captured - a.captured);
}

/**
 * One URL, several roles (2026-11-17).
 *
 * Micro1 mints a referral link per PAIR of roles, and both offers carry that same URL. Grouping by URL is how the portal
 * shows the connection explicitly: the link we minted is attached to the roles it covers, not to one of them while the
 * other sits empty.
 */
export function sharedLinkGroups(offers = [], limit = 6) {
  const byUrl = new Map();
  for (const offer of Array.isArray(offers) ? offers : []) {
    const url = String(offer?.referral_url || '').trim();
    if (!url) continue;
    if (!byUrl.has(url)) byUrl.set(url, []);
    const title = String(offer?.title || '').trim();
    if (title) byUrl.get(url).push(title);
  }
  return [...byUrl.entries()]
    .filter(([, titles]) => titles.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, Math.max(1, Number(limit) || 6))
    .map(([url, titles]) => ({ url, titles, count: titles.length }));
}

/**
 * Which referral code the catalogue actually rides on, per host (2026-11-17).
 *
 * 236 roles under one `?referralCode=` is normal for Micro1 — the code is the account's share code, so every role
 * carries the same value, and that sameness is the *evidence* the capture used one signed-in account. Two values on the
 * same host means one of them belongs to somebody else, and nothing else on the panel would notice: every row would
 * still say "payable". Path-form codes (Turing `/r/<id>`) are per role by design, so they are counted, never flagged.
 */
export function linkAttribution(offers = []) {
  const byHost = new Map();
  for (const offer of Array.isArray(offers) ? offers : []) {
    const parsed = referralCodeOf(offer?.referral_url);
    if (!parsed) continue;
    const entry = byHost.get(parsed.host) || { host: parsed.host, form: parsed.form, codes: new Map() };
    entry.codes.set(parsed.code, (entry.codes.get(parsed.code) || 0) + 1);
    byHost.set(parsed.host, entry);
  }
  const hosts = [...byHost.values()]
    .map((entry) => {
      const codes = [...entry.codes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, roles]) => ({ code, roles }));
      return {
        host: entry.host,
        form: entry.form,
        code: codes[0].code,
        roles: codes.reduce((sum, row) => sum + row.roles, 0),
        distinct: codes.length,
        codes: codes.slice(0, 4),
        // Only the query form is expected to hold exactly one code.
        mixed: entry.form === 'query' && codes.length > 1
      };
    })
    .sort((a, b) => b.roles - a.roles);
  return {
    hosts,
    primary: hosts[0] || null,
    // The whole catalogue's answer in one flag: "does every link here credit the same account?"
    mixed: hosts.some((host) => host.mixed)
  };
}

/** A code long enough to read, short enough for a table cell. */
export function shortCode(code) {
  const value = String(code || '');
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

/** A tenant overriding the verifier. Recorded as a decision, not as a fact. */
export function buildAcceptPatch({ note = 'accepted by tenant', now = new Date() } = {}) {
  return {
    link_verdict: 'match',
    link_checked_at: new Date(now).toISOString(),
    link_note: note,
    updated_at: new Date(now).toISOString()
  };
}

/**
 * What to do next, in the order that costs the least money by waiting.
 *
 * Deliberately finite and specific: at most one action per problem class, and every
 * action names the control that fixes it. A list of ten warnings is a list nobody
 * reads.
 */
export function nextActions({ coverage, platforms = [], runs, links } = {}) {
  const actions = [];
  const wrong = Number(coverage?.wrong || 0);
  const missing = Number(coverage?.missingReferral || 0);
  const unchecked = Number(coverage?.uncheckedLinks || 0);
  const drafts = Number(coverage?.drafts || 0);
  const thin = Number(links?.thin || 0);
  // A link with no referral code is the most expensive state in the catalogue: the row looks complete, so nothing else
  // in this list will ever mention it (2026-11-17).
  const unpayable = Number(links?.unpayableTotal || links?.counts?.unpayable || 0);

  if (unpayable) {
    actions.push({
      key: 'unpayable_links',
      severity: 'critical',
      label: `${unpayable} link${unpayable === 1 ? '' : 's'} credit nobody`,
      hint: 'The URL is attached but carries no referral code. Capture Micro1 links replaces each one with a paired, attributed link.',
      action: { type: 'capture', phase: 'links' }
    });
  }
  if (wrong) {
    actions.push({
      key: 'wrong_links',
      severity: 'critical',
      label: `${wrong} referral link${wrong === 1 ? '' : 's'} point at a different job`,
      hint: "They look fine in the list and pay for somebody else's placement. Review each one.",
      action: { type: 'filter', link: 'wrong' }
    });
  }
  // Two codes on one marketplace is the quiet version of "wrong links": every row still says payable, and half the
  // clicks credit an account the tenant does not own (2026-11-17).
  // A capture that walked the listing and came back with nothing is the failure this whole panel exists to make loud: it
  // looks like work, it spends a MoreLogin start, and the catalogue is exactly as it was. Three Micro1 runs closed
  // `succeeded` with `33/33 · 0 links` on 17 Nov while the tenant believed links were being minted (see below).
  const emptyCapture = Object.entries(runs?.byPlatform || {})
    .map(([slug, state]) => ({ slug, run: state?.last }))
    .find(({ run }) => run
      && ['succeeded', 'failed', 'partial'].includes(String(run.status))
      && Number(run.done) > 0
      && Number(run.ok) === 0);
  if (emptyCapture) {
    // Two very different empty captures, and the fix differs. A popup that contains only one of the tenant's roles cannot
    // pair anything — the answer is the offers phase, not another re-mint (2026-11-17, three runs spent on that).
    const stop = String(emptyCapture.run.message || '');
    const needsOffers = /held_pool_too_small|no_pairable_roles|no_known_offers|not collected/i.test(stop);
    actions.push({
      key: 'empty_capture',
      severity: 'critical',
      label: needsOffers
        ? `Only roles you already hold can be paired — the last ${emptyCapture.slug} popup was mostly roles you do not have`
        : `The last ${emptyCapture.slug} capture processed ${emptyCapture.run.done} and minted nothing`,
      hint: needsOffers
        ? 'Micro1 needs two roles you own in the same popup. Run Collect new roles first, then re-mint: a link minted for a partner you do not own has nowhere to go.'
        : 'No role and no link reached the portal. Re-run it and watch the popup builder open: a capture that produced nothing cannot pay, however finished it looks.',
      action: needsOffers ? { type: 'capture', phase: 'offers' } : { type: 'capture', phase: 'links', remint: true }
    });
  }

  // Two codes on one marketplace is the quiet version of "wrong links": every row still says payable, and half the
  // clicks credit an account the tenant does not own (2026-11-17).
  const mixedHost = Array.isArray(links?.attribution?.hosts) ? links.attribution.hosts.find((host) => host.mixed) : null;
  if (mixedHost) {
    actions.push({
      key: 'mixed_codes',
      severity: 'high',
      label: `${mixedHost.distinct} referral codes on ${mixedHost.host}`,
      hint: 'One signed-in account should mint one code for every role. A second code means part of the catalogue credits another account.',
      action: { type: 'capture', phase: 'links' }
    });
  }
  if (unchecked) {
    actions.push({
      key: 'verify_links',
      severity: 'high',
      label: `${unchecked} link${unchecked === 1 ? '' : 's'} never verified`,
      hint: 'One click resolves every stored link and records where it actually lands.',
      action: { type: 'verify' }
    });
  }
  if (missing) {
    actions.push({
      key: 'capture_links',
      severity: 'high',
      label: `${missing} offer${missing === 1 ? '' : 's'} earn nothing until a referral link is attached`,
      hint: 'Links are minted per role, per account, so they must be captured while signed in.',
      action: { type: 'queue', kind: 'referrals' }
    });
  }
  if (thin) {
    actions.push({
      key: 'thin_descriptions',
      severity: 'medium',
      label: `${thin} offer${thin === 1 ? '' : 's'} show the card summary instead of the job`,
      hint: 'Re-run the capture with descriptions on; the page body replaces the one-liner.',
      action: { type: 'queue', kind: 'referrals', detail: { refresh: true } }
    });
  }
  if (drafts) {
    actions.push({
      key: 'publish_drafts',
      severity: 'medium',
      label: `${drafts} draft${drafts === 1 ? '' : 's'} not published`,
      hint: 'A draft is invisible to buyers and earns nothing.',
      action: { type: 'filter', link: 'drafts' }
    });
  }
  if (runs?.stalled) {
    actions.push({
      key: 'stalled_run',
      severity: 'high',
      label: `${runs.stalled} run${runs.stalled === 1 ? ' is' : 's are'} no longer reporting`,
      hint: 'The runner died or was closed. Re-running resumes from the last captured role.',
      action: { type: 'queue', kind: 'referrals' }
    });
  }
  if (!runs?.total) {
    actions.push({
      key: 'first_run',
      severity: 'low',
      label: 'No collection run recorded for this tenant yet',
      hint: 'Queue one to populate the funnel, or keep importing roles by hand.',
      action: { type: 'queue', kind: 'referrals' }
    });
  }

  return actions.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );
}

/**
 * The two marketplaces a tenant collects from, and the one thing that differs.
 *
 * Turing is read by a *runner* — a server-side job that pages through the marketplace.
 * Micro1 is read through the tenant's **own browser**, because the referral link is minted
 * inside a signed-in session. They were one button row, and that was the problem: a tenant
 * could not tell which button spent their MoreLogin start, which one needed their worker
 * running, or which one had failed last night.
 */
export const COLLECTION_PLATFORMS = Object.freeze([
  { slug: 'turing', name: 'Turing', drives: 'runner' },
  { slug: 'micro1', name: 'Micro1', drives: 'browser' }
]);

/** One run, in the shape a card renders. Kept here so the card and the history agree. */
export function runCard(run) {
  if (!run) return null;
  return {
    id: run.id || null,
    kind: run.kind || null,
    status: String(run.status || ''),
    done: Number(run.done_items) || 0,
    total: Number(run.total_items) || 0,
    ok: Number(run.ok_items) || 0,
    failed: Number(run.failed_items) || 0,
    message: run.message || null,
    startedAt: run.started_at || null,
    finishedAt: run.finished_at || null,
    createdAt: run.created_at || null,
    heartbeatAt: run.heartbeat_at || null
  };
}

/**
 * Per-marketplace run state.
 *
 * The rows are already in hand (newest first), so this is a grouping, not a query — and
 * because it is pure, the rule that Micro1 and Turing never share a status is testable
 * without a database. `runPlatform` is the same function the runner uses to decide what to
 * capture, so the card cannot claim a run belongs somewhere the runner disagrees with.
 */
export function runsByPlatform(runs = [], now = Date.now()) {
  const rows = (Array.isArray(runs) ? runs : []).filter(Boolean);
  const byPlatform = {};
  for (const spec of COLLECTION_PLATFORMS) {
    const mine = rows.filter((run) => runPlatform(run) === spec.slug);
    const current = mine.find((run) => isActiveStatus(run.status)) || null;
    byPlatform[spec.slug] = {
      total: mine.length,
      // Rows arrive newest first, so `mine[0]` is the last thing that happened here.
      last: runCard(mine[0] || null),
      current: runCard(current),
      active: Boolean(current),
      stalled: mine.filter((run) => isActiveStatus(run.status) && isStalled(run, now)).length
    };
  }
  return byPlatform;
}

/**
 * Merge run windows without duplicates, newest first.
 *
 * The panel reads two windows on purpose: the newest rows of any kind (for "Last run: …") and
 * the newest capture rows (for the marketplace cards). `verify` runs are written on every
 * "Verify links" click, so a tenant who checks links repeatedly can push a real capture out of
 * the newest-N window — which on 3 Nov made the Micro1 card say "never run" minutes after
 * twelve roles had been imported on their own machine.
 */
export function mergeRunWindows(...lists) {
  const seen = new Set();
  return lists
    .flat()
    .filter((row) => row && row.id && !seen.has(row.id) && seen.add(row.id))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

/**
 * Everything the Writer's Flow control panel renders, in one payload.
 *
 * `identity` and `runsAvailable` are passed in rather than discovered here: whether
 * this tenant has a leased browser profile, and whether the run table exists yet, are
 * facts only the caller can establish. Guessing either would put a green tick on
 * something with nothing behind it.
 */
export function writerFlowView({
  offers = [],
  runs = [],
  identity = null,
  runsAvailable = true,
  now = Date.now(),
  linkLimit = 25
} = {}) {
  const coverage = summarizeCoverage(offers);
  const platforms = buildPlatformFunnel(offers);
  const runSummary = summarizeRuns(runs, now);
  const byPlatform = runsByPlatform(runs, now);
  // Which links actually pay, and which of them cover more than one role. Both are the tenant's commercial question, not
  // an operations one: "how much of this catalogue can I be paid for?" (2026-11-17).
  const payable = platforms.reduce((sum, row) => sum + (row.payable || 0), 0);
  const unpayable = platforms.reduce((sum, row) => sum + (row.unpayable || 0), 0);
  // Which account the links ride on. "Payable" is only trustworthy if the tenant can see the code, because a link that
  // credits the wrong account is indistinguishable from one that credits theirs until the money fails to arrive.
  const attribution = linkAttribution(offers);
  // Has any capture ever *recorded a minted link*? The tenant's own test is the one that matters — click it, and the
  // page should name you as the inviter. Without a single minted URL in the run history, the codes sitting on the offers
  // came from somewhere else, and calling them payable would be a claim the portal cannot support (2026-11-17).
  const mintedInRuns = (Array.isArray(runs) ? runs : []).slice(0, 25).some((run) => {
    const blob = `${run?.message || ''} ${JSON.stringify(run?.detail || {})}`;
    return /referralCode=|[?&](ref|code)=/i.test(blob);
  });
  const links = {
    counts: {
      wrong: coverage.wrong,
      unchecked: coverage.uncheckedLinks,
      missing: coverage.missingReferral,
      verified: coverage.verified,
      payable,
      unpayable
    },
    payableTotal: payable,
    unpayableTotal: unpayable,
    // How many roles carry a code at all. The plain-language answer to "is anything unpayable?": none when this equals
    // the number of linked roles.
    linkedTotal: platforms.reduce((sum, row) => sum + (row.linked || 0), 0),
    attribution,
    // Read by the panel: when false, the codes on file were not produced by any capture it can point at.
    mintedInRuns,
    shared: sharedLinkGroups(offers),
    queue: linkQueue(offers, { limit: linkLimit }),
    // Descriptions are counted here too: a published offer with a one-line body looks
    // complete in every other number on this page.
    thin: (Array.isArray(offers) ? offers : []).filter(
      (offer) => offer && String(offer.external_id || '').trim() && String(offer.description || '').trim().length < 300
    ).length
  };

  return {
    ok: true,
    identity,
    coverage,
    headline: coverageHeadline(coverage),
    platforms,
    links,
    // What a tenant should see without opening anything: how many roles can be paid for, how many cannot, and which
    // links cover a pair (2026-11-17).
    sharedLinks: links.shared,
    payableTotal: payable,
    unpayableTotal: unpayable,
    // The code behind every link, and whether it is one code or several.
    attribution,
    // False when no capture in the run history ever recorded a minted URL — the panel must say so rather than imply it.
    mintedInRuns,
    runs: {
      available: runsAvailable,
      total: runSummary.total,
      active: runSummary.active,
      stalled: runSummary.stalled,
      headline: runsAvailable
        ? runSummary.headline
        : 'Run history is unavailable until the run-tracking migration is applied.',
      // What the two marketplace cards render. Without this the panel could only say
      // "a run is happening", never "Micro1 failed an hour ago and Turing never started".
      byPlatform,
      // Newest first, capped: the panel shows a history, not an audit log.
      recent: (Array.isArray(runs) ? runs : []).slice(0, 8).map((run) => ({
        id: run.id,
        kind: run.kind,
        status: run.status,
        source: run.source_slug || null,
        done: Number(run.done_items) || 0,
        total: Number(run.total_items) || 0,
        ok: Number(run.ok_items) || 0,
        failed: Number(run.failed_items) || 0,
        message: run.message || null,
        // Which job this run is: minting links, or collecting roles. Without it the queue line could not say, and the
        // tenant had no way to tell the two apart (2026-11-17).
        phase: (run.detail && run.detail.phase) || null,
        createdAt: run.created_at || null,
        finishedAt: run.finished_at || null,
        heartbeatAt: run.heartbeat_at || null
      }))
    },
    nextActions: nextActions({ coverage, platforms, runs: { ...runSummary, byPlatform }, links }),
    generatedAt: new Date(now).toISOString()
  };
}


