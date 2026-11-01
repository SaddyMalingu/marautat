#!/usr/bin/env node

/**
 * Capture each role's OWN referral link from the tenant's live Turing session.
 *
 *   # read 3 roles, write nothing to the database
 *   node scripts/browser_actor_referrals.mjs --tenant malingu-ventures --limit 3
 *
 *   # attach what was captured, from the file (no browser needed)
 *   node scripts/browser_actor_referrals.mjs --tenant malingu-ventures \
 *     --from tmp/referrals.json --apply
 *
 * Why this is a separate script with its own flag rather than part of the collector:
 * collecting a role is a READ, capturing its link is a CLICK on the tenant's own
 * logged-in account. They have different blast radii and deserve different consent.
 *
 * Safety properties:
 *   - default is capture + plan; `--apply` is required to write
 *   - an offer that already has a link is never overwritten (planReferralBackfill)
 *   - a capture with no confident pick writes nothing and keeps its candidates
 *   - the write is guarded by `.is('referral_url', null)` too, so even a race with
 *     the tenant pasting a link by hand cannot clobber it
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createMoreloginClient, redact } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { capturePage, resolveDebugTarget, CdpSession } from '../utils/browserActor/cdp.js';
import { verifyReferralLink } from '../utils/browserActor/referralVerify.js';
import { parseProfileMap, resolveIdentity, describeIdentity } from '../utils/browserActor/identity.js';
import { TURING_PLATFORM, TURING_LIST_COUNT_EXPR, TURING_LOAD_MORE_EXPR } from '../utils/browserActor/tasks/turing.js';
import {
  REFERRAL_MODAL_TIMEOUT_MS,
  REFERRAL_PACE_MS,
  TURING_CLOSE_MODAL_EXPR,
  TURING_DETAIL_REFERRAL_EXPR,
  TURING_MODAL_CANDIDATES_EXPR,
  TURING_REFERRAL_HOST,
  hasReferralCandidate,
  jobIdFromUrl,
  normalizeReferralCapture,
  planReferralBackfill,
  referralCaptureHeadline,
  turingCardProbeExpr,
  turingOpenReferralExpr
} from '../utils/browserActor/tasks/turingReferrals.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

const tenant = flag('tenant');
const platform = String(flag('platform', 'turing'));
const limit = Number(flag('limit', 5)) || 0;
const skip = Number(flag('skip', 0)) || 0;
const pace = Number(flag('pace', REFERRAL_PACE_MS)) || REFERRAL_PACE_MS;
const outPath = path.resolve(String(flag('out', 'tmp/referrals.json')));
const fromFile = flag('from');
const apply = flag('apply', null) !== null;
const verifyLinks = flag('no-verify', null) === null;

if (!tenant) {
  console.error('usage: --tenant <slug> [--limit 5] [--skip 0] [--out tmp/referrals.json] [--apply] [--from file]');
  process.exit(1);
}
if (platform !== 'turing') {
  console.error(`no per-role referral adapter for "${platform}" yet — only turing is verified`);
  process.exit(1);
}
if (!fromFile && limit <= 0) {
  console.error('--limit must be a positive number of roles to read');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One CDP session for the whole run.
//
// Every evaluate used to open a socket and close it again — plus an HTTP call to
// /json/version to find the target — and each role does five to eight evaluates.
// That was pure overhead, repeated seventy times. A page session survives navigation
// (it is bound to the target, not the document), so one session outlives the run.
let sharedSession = null;

async function ensureSession({ host, port }) {
  if (sharedSession && !sharedSession.closed) return sharedSession;
  const target = await resolveDebugTarget({ host, port });
  if (!target.pageWsUrl) throw new Error('the profile exposed no page target');
  sharedSession = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  return sharedSession;
}

async function closeSession() {
  if (!sharedSession) return;
  try { sharedSession.close(); } catch {}
  sharedSession = null;
}

async function evaluateJson({ host, port, expression }) {
  let session = await ensureSession({ host, port });
  let result;
  try {
    result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 30_000 });
  } catch (error) {
    // A session can die with the page (a crash, a closed tab). Rebuild it once.
    sharedSession = null;
    session = await ensureSession({ host, port });
    result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 30_000 });
  }
  const raw = result?.result?.value;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function countCards({ host, port }) {
  const value = await evaluateJson({ host, port, expression: TURING_LIST_COUNT_EXPR });
  return Number(value) || 0;
}

/** The URL the page is actually on, read from the page rather than remembered. */
async function currentUrl({ host, port }) {
  const value = await evaluateJson({ host, port, expression: 'String(location.href)' });
  return typeof value === 'string' ? value : '';
}

