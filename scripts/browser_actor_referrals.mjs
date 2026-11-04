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
// The tenant bundle has no node_modules, so neither of these may be a hard import: in agent mode
// this file runs on a customer's laptop with nothing installed but Node itself.
try { await import('dotenv/config'); } catch { /* not installed: the env already has what it needs */ }
import fs from 'node:fs';
import path from 'node:path';
import { createMoreloginClient, redact } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { capturePage, resolveDebugTarget, CdpSession } from '../utils/browserActor/cdp.js';
import { verifyReferralLink } from '../utils/browserActor/referralVerify.js';
import { contentExprFor, describeEnrichment, planDescriptionUpdates } from '../utils/browserActor/enrichment.js';
import { maskEnvId } from '../utils/browserActor/identity.js';
import { slugifyTitle } from '../utils/browserActor/referrals.js';
import { resolveRunnerIdentity } from '../utils/tenantRunnerIdentity.js';
import { createRunStore, deriveRunStatus } from '../utils/browserActor/runs.js';
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
// --refresh ignores the progress file: used to back-fill descriptions on offers whose
// referral link is already attached, where the normal resume would skip them.
const refresh = flag('refresh', null) !== null;
// Run tracking. `--run-id` picks up a specific run the portal queued; `--claim` takes
// the oldest queued run for this tenant. Without either, the script runs standalone and
// the portal simply sees no run — it does not see a fake one.
const runIdFlag = flag('run-id');
const claimQueued = flag('claim', null) !== null;

// Agent mode (2026-11-03): the same contract the Micro1 runner already uses. The worker runs on
// the tenant's computer with a `wkr_` token and nothing else: it fetches the run's context from
// the portal (profile id, known offers), drives the browser through `ml-cli`, then posts what it
// saw. No database credentials on that machine, and the privileged write stays server-side where
// every link is re-verified before it is attached.
const agentApi = String(flag('agent-api', process.env.ALPHADOME_API || '')).replace(/\/+$/, '');
const agentToken = String(flag('agent-token', process.env.TENANT_WORKER_TOKEN || ''));
const agentMode = Boolean(agentApi && agentToken);

