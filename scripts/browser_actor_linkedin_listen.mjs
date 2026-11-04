#!/usr/bin/env node

/**
 * Listen for buying intent on the tenant's own LinkedIn (2026-11-04)
 *
 * The taxonomy, the scorer and the outreach templates already existed in the ABOSS pipeline. The
 * missing half was always the same: nothing read the posts, so
 * `data/ABOSS_SOCIAL_SIGNALS_RAW.csv` stayed a header row. This script is the eyes.
 *
 * What it does — and only this:
 *
 *   1. asks the portal which searches to run (the taxonomy stays server-side, one source);
 *   2. opens each search in the tenant's own signed-in profile and reads the posts;
 *   3. posts the raw text back to `/api/agent/runs/:id/signals`.
 *
 * It does not score, store, connect, message, or hold a database key. Scoring is server-side so a
 * worker cannot rank a tenant's prospects; sending stays with a human because a first touch
 * carries their name.
 *
 *   node scripts/browser_actor_linkedin_listen.mjs --agent-api https://alphadome.onrender.com \
 *     --run-id <uuid> --queries 3 --per-query 10
 *
 * The worker passes TENANT_WORKER_TOKEN through the environment, so no credential is in argv.
 *
 * **Every exit closes the run.** A child that dies silently leaves the portal showing "running"
 * until the tenant cancels, and the cancel throws away a run that had already reported the fault.
 * `finishOnce` below is the single door out, and `main().catch` uses it too.
 */
// The tenant bundle has no node_modules: neither dotenv nor supabase may be a hard import.
try { await import('dotenv/config'); } catch { /* not installed: the env already has what it needs */ }
import { createMoreloginClient } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { capturePage, resolveDebugTarget, CdpSession } from '../utils/browserActor/cdp.js';
import { maskEnvId } from '../utils/browserActor/identity.js';
import { deriveRunStatus } from '../utils/browserActor/runs.js';
import {
  LINKEDIN_MAX_POSTS_PER_QUERY,
  LINKEDIN_PLATFORM,
  LINKEDIN_POSTS_EXPR,
  LINKEDIN_SESSION_EXPR,
  classifyLinkedInSession,
  linkedInPaceMs,
  linkedInSearchUrl
} from '../utils/browserActor/tasks/linkedinListen.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

const agentApi = String(flag('agent-api', process.env.ALPHADOME_API || '')).replace(/\/+$/, '');
const agentToken = String(flag('agent-token', process.env.TENANT_WORKER_TOKEN || ''));
const runId = flag('run-id');
const tenantFlag = flag('tenant');
const wantQueries = Math.max(1, Math.min(6, Number(flag('queries', 3)) || 3));
const perQuery = Math.max(1, Math.min(LINKEDIN_MAX_POSTS_PER_QUERY, Number(flag('per-query', 10)) || 10));

if (!agentApi || !agentToken) {
  console.error('this listener only runs from the tenant worker: --agent-api <portal> and TENANT_WORKER_TOKEN');
  process.exit(1);
}
if (!runId) {
  console.error('--run-id is required: the portal decides which run this worker is executing');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the portal already knows this run is over. Nothing may close it twice. */
let runClosed = false;

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

/** Report progress; a failure here must not end the run — the run row is the tenant's only view. */
async function beat(payload) {
  const res = await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runId)}/progress`, payload).catch(() => null);
  if (!res?.ok) console.error(`progress not recorded (${res?.status ?? 'no response'})`);
}

/**
 * Close the run, once.
 *
 * Returns false when the portal refused, so the caller can say so in the worker window instead of
 * assuming the run is closed.
 */
async function finishOnce(payload) {
  if (runClosed) return true;
  const res = await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runId)}/finish`, payload).catch(() => null);
  if (!res?.ok) {
    console.error(`could not close the run (${res?.status ?? 'no response'}): ${res?.data?.error || 'no message'}`);
    return false;
  }
  runClosed = true;
  return true;
}

/**
 * Fetch what the portal wants read.
 *
 * The searches come from the taxonomy, which lives on the server: a bundled copy would drift, and
 * the day it drifts the tenant is scored against yesterday's intent list.
 */
async function loadContext() {
  const res = await agentCall('GET', `/api/agent/runs/${encodeURIComponent(runId)}/context`);
  if (!res.ok) {
    const error = new Error(res.data?.error || `the portal refused this run (${res.status})`);
    error.code = 'agent_context_refused';
    error.status = res.status;
    throw error;
  }
  return res.data;
}

// ── CDP plumbing ───────────────────────────────────────────────────────────────
// One session for the whole run: every evaluate that reopens a socket also re-resolves the
// target over HTTP, and six queries × several evaluates of that is what made a 72-role capture
// time out at role 43.

let sharedSession = null;