/** Wait for the listing to finish rendering (skeletons are the tell). */
async function waitForSkeletons({ host, port, maxMs = 20_000 }) {
  const expression = `document.querySelectorAll(${JSON.stringify(TURING_PLATFORM.wait.selector)}).length === 0`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    const cleared = await evaluateJson({ host, port, expression });
    if (cleared === true) return true;
    await sleep(500);
  }
  return false;
}

/** Pages the listing until the DOM holds enough cards for the requested window. */
async function ensureCards({ host, port, needed, maxClicks = 30 }) {
  let cards = await countCards({ host, port });
  for (let step = 1; step <= maxClicks && cards < needed; step += 1) {
    const clicked = await evaluateJson({ host, port, expression: TURING_LOAD_MORE_EXPR });
    if (!clicked || clicked.clicked !== true) break;
    const before = cards;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000) {
      cards = await countCards({ host, port });
      if (cards > before) break;
      await sleep(500);
    }
    if (cards <= before) break;
    await sleep(600);
  }
  return cards;
}

/**
 * Wait for the share dialog to actually contain a link.
 *
 * Verified live 2026-10-31: clicking "Share & earn" opens the dialog immediately,
 * but the readonly input that holds `https://work.turing.com/r/xako-8LrQK` is filled
 * a beat later. An earlier version returned as soon as `inDialog` was true, read an
 * empty input, and reported a marketplace with no links as if that were the truth.
 * So: poll until a candidate parses as a referral link, and only then give up.
 */
async function waitForModalCandidates({ host, port, maxMs = REFERRAL_MODAL_TIMEOUT_MS }) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < maxMs) {
    last = await evaluateJson({ host, port, expression: TURING_MODAL_CANDIDATES_EXPR });
    if (last?.ok && hasReferralCandidate(last.candidates || [], { host: TURING_REFERRAL_HOST })) return last;
    await sleep(400);
  }
  return last;
}

/** Read one role's link. Returns a capture record plus what the UI did. */
async function captureOne({ host, port, index }) {
  const probe = await evaluateJson({ host, port, expression: turingCardProbeExpr(index) });
  if (!probe?.ok) {
    return { capture: null, note: probe?.reason || 'probe_failed' };
  }

  let opened = await evaluateJson({ host, port, expression: turingOpenReferralExpr(index) });
  let pageUrl = opened?.url || probe.url || TURING_PLATFORM.listUrl;
  let clickedBy = opened?.by || null;
  let affordance = opened?.text || null;
  let note = null;

  // Opening a role takes you to a JOB DETAIL page (`?jobId=112467`), not a modal —
  // verified live. The referral control lives there, so the search continues on the
  // page we just landed on instead of clicking the card again.
  const jobId = jobIdFromUrl(pageUrl);
  if (jobId) {
    await sleep(1_200);
    const detail = await evaluateJson({ host, port, expression: TURING_DETAIL_REFERRAL_EXPR });
    if (detail?.url) pageUrl = detail.url;
    if (detail?.ok && detail.clicked) {
      clickedBy = detail.by;
      affordance = detail.text || affordance;
    } else {
      note = detail?.reason || 'no_detail_referral';
      // The labels are the evidence: they name what the page offers instead.
      affordance = (Array.isArray(detail?.labels) ? detail.labels : []).join(' | ').slice(0, 200) || affordance;
    }
  } else if (opened?.ok && opened.clicked && clickedBy === 'details') {
    // "details" only expanded the card; the referral link is inside it.
    await sleep(900);
    const second = await evaluateJson({ host, port, expression: turingOpenReferralExpr(index) });
    if (second?.ok && second.clicked) {
      clickedBy = second.by;
      affordance = second.text || affordance;
      pageUrl = second.url || pageUrl;
    }
  }

  const modal = clickedBy ? await waitForModalCandidates({ host, port }) : null;

  const capture = normalizeReferralCapture({
    index,
    title: probe.title,
    candidates: modal?.candidates || [],
    clickedBy,
    pageUrl,
    modalText: modal?.text || note,
    affordance,
    buttons: probe.buttons
  });
  if (!capture.referralUrl && note) capture.reason = note;

  await evaluateJson({ host, port, expression: TURING_CLOSE_MODAL_EXPR });

  // Leaving the listing means every later index would point at a different page,
  // so the caller is told and goes back rather than capturing the wrong roles.
  const leftListing = Boolean(jobId) || !isListingPage(pageUrl);
  return { capture, leftListing, note: leftListing ? 'navigated' : note };
}