if (!tenant && !agentMode) {
  console.error('usage: --tenant <slug> [--limit 5] [--skip 0] [--out tmp/referrals.json] [--apply] [--from file]');
  console.error('   or: --agent-api <portal> --agent-token wkr_… --run-id <uuid>   (tenant worker; no database needed)');
  process.exit(1);
}
if (agentMode && !runIdFlag) {
  console.error('agent mode needs --run-id: the portal decides which run this worker is executing');
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

/** One call to the portal in agent mode. Same shape as the Micro1 runner's. */
async function agentCall(method, pathname, body) {
  const res = await fetch(`${agentApi}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${agentToken}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

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
  let content = null;

  // Opening a role takes you to a JOB DETAIL page (`?jobId=112467`), not a modal —
  // verified live. The referral control lives there, so the search continues on the
  // page we just landed on instead of clicking the card again.
  const jobId = jobIdFromUrl(pageUrl);
  if (jobId) {
    await sleep(1_200);
    // Read the job body BEFORE opening the share dialog, which covers the page. This
    // is the whole reason the published offer said one sentence: only the card summary
    // was ever captured. A missing description must never cost us the referral link,
    // so this read is best-effort and the link path is unchanged.
    try {
      // The extractor comes from a per-marketplace registry, so a new marketplace adds
      // one entry instead of editing this loop. An unregistered platform is reported
      // rather than silently skipped.
      const contentExpr = contentExprFor('turing');
      if (contentExpr) {
        const detailContent = await evaluateJson({ host, port, expression: contentExpr });
        if (detailContent?.ok && detailContent.content) content = detailContent.content;
      }
    } catch { /* keep going: the link matters more than the prose */ }
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
  if (content) capture.content = content;

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

async function loadSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SB_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SB_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing Supabase credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');
    process.exit(1);
  }
  // Imported here, not at the top: the tenant worker runs this file with no node_modules.
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

/** The tenant, and every offer it owns — the only rows this script may touch. */
async function loadTenantContext() {
  if (agentMode) {
    const res = await agentCall('GET', `/api/agent/runs/${encodeURIComponent(String(runIdFlag))}/context`);
    if (!res.ok || !res.data?.ok) {
      const error = new Error(`the portal refused this run (${res.status}): ${res.data?.error || 'no message'}`);
      error.code = 'agent_context_refused';
      throw error;
    }
    const ctx = res.data;
    // Known offers come from the portal, never from a local guess: "what does this tenant
    // already have" is the server's answer to give, and it is what stops the worker spending a
    // MoreLogin start on roles that are already imported.
    const offers = (ctx.known || []).map((row) => ({
      id: row.id || null,
      title: row.title || null,
      slug: row.slug || null,
      external_id: row.external_id || null,
      referral_url: null,
      description: null,
      status: null
    }));
    console.error(`agent mode: tenant=${ctx.tenant?.slug || tenant} known=${offers.length} profile=${maskEnvId(ctx.identity?.envId || '')}`);
    return {
      supabase: null,
      tenantRow: { id: null, slug: ctx.tenant?.slug || tenant, name: ctx.tenant?.name || null },
      offers,
      identity: ctx.identity || null,
      limit: Number(ctx.run?.limit) || limit
    };
  }

  const supabase = await loadSupabase();
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
    .select('id, title, slug, external_id, referral_url, description, status')
    .eq('tenant_id', tenantRow.id);
  if (offersError) throw offersError;
  return { supabase, tenantRow, offers: offers || [] };
}

/**
 * Run tracking for the portal.
 *
 * The portal cannot see this script, so the script has to say what it is doing — but
 * nothing here may ever interrupt a capture. Every call is guarded: if the runs table
 * is missing, or the network blips, the run continues and only the reporting is lost.
 *
 * The heartbeat is deliberately time-based (2s) rather than per-role: a role takes a
 * couple of seconds, so this is roughly one small UPDATE per role, which is what makes
 * the portal's progress bar move at human speed instead of in bursts.
 */
const runState = { store: null, runId: null, total: 0, done: 0, ok: 0, failed: 0, lastBeat: 0 };

/**
 * How many captured links to bank at a time in agent mode.
 *
 * A 120-role Turing run drives the browser for four minutes. Reporting once at the end made the
 * whole thing all-or-nothing — the tenant's log on 2026-11-03 showed 65 links captured and
 * nothing written, because the window was closed before the single post. Twenty is small enough
 * that an interruption costs a minute of work, and large enough that the portal is not asked to
 * verify links every few seconds.
 */
const AGENT_BATCH = 20;
let lastBatchOk = 0;

async function startRunTracking(supabase, tenantRow) {
  if (agentMode) {
    // The portal created and claimed this row; this machine only reports into it. A worker that
    // opened its own run would be a second source of truth for the same job.
    runState.runId = String(runIdFlag);
    runState.total = limit;
    return;
  }
  if (!runIdFlag && !claimQueued) return;
  try {
    runState.store = createRunStore({ table: () => supabase.from('browser_actor_runs') });
    const run = runIdFlag
      ? await runState.store.claim({ runId: String(runIdFlag) })
      : await runState.store.claimNext({ tenantId: tenantRow.id, kind: 'referrals' });
    if (!run) {
      console.error('run tracking: nothing queued to claim — continuing without a run record');
      return;
    }
    runState.runId = run.id;
    runState.total = Number(run.total_items) || 0;
    console.error(`run tracking: ${run.id} (${run.status})${runState.total ? ` of ${runState.total}` : ''}`);
  } catch (error) {
    console.error(`run tracking unavailable: ${error?.message || error} — capturing anyway`);
    runState.store = null;
  }
}

async function beatRun({ force = false } = {}) {
  // Agent mode has no run store: the heartbeat is an HTTP call, because the portal owns the row.
  if (agentMode && runState.runId) {
    const nowMs = Date.now();
    if (!force && nowMs - runState.lastBeat < 2000) return;
    runState.lastBeat = nowMs;
    try {
      await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runState.runId)}/progress`, {
        done: runState.done,
        ok: runState.ok,
        failed: runState.failed,
        total: runState.total || undefined
      });
    } catch (error) {
      console.error(`run heartbeat failed: ${error?.message || error}`);
    }
    return;
  }
  if (!runState.store || !runState.runId) return;
  const nowMs = Date.now();
  if (!force && nowMs - runState.lastBeat < 2000) return;
  runState.lastBeat = nowMs;
  try {
    await runState.store.progress({
      runId: runState.runId,
      done: runState.done,
      ok: runState.ok,
      failed: runState.failed,
      total: runState.total || undefined
    });
  } catch (error) {
    console.error(`run heartbeat failed: ${error?.message || error}`);
  }
}

