#!/usr/bin/env node

/**
 * Listen for buying intent across the networks the tenant is signed into (2026-11-04)
 *
 * One script, five sites. `--platform` chooses the description in
 * `utils/browserActor/tasks/socialPlatforms.js`; everything else is the same, because the only
 * thing that really differs between LinkedIn and Reddit is where the posts sit in the DOM.
 *
 * Two lessons from the LinkedIn-only version are baked in:
 *
 *   1. **A zero must explain itself.** It reported `0 post(s) on the page` three times and closed
 *      as `succeeded`, which reads exactly like a quiet week. Now every query records the
 *      strategy that matched (or that none did), how many candidate nodes were on the page, the
 *      page title and the first 240 characters of its text, and the run carries that to the
 *      portal — so "LinkedIn changed its markup" is visible without a support session.
 *   2. **Every exit closes the run.** A profile that will not start, a session that is walled, a
 *      context the portal refuses — each one finishes the run with the reason.
 *
 * It reads. It never clicks, replies, connects or messages: a first touch carries the tenant's
 * own name, so the run stops at "here is the post, here is a first line for you to send".
 */
// The tenant bundle has no node_modules: neither dotenv nor supabase may be a hard import.
try { await import('dotenv/config'); } catch { /* not installed: the env already has what it needs */ }
import { createMoreloginClient } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { capturePage, resolveDebugTarget, CdpSession } from '../utils/browserActor/cdp.js';
import { maskEnvId } from '../utils/browserActor/identity.js';
import { deriveRunStatus } from '../utils/browserActor/runs.js';
import {
  classifySocialSession,
  getSocialPlatform,
  socialPaceMs,
  waitMsFor
} from '../utils/browserActor/tasks/socialPlatforms.js';

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
const platformId = String(flag('platform', 'linkedin')).toLowerCase();
const platform = getSocialPlatform(platformId);
const wantQueries = Math.max(1, Math.min(6, Number(flag('queries', 3)) || 3));
const perQuery = Math.max(1, Number(flag('per-query', platform?.maxPostsPerQuery || 10)) || 10);

if (!platform) {
  console.error(`unknown social platform "${platformId}" — expected one of linkedin, x, facebook, reddit, youtube`);
  process.exit(1);
}
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