/** True when the URL is still the roles listing, query string and all. */
function isListingPage(url) {
  try {
    const parsed = new URL(String(url));
    const expected = new URL(TURING_PLATFORM.listUrl);
    return parsed.hostname === expected.hostname && parsed.pathname.startsWith(expected.pathname);
  } catch {
    return false;
  }
}

function loadSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SB_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SB_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing Supabase credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');
    process.exit(1);
  }
  return createClient(url, key);
}

/** The tenant, and every offer it owns — the only rows this script may touch. */
async function loadTenantContext() {
  const supabase = loadSupabase();
  const { data: tenantRow, error } = await supabase
    .from('site_tenants').select('id, slug, name').eq('slug', tenant).maybeSingle();
  if (error) throw error;
  if (!tenantRow) {
    const { data: known } = await supabase.from('site_tenants').select('slug').limit(50);
    console.error(`No tenant with slug "${tenant}". Nothing was read or written.`);
    console.error(`Existing slugs: ${(known || []).map((row) => row.slug).join(', ') || '(none)'}`);
    process.exit(2);
  }
  const { data: offers, error: offersError } = await supabase
    .from('opportunities')
    .select('id, title, slug, external_id, referral_url, status')
    .eq('tenant_id', tenantRow.id);
  if (offersError) throw offersError;
  return { supabase, tenantRow, offers: offers || [] };
}

/**
 * Drive the live session.
 *
 * Two properties this function did not have, learned the hard way on a 72-role run
 * that died at role 43 with `CDP call Runtime.evaluate timed out` and saved nothing:
 *
 *   1. **Every capture is persisted the moment it is read.** The link is already
 *      minted on the marketplace side, so losing the record wastes the work even
 *      though the link itself is stable and can be read again.
 *   2. **One bad role cannot end the run.** A timeout is recorded, the page is
 *      rebuilt, and the loop continues. A 40-minute unattended job must not be
 *      all-or-nothing.
 */
