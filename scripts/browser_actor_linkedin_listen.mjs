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
 * It does not score, does not store, does not connect, does not message, and holds no database
 * key. Scoring is server-side so a worker cannot rank a tenant's prospects; sending stays with a
 * human because a first touch carries their name.
 *
 *   node scripts/browser_actor_linkedin_listen.mjs --agent-api https://alphadome.onrender.com \
 *     --run-id <uuid> --queries 3 --per-query 10
 *
 * The worker passes TENANT_WORKER_TOKEN through the environment, so no credential is in argv.
 */
// The tenant bundle has no node_modules: neither dotenv nor supabase may be a hard import.
try { await import('dotenv/config'); } catch { /* not installed: the env already has what it needs */ }
import { createMoreloginClient, redact } from '../utils/browserActor/moreloginClient.js';
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

/** Report progress; a failure here must not end the run, the run row is the tenant's only view. */
async function beat(payload) {
  const res = await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runId)}/progress`, payload).catch(() => null);
  if (!res?.ok) console.error(`progress not recorded (${res?.status ?? 'no response'})`);
}

async function finish(payload) {
  const res = await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runId)}/finish`, payload).catch(() => null);
  if (!res?.ok) console.error(`could not close the run (${res?.status ?? 'no response'}): ${res?.data?.error || 'no message'}`);
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

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  let context;
  try {
    context = await loadContext();
  } catch (error) {
    // Claimed before the context is asked for, so the catch below owns a run id either way.
    console.error(`context refused: ${error.message}`);
    await finish({ status: 'failed', message: error.message.slice(0, 300) }).catch(() => {});
    throw error;
  }

  const identity = context.identity || {};
  const tenantSlug = context.tenant?.slug || tenantFlag || '(unknown)';
  const queries = (Array.isArray(context.queries) ? context.queries : []).slice(0, wantQueries);
  console.error(`listen: tenant=${tenantSlug} profile=${maskEnvId(identity.envId)} queries=${queries.length}`);
  if (!queries.length) {
    await finish({
      status: 'failed',
      message: 'the portal sent no searches — the intent taxonomy is missing or empty',
      detail: { queries: 0 }
    });
    process.exitCode = 1;
    return;
  }

  const runtime = createBrowserRuntime({ client: createMoreloginClient({}) });
  const started = await runtime.startProfile(identity.envId, { runtime: identity.runtime || 'local', headless: true });
  if (!started.debugPort) {
    await finish({ status: 'failed', message: 'the profile started but returned no debug port' });
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
    await finish({
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
        // Only the accepted prefix is dropped: what did not land is retried by the next flush,
        // and reported at the end if it never does.
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
      await beat({ done: read + failed, ok: read, failed, total: queries.length, message: `search failed: ${String(error?.message || error).slice(0, 120)}` });
    }

    // Human pace, jittered. A fixed interval is the clearest machine signature there is.
    if (index < queries.length - 1) {
      const pause = linkedInPaceMs();
      console.error(`  waiting ${Math.round(pause / 1000)}s before the next search`);
      await sleep(pause);
    }
  }

  const status = deriveRunStatus({ done: read + failed, ok: read, failed, total: queries.length });
  await finish({
    status,
    done: read + failed,
    ok: read,
    failed,
    total: queries.length,
    message: `${read}/${queries.length} searches read · ${collected.length} post(s) sent for scoring${failed ? ` · ${failed} failed` : ''}`.slice(0, 300),
    detail: { platform: 'linkedin', queries: queries.length, posts: collected.length, read }
  });
  console.error(`listen finished: ${read}/${queries.length} searches · ${collected.length} post(s) · ${status}`);
  process.exitCode = status === 'failed' ? 1 : 0;
}

main().catch((error) => {
  console.error(`listen failed: ${error?.message || error}`);
  if (error?.status) console.error(`  the portal answered ${error.status}`);
  process.exitCode = 1;
});

    index += chunk.length;
  }
  return { ok: true, stored, duplicates, posted: index };
}