/** Progress is a heartbeat: a run with no beat is "stalled" to the tenant. */
async function beat(payload) {
  const res = await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runId)}/progress`, payload).catch(() => null);
  if (!res?.ok) console.error(`progress not recorded (${res?.status ?? 'no response'})`);
}

/** Close the run, once. Returns false when the portal refused, so the caller can say so. */
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

/** What the portal wants read. The taxonomy lives server-side, so the list has one home. */
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

/**
 * Read the page until it has posts, or until waiting stops being honest.
 *
 * Search pages hydrate late: the first pass sees the global navigation and nothing else, which is
 * exactly what a *changed DOM* looks like. So this waits on a real budget per network, scrolls
 * progressively (result lists render beyond the first screen), and — if a page is still empty
 * after the whole budget — reloads once and tries again. A stuck first navigation is common on a
 * freshly started profile and is not the same fault as a selector that moved.
 */
async function readPosts({ host, port }) {
  const startedAt = Date.now();
  const budget = waitMsFor(platform.id);
  let last = null;
  const passes = async (until) => {
    let step = 1;
    while (Date.now() < until) {
      last = await evaluateJson({ host, port, expression: platform.postsExpr });
      if (last && Number(last.count) > 0) return true;
      // Progressive scroll: half a screen, then a screen, then two — enough to trigger the
      // lazy-render of the list without walking to the footer.
      await evaluateJson({ host, port, expression: `window.scrollBy(0, window.innerHeight * ${step}); "ok"` });
      step = Math.min(step + 0.5, 2.5);
      await sleep(1_200);
    }
    return false;
  };

  if (await passes(startedAt + budget)) return { ...last, waitedMs: Date.now() - startedAt };

  // One reload, then half the budget again: a profile that just started often shows a partial
  // page whose own router never fires.
  console.error('  nothing rendered yet — reloading once before giving up');
  await evaluateJson({ host, port, expression: 'location.reload(); "ok"' }).catch(() => {});
  await sleep(2_500);
  const retriedAt = Date.now();
  await passes(retriedAt + Math.min(30_000, Math.round(budget / 2)));
  return { ...(last || { ok: true, count: 0, posts: [], strategy: null, candidates: 0 }), waitedMs: Date.now() - startedAt };
}

async function readSession({ host, port }) {
  const snapshot = await evaluateJson({ host, port, expression: platform.sessionExpr }).catch(() => null);
  return { snapshot, state: classifySocialSession(snapshot) };
}

/**
 * A zero-post page, described well enough to fix without a support session.
 *
 * `strategy: null` means none of the candidate selectors matched — the markup moved. A strategy
 * with `candidates > 0` but `count: 0` means the cards are there and the text or link selectors
 * are not, which is a different repair. `bodyStart` is the page's own words, so the tenant can see
 * whether they were shown a wall, a consent sheet, or genuinely nothing.
 */
function diagnose(page, session, phrase) {
  return {
    phrase,
    strategy: page?.strategy || null,
    candidates: Number(page?.candidates) || 0,
    // How long we actually waited before declaring the page empty: a page that gave up after 2s
    // is a bug in the wait; one that waited 90s is a page that genuinely has nothing.
    waitedMs: Number(page?.waitedMs) || 0,
    title: String(page?.title || '').slice(0, 120),
    url: String(page?.url || '').slice(0, 300),
    session: session?.state || 'unknown',
    bodyStart: String(page?.bodyStart || '').slice(0, 200)
  };
}

/** Post raw posts to the portal, fifteen at a time, splitting a 413 rather than losing it. */
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

/**
 * Walk the searches, banking each page as it is read.
 *
 * A page that yields nothing is not a failure — it is the normal case on a quiet network — but it
 * is recorded, because "no markup matched" and "nobody posted" must not look the same.
 */
async function readAllSearches({ host, port, queries, collected, unsent, diagnostics }) {
  const seen = new Set();
  let read = 0;
  let failed = 0;
  let empty = 0;

  for (const [index, query] of queries.entries()) {
    const url = platform.searchUrl(query.phrase);
    console.error(`[${index + 1}/${queries.length}] "${query.phrase}" (${query.intentId})`);
    try {
      await capturePage({ host, port, url, timeoutMs: 45_000 });
      let session = await readSession({ host, port });
      const page = await readPosts({ host, port });
      // A page that was still hydrating answers "unknown" the first time. Ask again once it has
      // settled, so the diagnosis names a wall or a cookie sheet rather than shrugging.
      if (session.state === 'unknown') session = await readSession({ host, port });
      const posts = Array.isArray(page?.posts) ? page.posts.slice(0, perQuery) : [];
      let added = 0;
      for (const post of posts) {
        const key = String(post.postUrl || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        collected.push({ ...post, platform: platform.id });
        unsent.push({ ...post, platform: platform.id });
        added += 1;
      }
      read += 1;
      const label = page?.strategy ? `via ${page.strategy}` : 'no card selector matched';
      console.error(`  ${posts.length}/${page?.candidates ?? 0} candidate card(s) read ${label} after ${(Math.round((page?.waitedMs || 0) / 100) / 10)}s · ${added} new`);

      if (!posts.length) {
        empty += 1;
        const d = diagnose(page, session, query.phrase);
        diagnostics.push(d);
        console.error(`  nothing after ${Math.round(d.waitedMs / 1000)}s · session=${d.session} · title="${d.title}" · page says: "${d.bodyStart.slice(0, 90)}"`);
      }

      // Bank what we have, every search: a machine that sleeps at search five must not lose four.
      if (unsent.length) {
        const posted = await postPosts({ posts: unsent });
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
      console.error(`  search failed: ${error?.message || error}`);
      await beat({
        done: read + failed,
        ok: read,
        failed,
        total: queries.length,
        message: `search failed: ${String(error?.message || error).slice(0, 120)}`
      });
    }

    // Human pace, jittered, from the platform's own budget.
    if (index < queries.length - 1) {
      const pause = socialPaceMs(platform.pace);
      console.error(`  waiting ${Math.round(pause / 1000)}s before the next search`);
      await sleep(pause);
    }
  }

  return { read, failed, empty };
}

async function main() {
  let context;
  try {
    context = await loadContext();
  } catch (error) {
    console.error(`context refused: ${error.message}`);
    await finishOnce({ status: 'failed', message: String(error.message).slice(0, 300) });
    throw error;
  }

  const identity = context.identity || {};
  const tenantSlug = context.tenant?.slug || tenantFlag || '(unknown)';
  const queries = (Array.isArray(context.queries) ? context.queries : []).slice(0, wantQueries);
  const portalPlatform = String(context.run?.platform || '').toLowerCase();
  console.error(`listen: tenant=${tenantSlug} platform=${platform.id} profile=${maskEnvId(identity.envId)} queries=${queries.length}`);
  // If the portal thinks this run belongs to another network, stop. Driving LinkedIn on behalf of
  // a YouTube run writes signals that no one asked for, under the wrong name in the digest.
  if (portalPlatform && portalPlatform !== platform.id) {
    const message = `this run is for ${portalPlatform}, but the worker started the ${platform.id} listener — `
      + 'press Start again from the portal (and close any other worker window)';
    console.error(message);
    await finishOnce({ status: 'failed', message: message.slice(0, 300), detail: { platform: platform.id, portalPlatform, mismatch: true } });
    process.exitCode = 1;
    return;
  }
  if (!queries.length) {
    await finishOnce({
      status: 'failed',
      message: 'the portal sent no searches — the intent taxonomy is missing or empty',
      detail: { platform: platform.id, queries: 0 }
    });
    process.exitCode = 1;
    return;
  }

  const runtime = createBrowserRuntime({ client: createMoreloginClient({}) });

  // Starting the profile throws rather than returning. On 2026-11-04 an uncaught throw here left a
  // run "running" until the tenant cancelled it, which also threw the reason away.
  let started;
  try {
    started = await runtime.startProfile(identity.envId, {
      runtime: identity.runtime || 'local',
      // Headless by default: the tenant is not watching this run, and a window that steals focus
      // while they work is a reason to close the worker. `--headful` exists for a profile that
      // refuses to render without a visible window.
      headless: flag('headful', null) === null
    });
  } catch (error) {
    const message = `the profile would not start: ${error?.message || error}`;
    console.error(message);
    await finishOnce({
      status: 'failed',
      message: message.slice(0, 300),
      detail: { platform: platform.id, stage: 'profile_start', code: error?.code || null }
    });
    process.exitCode = 1;
    return;
  }
  if (!started.debugPort) {
    await finishOnce({ status: 'failed', message: 'the profile started but returned no debug port', detail: { platform: platform.id } });
    console.error('profile not ready — nothing was read');
    process.exitCode = 1;
    return;
  }

  const host = started.host;
  const port = started.debugPort;
  console.error(`profile=…${String(identity.envId).slice(-6)} port=${port}`);

  // Is the tenant still signed in? A logged-out search renders an empty page, which is
  // indistinguishable from "nobody is talking about this" — the exact lie this check prevents.
  await capturePage({ host, port, url: platform.homeUrl, timeoutMs: 45_000 }).catch((error) => {
    console.error(`could not open ${platform.name}: ${error?.message || error}`);
  });
  const session = await readSession({ host, port });
  console.error(`session: ${session.state}${session.snapshot?.consent ? ' (consent sheet)' : ''}`);
  if (session.state === 'login_wall') {
    await finishOnce({
      status: 'failed',
      message: `${platform.name} is signed out in this profile — sign in inside MoreLogin, then run again`,
      detail: { platform: platform.id, reauthRequired: true }
    });
    process.exitCode = 1;
    return;
  }
  if (session.state === 'consent_wall') {
    // Nothing here clicks a consent button on the tenant's behalf: that is a decision about their
    // own account. Say it plainly and let them clear it once, by hand.
    await finishOnce({
      status: 'failed',
      message: `${platform.name} is showing a cookie/consent sheet in this profile — accept it once in MoreLogin, then run again`,
      detail: { platform: platform.id, consentRequired: true }
    });
    process.exitCode = 1;
    return;
  }

  const collected = [];
  /** Posts the portal has not accepted yet. Spliced only by what actually landed. */
  const unsent = [];
  const diagnostics = [];
  const { read, failed, empty } = await readAllSearches({ host, port, queries, collected, unsent, diagnostics });

  // A run that read every search and found nothing is still a *successful* run: the browser did
  // its job. It is only a failure when a search could not be read at all.
  const status = deriveRunStatus({ done: read + failed, ok: read, failed, total: queries.length });
  const summary = `${read}/${queries.length} searches read · ${collected.length} post(s) sent for scoring`
    + (empty ? ` · ${empty} page(s) had nothing` : '')
    + (failed ? ` · ${failed} failed` : '');
  await finishOnce({
    status,
    done: read + failed,
    ok: read,
    failed,
    total: queries.length,
    message: summary.slice(0, 300),
    detail: {
      platform: platform.id,
      queries: queries.length,
      posts: collected.length,
      read,
      empty,
      unsent: unsent.length,
      // Only when something came back empty: the evidence that turns "0 posts" into a fix.
      diagnostics: diagnostics.slice(0, 6)
    }
  });
  console.error(`listen finished: ${summary} · ${status}`);
  process.exitCode = status === 'failed' ? 1 : 0;
}

main().catch(async (error) => {
  console.error(`listen failed: ${error?.message || error}`);
  if (error?.status) console.error(`  the portal answered ${error.status}`);
  // Last resort: a run left in `running` is worse than a failed run — the tenant cannot start
  // another and learns nothing.
  await finishOnce({ status: 'failed', message: String(error?.message || error).slice(0, 300) }).catch(() => {});
  process.exitCode = 1;
});



