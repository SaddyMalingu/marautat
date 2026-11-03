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

/** A link needs attention when it is absent, unproven, or provably wrong. */
export const LINK_STATES = Object.freeze(['wrong', 'unchecked', 'missing', 'verified']);

/** Severity order for the action list: money lost first, cosmetics last. */
export const SEVERITY_ORDER = Object.freeze(['critical', 'high', 'medium', 'low']);

/**
 * What this offer's referral link is, in one word.
 *
 * `missing` and `unchecked` are different problems with different fixes: one needs a
 * capture, the other needs a click.
 */
export function linkStateOf(offer) {
  const url = String(offer?.referral_url || '').trim();
  if (!url) return 'missing';
  const verdict = String(offer?.link_verdict || '').toLowerCase();
  if (verdict === 'mismatch') return 'wrong';
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
      slug, name, captured: 0, draft: 0, live: 0, linked: 0, verified: 0, wrong: 0, unchecked: 0, missing: 0
    };
    const live = String(offer.status || '').toLowerCase() === 'published';
    const state = linkStateOf(offer);
    row.captured += 1;
    if (live) row.live += 1; else row.draft += 1;
    if (state === 'missing') row.missing += 1; else row.linked += 1;
    if (state === 'verified') row.verified += 1;
    if (state === 'wrong') row.wrong += 1;
    if (state === 'unchecked') row.unchecked += 1;
    byPlatform.set(slug, row);
  }

  return [...byPlatform.values()]
    .map((row) => ({
      ...row,
      // "How much of this marketplace is actually earning?" — verified links as a share
      // of captured roles. 0 is honest; 100 means every role is provably paid.
      verifiedShare: row.captured ? Math.round((row.verified / row.captured) * 100) : 0
    }))
    .sort((a, b) => b.captured - a.captured);
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

  if (wrong) {
    actions.push({
      key: 'wrong_links',
      severity: 'critical',
      label: `${wrong} referral link${wrong === 1 ? '' : 's'} point at a different job`,
      hint: "They look fine in the list and pay for somebody else's placement. Review each one.",
      action: { type: 'filter', link: 'wrong' }
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
  const links = {
    counts: {
      wrong: coverage.wrong,
      unchecked: coverage.uncheckedLinks,
      missing: coverage.missingReferral,
      verified: coverage.verified
    },
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
      byPlatform: runsByPlatform(runs, now),
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
        createdAt: run.created_at || null,
        finishedAt: run.finished_at || null,
        heartbeatAt: run.heartbeat_at || null
      }))
    },
    nextActions: nextActions({ coverage, platforms, runs: runSummary, links }),
    generatedAt: new Date(now).toISOString()
  };
}