async function runCapture({ existing = [] } = {}) {
  const identity = resolveIdentity({
    tenantSlug: tenant,
    map: parseProfileMap(process.env.BROWSER_ACTOR_PROFILES || ''),
    defaultEnvId: process.env.BROWSER_ACTOR_DEFAULT_ENV_ID || ''
  });
  const runtime = createBrowserRuntime({ client: createMoreloginClient() });
  const started = await runtime.startProfile(identity.envId, {
    runtime: identity.runtime,
    headless: flag('headful', null) === null
  });
  if (!started.debugPort) {
    console.error(`profile not ready (status=${started.status})`);
    process.exit(1);
  }
  const host = started.host;
  const port = started.debugPort;
  console.error(`tenant=${tenant} profile=${describeIdentity(identity).envIdMasked} port=${port}`);

  const doneIndexes = new Set(
    (Array.isArray(existing) ? existing : [])
      .filter((row) => row && row.referralUrl && Number.isFinite(Number(row.index)))
      .map((row) => Number(row.index))
  );
  const captures = Array.isArray(existing) ? [...existing] : [];

  // Written after every single role: a crash costs one role, not the run.
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(
        outPath,
        JSON.stringify({ tenant, updatedAt: new Date().toISOString(), requested: { skip, limit }, captures }, null, 2)
      );
    } catch (error) {
      console.error(`could not save progress: ${error?.message || error}`);
    }
  };
  if (doneIndexes.size) console.error(`resuming: ${doneIndexes.size} capture(s) already on disk`);

  try {
    await capturePage({ host, port, url: TURING_PLATFORM.listUrl, timeoutMs: 45_000 });
    const cleared = await waitForSkeletons({ host, port });
    const needed = skip + limit;
    let cards = await ensureCards({ host, port, needed });
    console.error(`skeletonsCleared=${cleared} cards=${cards} window=${skip + 1}..${skip + limit}`);

    // Fixed once: a later rebuild may page less far, and the loop bound must not
    // shrink with it or the run would stop early and silently.
    const windowEnd = Math.min(cards, needed);

    if (windowEnd <= skip) {
      console.error(`the listing stops at ${cards} cards — nothing in the requested window`);
      return captures;
    }

    const waitForCards = async (minCards = 1, maxMs = 12_000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < maxMs) {
        if ((await countCards({ host, port })) >= minCards) return true;
        await sleep(300);
      }
      return false;
    };

    // Rebuilding the listing is the expensive part of this loop, so it lives in one
    // place and is only used when the page is genuinely unknown. It pages only as far
    // as the role being captured — the old version paged to the end of the window on
    // every single role, which is why 42 roles took 40 minutes.
    const rebuild = async (upToIndex = windowEnd - 1) => {
      const wanted = Math.max(12, Math.min(upToIndex + 1, needed));
      // Prefer the browser's own back button. If the SPA restores the listing it
      // already had, returning costs one navigation instead of a navigation plus
      // several "Load more" clicks — and the card count is checked either way, so a
      // shallow restore simply falls through to the full rebuild.
      let restored = false;
      try {
        if (isListingPage(await currentUrl({ host, port })) === false) {
          await evaluateJson({ host, port, expression: 'history.back(); "ok"' });
        }
        restored = await waitForCards(wanted, 6_000);
      } catch {
        restored = false;
      }
      if (!restored) {
        console.error('  return: full rebuild (back did not restore the listing)');
        await capturePage({ host, port, url: TURING_PLATFORM.listUrl, timeoutMs: 45_000 });
        // Wait for CARDS, not for skeletons to disappear: a freshly navigated page is
        // blank for a moment, and "no skeletons" is equally true of a blank page. That
        // mistake turned every rebuild into a card_not_found cascade.
        await waitForCards(1, 15_000);
        await waitForSkeletons({ host, port });
        cards = await ensureCards({ host, port, needed: wanted });
      } else {
        cards = await countCards({ host, port });
        if (cards < wanted) cards = await ensureCards({ host, port, needed: wanted });
      }
    };

    /**
     * Read one role, and repair the listing before giving up on it.
     *
     * `card_not_found` means the listing is shorter than the index — usually a
     * "Load more" that did not land. Not rebuilding on that turned 12 working roles
     * into 48 failures, because every later index was probed against the same short
     * listing. One retry after a rebuild costs a page load and saves the run.
     */
    const readRole = async (index) => {
      const first = await captureOne({ host, port, index });
      if (first.capture) return first;
      console.error(`[${index}] no card at that index (${first.note}) — rebuilding and retrying once`);
      await rebuild(index);
      return captureOne({ host, port, index });
    };

    let consecutiveFailures = 0;

    for (let index = skip; index < windowEnd; index += 1) {
      if (doneIndexes.has(index)) {
        console.error(`[${index}] already captured — skipping`);
        continue;
      }

      try {
        const roleStartedAt = Date.now();
        const { capture, leftListing, note } = await readRole(index);
        captures.push(capture || { index, title: null, externalId: null, referralUrl: null, reason: note || 'probe_failed' });
        const label = String(capture?.title || '(no title)').slice(0, 60);
        // The per-role duration is the number that decides whether a full run is
        // worth starting, so it is logged rather than inferred from timestamps.
        console.error(`[${index}] ${capture?.referralUrl ? 'LINK' : capture?.reason || note || 'no link'} — ${label} (${Date.now() - roleStartedAt}ms)`);

        consecutiveFailures = capture?.referralUrl ? 0 : consecutiveFailures + 1;

        if (leftListing) {
          // Recover instead of proceeding against the wrong page: every later index
          // refers to a card that no longer exists.
          console.error(`[${index}] left the listing — returning`);
          await rebuild(index);
        }
      } catch (error) {
        // One role timing out must not end a 40-minute run. Record it, rebuild the
        // page, and keep going; a re-run will retry whatever failed here.
        console.error(`[${index}] FAILED — ${error?.message || error}`);
        captures.push({ index, title: null, externalId: null, referralUrl: null, reason: `error:${error?.code || 'unknown'}` });
        consecutiveFailures += 1;
        try { await rebuild(index); } catch (rebuildError) {
          console.error(`[${index}] rebuild failed too: ${rebuildError?.message || rebuildError}`);
        }
      } finally {
        save();
      }

      if (consecutiveFailures >= 5) {
        // Five in a row means the marketplace changed under us (signed out, layout
        // shift). Stopping is honest, and the progress file keeps everything so far.
        console.error(`stopping after ${consecutiveFailures} consecutive failures — re-run to resume`);
        break;
      }

      await sleep(pace);
    }
    return captures;
  } finally {
    await closeSession();
    if (flag('keep-open', null) === null) {
      try { await runtime.closeProfile(identity.envId); } catch {}
    }
  }
}