async function finishRunTracking({ status, message, detail } = {}) {
  if (agentMode && runState.runId) {
    try {
      await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runState.runId)}/finish`, {
        status: status || deriveRunStatus({ done: runState.done, ok: runState.ok, failed: runState.failed, total: runState.total }),
        done: runState.done,
        ok: runState.ok,
        failed: runState.failed,
        total: runState.total || undefined,
        message,
        detail
      });
    } catch (error) {
      console.error(`run could not be closed: ${error?.message || error}`);
    }
    return;
  }
  if (!runState.store || !runState.runId) return;
  try {
    await runState.store.finish({
      runId: runState.runId,
      status: status || deriveRunStatus({ done: runState.done, ok: runState.ok, failed: runState.failed, total: runState.total }),
      done: runState.done,
      ok: runState.ok,
      failed: runState.failed,
      total: runState.total || undefined,
      message,
      detail
    });
  } catch (error) {
    console.error(`run could not be closed: ${error?.message || error}`);
  }
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
async function runCapture({ existing = [], supabase = null, identity = null, onBatch = null } = {}) {
  // Identity first: a tenant who connected their own MoreLogin runs on their own profile
  // and their own key; a tenant with neither is refused rather than guessed. In agent mode the
  // portal has already resolved it and sends the envId only — the key never leaves the server.
  const runnerIdentity = identity || await resolveRunnerIdentity({ supabase, tenantSlug: tenant });
  console.error(`identity: source=${runnerIdentity.source} runtime=${runnerIdentity.runtime}`);
  const runtime = createBrowserRuntime({
    client: createMoreloginClient(runnerIdentity.apiKey ? { apiKey: runnerIdentity.apiKey } : {})
  });
  const started = await runtime.startProfile(runnerIdentity.envId, {
    runtime: runnerIdentity.runtime,
    headless: flag('headful', null) === null
  });

  if (!started.debugPort) {
    console.error(`profile not ready (status=${started.status})`);
    process.exit(1);
  }
  const host = started.host;
  const port = started.debugPort;
  console.error(`tenant=${tenant} profile=${maskEnvId(runnerIdentity.envId)} port=${port}`);

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
    // The portal's denominator, taken from the listing itself rather than from --limit:
    // a tenant who asked for 140 roles against a 84-card listing should see 84.
    if (!runState.total) runState.total = Math.max(0, windowEnd - skip);

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
      if (!refresh && doneIndexes.has(index)) {
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
        // Counted here, in `finally`, for the same reason the capture file is: a role
        // that threw still consumed one unit of the run, and a progress bar that only
        // counts successes never reaches its own total.
        runState.done += 1;
        const gotLink = Boolean(captures[captures.length - 1]?.referralUrl);
        if (gotLink) runState.ok += 1; else runState.failed += 1;
        await beatRun();
        // Bank every twentieth link while the run is still going: the portal verifies and writes
        // each batch, so a closed window costs a minute of browsing instead of the whole run.
        if (onBatch && runState.ok > 0 && runState.ok % AGENT_BATCH === 0 && runState.ok !== lastBatchOk) {
          lastBatchOk = runState.ok;
          try {
            await onBatch(captures);
          } catch (error) {
            console.error(`batch upload failed: ${error?.message || error} — continuing`);
          }
        }
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
      try { await runtime.closeProfile(runnerIdentity.envId); } catch {}
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

/**
 * Write the captured job bodies over the one-line summaries.
 *
 * Only ever grows: a capture only replaces a description that is meaningfully shorter,
 * so re-running can never lose text that is already there.
 */
async function applyDescriptions({ supabase, updates }) {
  const updated = [];
  const failed = [];
  for (const update of updates) {
    const { data, error } = await supabase
      .from('opportunities')
      .update({ description: update.description, updated_at: new Date().toISOString() })
      .eq('id', update.id)
      .select('id, title');
    if (error) { failed.push({ title: update.title, reason: error.message }); continue; }
    updated.push({ title: update.title, chars: update.to });
  }
  return { updated, failed };
}

/**
 * How many captures to send in one request, and the counter that keeps batches incremental.
 *
 * Two failures are answered here at once, both seen live on 2026-11-04:
 *
 *   1. **The payload grew with the run.** Every batched post re-sent *all* captures so far, so a
 *      120-role run ended as one ~400 KB request; Express answered 413 PayloadTooLargeError and
 *      the run closed with 120/120 captured and nothing written.
 *   2. **A refusal lost the batch.** A 413 was treated like any other error, so the links minted
 *      up to that point were gone.
 *
 * So: send only what has not been sent, fifteen at a time, and split a chunk in half if the
 * server says it is too big. Losing links to a request-size limit is not an acceptable outcome.
 */
const AGENT_POST_CHUNK = 15;
let postedCount = 0;

function externalIdMap(offers) {
  const byTitle = new Map();
  for (const offer of Array.isArray(offers) ? offers : []) {
    const key = slugifyTitle(offer?.title || '');
    if (key && offer.external_id && !byTitle.has(key)) byTitle.set(key, offer.external_id);
  }
  return byTitle;
}

/**
 * Post one batch of captures. Returns what the portal applied, and whether it accepted them.
 * A 413 is retried as two smaller requests before it is treated as a failure.
 */
async function postCaptureChunk({ chunk, externalByTitle, runId }) {
  const payload = chunk.map((capture) => ({
    ...capture,
    // The server matches a capture to an offer by external id first, title second. Sending the
    // id the portal already knows removes the guesswork — and the description path needs it.
    externalId: capture.externalId || externalByTitle.get(slugifyTitle(capture.title || '')) || null
  }));

  console.error(`posting ${payload.length} capture(s) to the portal`);
  const res = await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runId)}/result`, {
    captures: payload,
    // `batch`, not `cards`: this request carries a slice of the run, and the number of cards the
    // listing actually held went out on `/progress`. A field named `cards` holding 15 would have
    // been a number invented by the paging, which is the mistake this file keeps having to undo.
    listing: { limit, batch: payload.length }
  });

  if (!res.ok) {
    if (res.status === 413 && chunk.length > 1) {
      // Too big even for the agent ceiling: halve it rather than lose the batch.
      const half = Math.ceil(chunk.length / 2);
      console.error(`portal asked for a smaller request (413) — splitting ${chunk.length} into ${half} + ${chunk.length - half}`);
      const first = await postCaptureChunk({ chunk: chunk.slice(0, half), externalByTitle, runId });
      const second = await postCaptureChunk({ chunk: chunk.slice(half), externalByTitle, runId });
      return {
        ok: first.ok && second.ok,
        applied: first.applied + second.applied,
        linksUpdated: first.linksUpdated + second.linksUpdated,
        descriptionsUpdated: first.descriptionsUpdated + second.descriptionsUpdated
      };
    }
    console.error(`the portal refused the result (${res.status}): ${res.data?.error || 'no message'}`);
    return { ok: false, applied: 0, linksUpdated: 0, descriptionsUpdated: 0 };
  }

  const applied = res.data?.applied || {};
  const existing = applied.existing || {};
  console.error(
    `portal applied: ${applied.inserted || 0} imported · ${existing.linksUpdated || 0} links attached · `
    + `${existing.descriptionsUpdated || 0} descriptions filled`
  );
  if (Array.isArray(existing.linkSkipped) && existing.linkSkipped.length) {
    const reasons = [...new Set(existing.linkSkipped.map((row) => row.reason))].join(', ');
    console.error(`${existing.linkSkipped.length} link(s) not attached (${reasons})`);
    // Name the first few with what the server actually saw. A hundred identical reason strings
    // cannot be acted on; one resolved title can — it says whether the link hit a login page, a
    // redirect, or genuinely a different role.
    for (const row of existing.linkSkipped.slice(0, 3)) {
      if (!row.resolvedTitle) continue;
      console.error(`  refused "${row.title}" — the link resolved to "${row.resolvedTitle}"${row.detail ? ` (${row.detail})` : ''}`);
    }
  }
  return {
    ok: true,
    applied: applied.inserted || 0,
    linksUpdated: existing.linksUpdated || 0,
    descriptionsUpdated: existing.descriptionsUpdated || 0
  };
}