async function ensureSession({ host, port }) {
  if (sharedSession) return sharedSession;
  const target = await resolveDebugTarget({ host, port });
  if (!target.pageWsUrl) throw new Error('the profile started but exposes no page to drive');
  sharedSession = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  return sharedSession;
}

async function evaluateJson({ host, port, expression }) {
  let session = await ensureSession({ host, port });
  let result;
  try {
    result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 30_000 });
  } catch {
    // A dead socket is common on a long run (the page reloads, the profile sleeps). Reconnect
    // once before giving up on the query.
    sharedSession = null;
    session = await ensureSession({ host, port });
    result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 30_000 });
  }
  const value = result?.result?.value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Wait until the page has rendered something we recognise, or give up honestly. */
async function waitForPosts({ host, port, maxMs = 15_000 }) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < maxMs) {
    last = await evaluateJson({ host, port, expression: LINKEDIN_POSTS_EXPR });
    if (last && Number(last.count) > 0) return last;
    // Lazy content on a search page needs one nudge; a scroll is the least invasive nudge.
    await evaluateJson({ host, port, expression: 'window.scrollBy(0, window.innerHeight * 0.9); "ok"' });
    await sleep(1_200);
  }
  return last || { ok: true, count: 0, posts: [] };
}

async function readSession({ host, port }) {
  const snapshot = await evaluateJson({ host, port, expression: LINKEDIN_SESSION_EXPR }).catch(() => null);
  return { snapshot, state: classifyLinkedInSession(snapshot) };
}

/**
 * Post raw posts to the portal, fifteen at a time.
 *
 * Same lesson as the referral capture on 2026-11-04: a request that grows with the run eventually
 * hits a body limit, and a 413 must split the chunk rather than lose the posts in it.
 */