/**
 * Attach the captured links.
 *
 * `.is('referral_url', null)` is the real guard: even if the tenant pasted a link
 * into the portal while this was running, the update matches nothing and the row is
 * reported as already linked rather than overwritten.
 */
async function applyBackfill({ supabase, plan }) {
  const updated = [];
  const failed = [];
  for (const update of plan.updates) {
    if (!update.id) {
      failed.push({ title: update.title, reason: 'no_id' });
      continue;
    }
    const { data, error } = await supabase
      .from('opportunities')
      .update({ referral_url: update.referral_url, updated_at: new Date().toISOString() })
      .eq('id', update.id)
      .is('referral_url', null)
      .select('id, title, referral_url');
    if (error) {
      failed.push({ title: update.title, reason: error.message });
      continue;
    }
    if (!data || !data.length) {
      failed.push({ title: update.title, reason: 'already_linked_by_someone_else' });
      continue;
    }
    updated.push({ title: data[0].title, referral_url: data[0].referral_url });
  }
  return { updated, failed };
}

async function main() {
  const { supabase, tenantRow, offers } = await loadTenantContext();
  console.error(`tenant=${tenantRow.slug} offers=${offers.length}`);

  let captures = [];
  if (fromFile) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(String(fromFile)), 'utf8'));
    captures = Array.isArray(raw) ? raw : Array.isArray(raw.captures) ? raw.captures : [];
    console.error(`captures from ${fromFile}: ${captures.length}`);
  } else {
    // Resume from whatever the last run managed to save. A CDP timeout at role 43
    // used to throw 43 captures away; now it costs one role.
    let prior = [];
    try {
      if (fs.existsSync(outPath)) {
        const raw = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        prior = Array.isArray(raw?.captures) ? raw.captures : Array.isArray(raw) ? raw : [];
      }
    } catch (error) {
      console.error(`ignoring unreadable progress file: ${error?.message || error}`);
      prior = [];
    }
    captures = await runCapture({ existing: prior });
  }

  const plan = planReferralBackfill({ offers, captures, host: TURING_REFERRAL_HOST });

  // A link is only written if it provably lands on the role it is attached to.
  // "The dialog showed me a code" is not proof; resolving it is.
  const verification = [];
  if (verifyLinks) {
    for (const update of plan.updates) {
      const check = await verifyReferralLink({ url: update.referral_url, expectedTitle: update.title });
      verification.push({
        title: update.title,
        referral_url: update.referral_url,
        verdict: check.verdict,
        reason: check.reason,
        resolvedTitle: check.resolvedTitle || null
      });
      if (check.verdict !== 'match') {
        plan.skipped.push({ title: update.title, reason: `unverified_${check.verdict}` });
      }
    }
    const rejected = new Set(verification.filter((row) => row.verdict !== 'match').map((row) => row.referral_url));
    if (rejected.size) {
      console.error(`refusing ${rejected.size} link(s) that do not resolve to their role`);
      plan.updates = plan.updates.filter((update) => !rejected.has(update.referral_url));
    }
  }

  const report = {
    tenant: tenantRow.slug,
    mode: fromFile ? 'from_file' : 'capture',
    requested: fromFile ? null : { skip, limit },
    captured: captures.length,
    withLink: captures.filter((row) => row && row.referralUrl).length,
    verified: verifyLinks ? { checked: verification.length, match: verification.filter((v) => v.verdict === 'match').length } : 'skipped',
    headline: referralCaptureHeadline(plan),
    plan,
    verification
  };

  // Always persist, even when nothing was attached: the candidates behind a
  // `no_confident_pick` are the only way a human can decide the next step.
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ ...report, generatedAt: new Date().toISOString(), captures }, null, 2));

  if (apply) {
    report.applied = await applyBackfill({ supabase, plan });
  } else if (plan.updates.length) {
    console.error('plan only — re-run with --apply to attach these links');
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(redact(error?.message || String(error)));
  if (error?.code) console.error(`code: ${error.code}`);
  process.exit(1);
});