/**
 * Post everything captured since the last successful post, in chunks.
 *
 * `from` is the resume point: a batch that fails does not advance it, so the next flush retries
 * exactly those captures instead of the whole run.
 */
async function postNewCaptures({ captures, offers, from = 0 }) {
  const externalByTitle = externalIdMap(offers);
  const runId = String(runState.runId || runIdFlag);
  let index = from;
  const totals = { ok: true, applied: 0, linksUpdated: 0, descriptionsUpdated: 0 };
  while (index < captures.length) {
    const chunk = captures.slice(index, index + AGENT_POST_CHUNK);
    const result = await postCaptureChunk({ chunk, externalByTitle, runId });
    if (!result.ok) return { ...totals, ok: false, posted: index };
    totals.applied += result.applied;
    totals.linksUpdated += result.linksUpdated;
    totals.descriptionsUpdated += result.descriptionsUpdated;
    index += chunk.length;
  }
  return { ...totals, posted: index };
}

async function main() {
  const { supabase, tenantRow, offers, identity = null } = await loadTenantContext();
  console.error(`tenant=${tenantRow.slug} offers=${offers.length}`);
  await startRunTracking(supabase, tenantRow);

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
    captures = await runCapture({
      existing: prior,
      supabase,
      identity,
      // Batches arrive at the portal while the run is still going; the final flush below sends
      // the remainder, and `/finish` closes the run once. `postedCount` is the resume point, so a
      // failed batch is retried as itself rather than re-sending the whole run.
      onBatch: agentMode ? async (so_far) => {
        const result = await postNewCaptures({ captures: so_far, offers, from: postedCount });
        if (result.ok) postedCount = result.posted;
        return result.ok;
      } : null
    });
  }

  // Agent mode ends here: the portal verifies and writes. Everything below reads and writes the
  // database directly, which this machine must never do.
  if (agentMode) {
    const flush = await postNewCaptures({ captures, offers, from: postedCount });
    if (flush.ok) postedCount = flush.posted;
    const written = flush.linksUpdated + flush.descriptionsUpdated + flush.applied;
    await finishRunTracking({
      // "partial" when links were minted but the last batch did not land: neither success nor a
      // clean failure, and saying either would hide the number that matters.
      status: flush.ok ? (captures.length ? 'succeeded' : 'failed') : (written ? 'partial' : 'failed'),
      message: flush.ok
        ? `${captures.length} captured · ${runState.ok} with a link`
        : `${captures.length} captured, ${postedCount} posted before the portal refused the rest`,
      detail: { captured: captures.length, links: runState.ok, posted: postedCount, written }
    });
    process.exitCode = flush.ok ? 0 : 1;
    return;
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

  // Job bodies: replace the card's one-line summary with the real description.
  // Planning is pure (enrichment.js) so the same rule serves every marketplace.
  const { updates: descriptionUpdates, skipped: descriptionSkipped } = planDescriptionUpdates({ captures, offers });
  if (descriptionUpdates.length) {
    console.error(`${descriptionUpdates.length} description(s) can be replaced with the full job text`);
  }
  if (descriptionSkipped.length) {
    const unmatched = descriptionSkipped.filter((row) => row.reason === 'no_offer_for_role').length;
    if (unmatched) console.error(`${unmatched} captured role(s) have no offer yet — imported separately`);
  }

  const report = {
    tenant: tenantRow.slug,
    mode: fromFile ? 'from_file' : 'capture',
    requested: fromFile ? null : { skip, limit },
    captured: captures.length,
    withLink: captures.filter((row) => row && row.referralUrl).length,
    verified: verifyLinks ? { checked: verification.length, match: verification.filter((v) => v.verdict === 'match').length } : 'skipped',
    descriptions: {
      planned: descriptionUpdates.length,
      samples: descriptionUpdates.slice(0, 5).map((u) => ({ title: u.title, from: u.from, to: u.to }))
    },
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
    if (descriptionUpdates.length) {
      report.descriptions.applied = await applyDescriptions({ supabase, updates: descriptionUpdates });
    }
    // Re-read so the report describes what the database holds NOW, not what it held at
    // the start of the run. A run that leaves offers on a tile summary says so.
    try {
      const { data: fresh } = await supabase
        .from('opportunities')
        .select('id, title, external_id, description')
        .eq('tenant_id', tenantRow.id);
      const coverage = describeEnrichment(fresh || []);
      report.enrichment = coverage;
      console.error(`descriptions: ${coverage.full}/${coverage.marketplace} marketplace offers have full text (median ${coverage.medianChars} chars), ${coverage.thin} still thin`);
      for (const row of coverage.thinOffers.slice(0, 10)) {
        console.error(`  thin: ${String(row.title).slice(0, 56)} — ${row.chars} chars`);
      }
    } catch (error) {
      console.error(`could not verify descriptions: ${error?.message || error}`);
    }
  } else if (plan.updates.length || descriptionUpdates.length) {
    console.error('plan only — re-run with --apply to attach these links');
  }

  console.log(JSON.stringify(report, null, 2));

  // Closed last, and with the numbers the database was asked to hold rather than the
  // ones the loop hoped for: the portal's history is only worth having if it is true.
  await finishRunTracking({
    message: report.enrichment
      ? `${report.enrichment.full}/${report.enrichment.marketplace} offers with full text, ${report.enrichment.thin} thin`
      : referralCaptureHeadline(plan),
    detail: {
      captured: report.captured,
      withLink: report.withLink,
      applied: report.applied || null,
      descriptions: report.enrichment || null
    }
  });
}

main().catch(async (error) => {
  console.error(redact(error?.message || String(error)));
  if (error?.code) console.error(`code: ${error.code}`);
  // A crashed run must not stay "running" in the portal: it is exactly the state that
  // makes a dead run look alive.
  await finishRunTracking({ status: 'failed', message: String(error?.message || error).slice(0, 300) });
  process.exit(1);
});