async function postPosts({ posts }) {
  const CHUNK = 15;
  let index = 0;
  let stored = 0;
  let duplicates = 0;
  while (index < posts.length) {
    const chunk = posts.slice(index, index + CHUNK);
    const res = await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runId)}/signals`, { posts: chunk });
    if (!res.ok) {
      if (res.status === 413 && chunk.length > 1) {
        const half = Math.ceil(chunk.length / 2);
        console.error(`the portal asked for a smaller request (413) — splitting ${chunk.length} into ${half} + ${chunk.length - half}`);
        const first = await postPosts({ posts: chunk.slice(0, half) });
        const second = await postPosts({ posts: chunk.slice(half) });
        stored += first.stored + second.stored;
        duplicates += first.duplicates + second.duplicates;
        index += chunk.length;
        continue;
      }
      console.error(`the portal refused ${chunk.length} post(s) (${res.status}): ${res.data?.error || 'no message'}`);
      return { ok: false, stored, duplicates, posted: index };
    }
    const dropped = res.data?.dropped || {};
    console.error(`portal stored ${res.data?.stored ?? 0} signal(s) · ${res.data?.duplicates ?? 0} already known · ${dropped.excluded ?? 0} excluded · ${dropped.notRelevant ?? 0} off-topic`);
    stored += Number(res.data?.stored) || 0;
    duplicates += Number(res.data?.duplicates) || 0;
    index += chunk.length;
  }
  return { ok: true, stored, duplicates, posted: index };
}

// ── main ──────────────────────────────────────────────────────────────────────

/** Collect the searches' posts, banking each page as it is read. */
async function readAllSearches({ host, port, queries, collected, unsent }) {
  const seen = new Set();
  let read = 0;
  let failed = 0;

  for (const [index, query] of queries.entries()) {
    const url = linkedInSearchUrl(query.phrase);
    console.error(`[${index + 1}/${queries.length}] "${query.phrase}" (${query.intentId})`);
    try {
      await capturePage({ host, port, url, timeoutMs: 45_000 });
      const page = await waitForPosts({ host, port });
      const posts = Array.isArray(page?.posts) ? page.posts.slice(0, perQuery) : [];
      let added = 0;
      for (const post of posts) {
        const key = String(post.postUrl || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        collected.push(post);
        unsent.push(post);
        added += 1;
      }
      read += 1;
      console.error(`  ${posts.length} post(s) on the page · ${added} new`);

      // Bank what we have, every query: a machine that sleeps at query five must not lose four.
      if (unsent.length) {
        const posted = await postPosts({ posts: unsent });
        // Only the accepted prefix is dropped: what did not land is retried by the next flush.
        if (posted.posted) unsent.splice(0, posted.posted);
        if (!posted.ok) console.error(`  ${unsent.length} post(s) still unsent — the next search retries them`);
      }
      await beat({
        done: read,
        ok: read,
        failed,
        total: queries.length,
        message: `${read}/${queries.length} searches read · ${collected.length} post(s) seen`
      });
    } catch (error) {
      failed += 1;
      console.error(`  query failed: ${error?.message || error}`);
      await beat({
        done: read + failed,
        ok: read,
        failed,
        total: queries.length,
        message: `search failed: ${String(error?.message || error).slice(0, 120)}`
      });
    }

    // Human pace, jittered. A fixed interval is the clearest machine signature there is.
    if (index < queries.length - 1) {
      const pause = linkedInPaceMs();
      console.error(`  waiting ${Math.round(pause / 1000)}s before the next search`);
      await sleep(pause);
    }
  }

  return { read, failed };
}

async function main() {
  let context;
  try {
    context = await loadContext();
  } catch (error) {
    // Claimed before the context is asked for, so this path owns a run id and must close it.
    console.error(`context refused: ${error.message}`);
    await finishOnce({ status: 'failed', message: String(error.message).slice(0, 300) });
    throw error;
  }

  const identity = context.identity || {};
  const tenantSlug = context.tenant?.slug || tenantFlag || '(unknown)';
  const queries = (Array.isArray(context.queries) ? context.queries : []).slice(0, wantQueries);
  console.error(`listen: tenant=${tenantSlug} profile=${maskEnvId(identity.envId)} queries=${queries.length}`);
  if (!queries.length) {
    await finishOnce({
      status: 'failed',
      message: 'the portal sent no searches — the intent taxonomy is missing or empty',
      detail: { queries: 0 }
    });
    process.exitCode = 1;
    return;
  }

  const runtime = createBrowserRuntime({ client: createMoreloginClient({}) });

  // Starting the profile is where this run actually dies, and it **throws** rather than
  // returning. On 2026-11-04 that exception escaped and no `/finish` was ever sent, so the portal
  // showed "running" until the tenant cancelled — throwing away a run that had already told us
  // exactly what was wrong.
  let started;
  try {
    started = await runtime.startProfile(identity.envId, {
      runtime: identity.runtime || 'local',
      // Headless by default, like the captures: the tenant is not watching this run, and a window
      // that steals focus while they work is a reason to close the worker. `--headful` exists for
      // the day a profile refuses to render without a visible window.
      headless: flag('headful', null) === null
    });
  } catch (error) {
    const message = `the profile would not start: ${error?.message || error}`;
    console.error(message);
    await finishOnce({
      status: 'failed',
      message: message.slice(0, 300),
      detail: { stage: 'profile_start', code: error?.code || null }
    });
    process.exitCode = 1;
    return;
  }
  if (!started.debugPort) {
    await finishOnce({ status: 'failed', message: 'the profile started but returned no debug port' });
    console.error('profile not ready — nothing was read');
    process.exitCode = 1;
    return;
  }

  const host = started.host;
  const port = started.debugPort;
  console.error(`profile=…${String(identity.envId).slice(-6)} port=${port}`);

  // Is the tenant still signed in? A logged-out search renders an empty page, which is
  // indistinguishable from "nobody is talking about this" — the exact lie this check prevents.
  await capturePage({ host, port, url: LINKEDIN_PLATFORM.feedUrl, timeoutMs: 45_000 }).catch((error) => {
    console.error(`could not open LinkedIn: ${error?.message || error}`);
  });
  const session = await readSession({ host, port });
  console.error(`session: ${session.state}${session.snapshot?.wall ? ' (login wall)' : ''}`);
  if (session.state === 'login_wall') {
    await finishOnce({
      status: 'failed',
      message: 'LinkedIn is signed out in this profile — sign in inside MoreLogin, then run again',
      detail: { reauthRequired: true, platform: 'linkedin' }
    });
    process.exitCode = 1;
    return;
  }

  const collected = [];
  /** Posts the portal has not accepted yet. Spliced only by what actually landed. */
  const unsent = [];
  const { read, failed } = await readAllSearches({ host, port, queries, collected, unsent });

  const status = deriveRunStatus({ done: read + failed, ok: read, failed, total: queries.length });
  await finishOnce({
    status,
    done: read + failed,
    ok: read,
    failed,
    total: queries.length,
    message: `${read}/${queries.length} searches read · ${collected.length} post(s) sent for scoring${failed ? ` · ${failed} failed` : ''}`.slice(0, 300),
    detail: { platform: 'linkedin', queries: queries.length, posts: collected.length, read, unsent: unsent.length }
  });
  console.error(`listen finished: ${read}/${queries.length} searches · ${collected.length} post(s) · ${status}`);
  process.exitCode = status === 'failed' ? 1 : 0;
}

main().catch(async (error) => {
  console.error(`listen failed: ${error?.message || error}`);
  if (error?.status) console.error(`  the portal answered ${error.status}`);
  // Last resort: if nothing closed the run, close it now with the reason we have. A run left in
  // `running` is worse than a failed run — the tenant cannot start another and learns nothing.
  await finishOnce({ status: 'failed', message: String(error?.message || error).slice(0, 300) }).catch(() => {});
  process.exitCode = 1;
});



