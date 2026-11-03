#!/usr/bin/env node

/**
 * Micro1 capture (2026-11-02) â€” the first marketplace adapter that is not Turing.
 *
 * What it does, in one pass, as the tenant:
 *   1. reads `refer.micro1.ai/opportunities` cards (h2 title, openings, skills, pay)
 *   2. clicks "Refer and earn $X" per card and reads the share link it yields
 *      (`jobs.micro1.ai/post/<uuid>?referralCode=<account>`)
 *   3. opens each job page and reads the body, because that page is client-rendered
 *   4. verifies every link over HTTP against its job title
 *   5. imports the roles as DRAFT offers with the verified link attached
 *
 * Why this is a separate script rather than a `--platform micro1` branch: the two
 * marketplaces disagree on almost everything that matters. Turing needs a listing
 * rebuild between roles and has no per-role URL; Micro1 never leaves the listing to get
 * a link, and every role has a real job page. Forcing one loop to be both would mean the
 * `if (platform)` branches outnumber the work.
 *
 * Shared, because the rule is shared: identity/lease, `planOfferImport` (dedupe,
 * tenant-scoped slugs, drafts only), `verifyReferralLink` (a link is only written if it
 * provably lands on its role), and run tracking.
 *
 * Usage:
 *   node scripts/browser_actor_micro1.mjs --tenant malingu-ventures --limit 12
 *   node scripts/browser_actor_micro1.mjs --tenant malingu-ventures --limit 12 --apply
 *   ... --no-descriptions      skip the job-page pass (links only, much faster)
 *   ... --run-id <uuid>        report progress into browser_actor_runs for the portal
 *
 * **Agent mode** — `--agent-api <portal> --agent-token wkr_…` — is how this same file runs on
 * a *tenant's* machine, where there is no `.env` and must be no database credentials:
 *
 *   - the tenant, its profile and its existing offers are fetched from the portal with the
 *     worker token (`GET /api/agent/runs/:id/context`);
 *   - the captures are posted back (`POST /api/agent/runs/:id/result`) and the **server**
 *     writes the offers.
 *
 * That is why `dotenv` and `@supabase/supabase-js` are imported lazily: the tenant bundle
 * installs nothing, and a machine holding a `wkr_` token can never hold a service-role key.
 */
// Operator convenience only. The tenant bundle has no node_modules, so this must not be a
// hard import — a missing dotenv is not an error, it just means the shell supplies the env.
try { await import('dotenv/config'); } catch { /* not installed */ }
import fs from 'node:fs';
import path from 'node:path';
import { createMoreloginClient, redact } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { capturePage, resolveDebugTarget, CdpSession } from '../utils/browserActor/cdp.js';
import { maskEnvId } from '../utils/browserActor/identity.js';
import { resolveRunnerIdentity } from '../utils/tenantRunnerIdentity.js';
import { applyCaptures, readCoverage } from '../utils/browserActor/applyCaptures.js';
import { createRunStore, deriveRunStatus } from '../utils/browserActor/runs.js';
import {
  MICRO1_PLATFORM,
  MICRO1_LIST_COUNT_EXPR,
  MICRO1_LIST_EXPR,
  MICRO1_READ_REFERRAL_EXPR,
  MICRO1_CLOSE_DIALOGS_EXPR,
  MICRO1_DETAIL_CONTENT_EXPR,
  micro1JobUrl,
  micro1OpenReferralExpr,
  normalizeMicro1Item,
  pickMicro1ReferralUrl,
  planMicro1Window,
  mergeMicro1Pages,
  MICRO1_ADVANCE_EXPR
} from '../utils/browserActor/tasks/micro1.js';
import { classifyProviderFailure } from '../utils/browserActor/errors.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

const tenant = flag('tenant');
// Twelve was a page of cards, not a decision: the grid shows twelve and the runner stopped
// there, so a tenant who owns a MoreLogin start spent it on 12 roles. A page has to be worth
// the start, so the default now spans several pages and the listing is paged to fill it.
const limit = Number(flag('limit', 70)) || 0;
const MAX_LIST_PAGES = 12;
const skip = Number(flag('skip', 0)) || 0;
const pace = Number(flag('pace', 900)) || 900;
const apply = flag('apply', null) !== null;
const withDescriptions = flag('no-descriptions', null) === null;
// Skip roles this tenant already has. One start per day is expensive; spending it on
// offers that already exist is worse than useless.
const onlyMissing = flag('only-missing', null) !== null;

const outPath = path.resolve(String(flag('out', 'tmp/micro1.json')));
const runIdFlag = flag('run-id');

// Agent mode: running on the tenant's own machine with nothing but a worker token.
const agentApi = String(flag('agent-api', process.env.ALPHADOME_API || '')).replace(/\/+$/, '');
const agentToken = String(flag('agent-token', process.env.TENANT_WORKER_TOKEN || ''));
const agentMode = Boolean(agentApi && agentToken);

if (!tenant) {
  console.error('usage: --tenant <slug> [--limit 12] [--skip 0] [--apply] [--only-missing] [--no-descriptions] [--out tmp/micro1.json]');
  console.error('   or: --agent-api <portal> --agent-token wkr_… --run-id <uuid>   (tenant worker; no database needed)');
  process.exit(1);
}
if (agentMode && !runIdFlag) {
  console.error('agent mode needs --run-id: the portal decides which tenant and which profile this run uses');
  process.exit(1);
}
if (limit <= 0) {
  console.error('--limit must be a positive number of roles to read');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The only way this process talks to the portal in agent mode.
 *
 * The token is the tenant's, so `tenant` from the URL/body is never trusted here: the server
 * resolves the tenant from the token and refuses anything that is not theirs.
 */
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

/** One CDP session for the whole run: a session survives navigation, a socket does not. */
let sharedSession = null;

async function ensureSession({ host, port }) {
  if (sharedSession && !sharedSession.closed) return sharedSession;
  const target = await resolveDebugTarget({ host, port });
  if (!target.pageWsUrl) throw new Error('the profile exposed no page target');
  sharedSession = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  return sharedSession;
}

async function evaluateJson({ host, port, expression }) {
  let session = await ensureSession({ host, port });
  try {
    const result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 30_000 });
    const raw = result?.result?.value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    // A session can die with the page. Rebuild it once rather than failing the run.
    sharedSession = null;
    session = await ensureSession({ host, port });
    const result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 30_000 });
    const raw = result?.result?.value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
}

/**
 * Wait until the listing is *ready*, not merely present.
 *
 * A skeleton grid satisfies "there is a grid with children", which is how a run once read
 * six placeholder cards and captured nothing. Ready means: at least three cards carry an
 * `h2` title and no `.animate-pulse` remains.
 */
async function waitForListing({ host, port, maxMs = 30_000 }) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < maxMs) {
    last = await evaluateJson({ host, port, expression: MICRO1_LIST_COUNT_EXPR });
    const ready = last?.ok && Number(last.titled) >= 3 && Number(last.pulse) === 0;
    if (ready) return { ...last, waitedMs: Date.now() - startedAt, ready: true };
    await sleep(500);
  }
  return { ...(last || { ok: false, count: 0 }), waitedMs: Date.now() - startedAt, ready: false, timedOut: true };
}


async function loadSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SB_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SB_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing Supabase credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');
    console.error('On a tenant machine use agent mode instead: --agent-api <portal> --agent-token wkr_… --run-id <uuid>');
    process.exit(1);
  }
  // Loaded here, not at the top: the tenant bundle has no node_modules and must not need one.
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

/**
 * Everything this run may touch.
 *
 * In agent mode that is what the **portal** says, over the worker token: the tenant, the
 * profile to drive, and the titles this tenant already owns (so `--only-missing` works
 * without a database). No key is returned — a local `ml-cli` profile is driven through the
 * MoreLogin client already signed in on that machine.
 */
async function loadTenantContext() {
  if (agentMode) {
    const res = await agentCall('GET', `/api/agent/runs/${encodeURIComponent(String(runIdFlag))}/context`);
    if (!res.ok) {
      // Thrown, not process.exit: the caller's catch closes the run as failed. Exiting here
      // is what left a claimed run "running" for ever and blocked the tenant's next capture.
      const error = new Error(`the portal refused this run (${res.status}): ${res.data?.error || 'no message'}`);
      error.code = 'agent_context_refused';
      throw error;
    }
    const ctx = res.data || {};
    if (ctx.tenant?.slug && ctx.tenant.slug !== tenant) {
      // The token decides the tenant. Disagreeing with it is a bug, not a request to honour.
      const error = new Error(`this token belongs to tenant "${ctx.tenant.slug}", not "${tenant}" — stopping`);
      error.code = 'agent_tenant_mismatch';
      throw error;
    }
    console.error(`agent mode: tenant=${ctx.tenant?.slug} known=${(ctx.known || []).length} profile=${maskEnvId(ctx.identity?.envId || '')}`);
    return {
      supabase: null,
      tenantRow: { id: null, slug: ctx.tenant?.slug, name: ctx.tenant?.name || null },
      offers: Array.isArray(ctx.known) ? ctx.known : [],
      sourceId: null,
      identity: ctx.identity || null
    };
  }

  const supabase = await loadSupabase();
  const { data: tenantRow, error } = await supabase
    .from('site_tenants').select('id, slug, name').eq('slug', tenant).maybeSingle();
  if (error) throw error;
  if (!tenantRow) {
    console.error(`No tenant with slug "${tenant}". Nothing was read or written.`);
    process.exit(2);
  }
  const { data: offers, error: offersError } = await supabase
    .from('opportunities')
    .select('id, title, slug, external_id, referral_url, description, status')
    .eq('tenant_id', tenantRow.id);
  if (offersError) throw offersError;

  // The source row drives `source_id`, which is what lets coverage attribute these
  // offers to Micro1 instead of falling back to a slug guess. Absent is acceptable.
  const { data: sourceRow } = await supabase
    .from('opportunity_sources').select('id').eq('slug', MICRO1_PLATFORM.source).maybeSingle();

  return { supabase, tenantRow, offers: offers || [], sourceId: sourceRow?.id || null, identity: null };
}

/**
 * Drive the live session.
 *
 * Two passes, because they disagree about what is expensive:
 *
 *   Pass 1 (links)  â€” never leaves the listing. Click, read, next. One navigation total.
 *   Pass 2 (bodies) â€” one navigation per role, because the job page is client-rendered.
 *
 * Doing them interleaved would mean one navigation per role for the link *and* the body,
 * which is double the work for the same result. Splitting them also means `--no-descriptions`
 * is a real speed dial rather than an untested branch.
 */
async function runCapture({ existingOffers = [], identity = null } = {}) {
  // Identity first: a tenant who connected their own MoreLogin runs on their own profile
  // and their own key, and a tenant with neither is refused rather than guessed.
  // In agent mode the portal already resolved it — including refusing anything that is not
  // the tenant's own local profile — so this process never needs a database to know.
  const runnerIdentity = identity ||
    await resolveRunnerIdentity({ supabase: await loadSupabase(), tenantSlug: tenant });
  console.error(`identity: source=${runnerIdentity.source} runtime=${runnerIdentity.runtime} profile=${runnerIdentity.envId}`);
  const client = createMoreloginClient(runnerIdentity.apiKey ? { apiKey: runnerIdentity.apiKey } : {});
  const runtime = createBrowserRuntime({ client });
  // MoreLogin caps **starts per day**. Two consequences, both deliberate:
  //
  //   1. A start failure is classified before it is retried. If the plan's allowance is
  //      spent, retrying is exactly what wastes it â€” so the run stops with the one
  //      instruction that helps (wait for the reset, or upgrade), and says that nothing
  //      was lost.
  //   2. A start that *does* succeed must be worth it: `--only-missing` filters the
  //      cards down to roles this tenant does not already have (see planMicro1Window).
  let started = null;
  for (let attempt = 1; attempt <= 2 && !started; attempt += 1) {
    try {
      started = await runtime.startProfile(runnerIdentity.envId, {
        runtime: runnerIdentity.runtime,
        headless: flag('headful', null) === null
      });
    } catch (error) {
      const failure = classifyProviderFailure(error);
      if (!failure.retryable) {
        console.error(`\nSTOPPED â€” ${failure.code}`);
        console.error(String(error?.message || error));
        console.error(`\n${failure.actionable}\n`);
        const quota = new Error(failure.actionable);
        quota.code = failure.code;
        quota.quotaExhausted = true;
        throw quota;
      }
      if (attempt === 2) throw error;
      console.error(`profile start failed (${error?.message || error}) â€” releasing it and retrying`);
      try { await runtime.closeProfile(runnerIdentity.envId); } catch {}
      await sleep(6_000);
    }
  }
  if (!started.debugPort) {
    console.error(`profile not ready (status=${started.status})`);
    process.exit(1);
  }
  const host = started.host;
  const port = started.debugPort;
  console.error(`tenant=${tenant} profile=${maskEnvId(runnerIdentity.envId)} port=${port}`);

  const captures = [];
  try {
    await capturePage({ host, port, url: MICRO1_PLATFORM.listUrl, timeoutMs: 45_000 });
    const listing = await waitForListing({ host, port });
    if (!listing.ok || !listing.count) {
      console.error(`listing did not render (waited ${listing.waitedMs}ms) â€” nothing captured`);
      return { captures, listing };
    }
    console.error(`listing: ${listing.count} cards after ${listing.waitedMs}ms`);

    const page = await evaluateJson({ host, port, expression: MICRO1_LIST_EXPR });
    const items = (page?.items || []).map(normalizeMicro1Item).filter(Boolean);

    // One page of this grid is twelve cards, and a run is worth a MoreLogin start only if it
    // brings back several pages' worth. So: read, advance, read again — until the limit is met or
    // the listing stops growing. Whatever the listing actually offered is reported, because "12
    // captured" and "70 captured" are different outcomes and the tenant should see which.
    const wanted = skip + limit;
    let collected = mergeMicro1Pages([], items).items;
    let pages = 1;
    for (let attempt = 0; attempt < MAX_LIST_PAGES && collected.length < wanted; attempt += 1) {
      const advanced = await evaluateJson({ host, port, expression: MICRO1_ADVANCE_EXPR }).catch(() => null);
      if (!advanced) break;
      if (advanced.clicked) {
        await sleep(1_200);
        const next = await evaluateJson({ host, port, expression: MICRO1_LIST_EXPR });
        const merged = mergeMicro1Pages(collected, (next?.items || []).map(normalizeMicro1Item).filter(Boolean));
        if (!merged.added) {
          console.error(`page ${pages + 1} added nothing new (${advanced.how}) — listing exhausted`);
          break;
        }
        collected = merged.items;
        pages += 1;
        console.error(`listing page ${pages}: +${merged.added} cards (${collected.length} total)`);
        continue;
      }
      if (!$advanced?.scrolled) break;
      // Infinite scroll: give the grid time to append, then compare.
      await sleep(1_500);
      const next = await evaluateJson({ host, port, expression: MICRO1_LIST_EXPR });
      const merged = mergeMicro1Pages(collected, (next?.items || []).map(normalizeMicro1Item).filter(Boolean));
      if (!merged.added) break;
      collected = merged.items;
      pages += 1;
      console.error(`listing scroll ${pages}: +${merged.added} cards (${collected.length} total)`);
    }
    console.error(`listing: ${collected.length} unique card(s) across ${pages} page(s)`);

    // Which cards are worth clicking. With a daily start allowance, re-capturing roles
    // the tenant already owns is the most expensive way to learn nothing.
    const plan = planMicro1Window(collected, {
      existingOffers,
      tenantSlug: tenant,
      skip,
      limit,
      onlyMissing
    });
    const window = plan.window;
    console.error(`listing: ${plan.considered} cards Â· ${plan.alreadyImported} already imported${onlyMissing ? ' (skipped)' : ''}`);
    console.error(`reading cards ${skip + 1}..${skip + window.length}`);
    runState.total = window.length;

    // ---- Pass 1: the referral link for each card -------------------------------
    for (const item of window) {
      const capture = { ...item, referralUrl: null, jobId: null, reason: null };
      try {
        // Close whatever the previous role opened. The share popover renders inside the
        // grid, so leaving it open moves the cards and the next click hits the wrong role.
        await evaluateJson({ host, port, expression: MICRO1_CLOSE_DIALOGS_EXPR });

        // The share link field *persists* across clicks. Reading "any micro1 URL on the
        // page" therefore returned the previous card's link when a click was slow â€” two
        // different roles captured with one job id, which looks like success and pays for
        // the wrong job. So: snapshot the candidates first, and accept only a link that
        // was not there before this click.
        const before = new Set(
          ((await evaluateJson({ host, port, expression: MICRO1_READ_REFERRAL_EXPR }))?.candidates || [])
            .map((value) => String(value).trim())
        );

        const opened = await evaluateJson({ host, port, expression: micro1OpenReferralExpr(item.title) });
        if (!opened.ok) {
          capture.reason = opened.reason || 'open_failed';
          console.error(`[${item.index}] ${capture.reason} â€” ${String(item.title).slice(0, 50)}${opened.buttons ? ` Â· buttons: ${opened.buttons.join(' / ')}` : ''}${opened.titles ? ` Â· titles: ${opened.titles.slice(0, 4).join(' / ')}` : ''}`);
        } else {
          // Poll for a *new* candidate rather than sleeping a fixed time: the field is
          // written a beat after the click, and a fixed wait is either too short (stale
          // read) or wasted on every role.
          let picked = null;
          let waited = 0;
          while (waited < 5_000 && !picked) {
            await sleep(350);
            waited += 350;
            const read = await evaluateJson({ host, port, expression: MICRO1_READ_REFERRAL_EXPR });
            const fresh = (read?.candidates || []).filter((value) => !before.has(String(value).trim()));
            picked = pickMicro1ReferralUrl(fresh);
          }
          if (!picked) {
            // Never fall back to a link that was already on the page: that is another
            // role's link, and attaching it is worse than leaving this role unlinked.
            capture.reason = 'link_not_yielded';
            console.error(`[${item.index}] no NEW link appeared after ${waited}ms â€” ${String(item.title).slice(0, 50)}`);
          } else {
            capture.referralUrl = picked;
            capture.jobId = (picked.match(/\/post\/([0-9a-f-]{16,})/i) || [])[1] || null;
            capture.externalId = capture.jobId ? `micro1:${capture.jobId}` : null;
            capture.url = micro1JobUrl(capture.jobId);
            console.error(`[${item.index}] LINK ${capture.jobId} (${waited}ms) â€” ${String(item.title).slice(0, 60)}`);
          }
        }
      } catch (error) {
        // One card must never end the run: record it and keep going.
        capture.reason = `error:${error?.code || 'unknown'}`;
        console.error(`[${item.index}] FAILED â€” ${error?.message || error}`);
      }
      captures.push(capture);
      runState.done += 1;
      if (capture.referralUrl) runState.ok += 1; else runState.failed += 1;
      await beatRun();

      // Guard against the same job id landing on two roles, whatever the cause. One id
      // per role is the invariant; a repeat means a read raced a re-render.
      if (capture.jobId) {
        const clash = captures.find((other) => other !== capture && other.jobId === capture.jobId);
        if (clash) {
          console.error(`[${item.index}] duplicate job ${capture.jobId} already used by "${clash.title}" â€” discarding this link`);
          capture.referralUrl = null;
          capture.jobId = null;
          capture.reason = 'duplicate_job_id';
        }
      }
    }


    // ---- Pass 2: the job body, one navigation per role ------------------------
    if (withDescriptions) {
      for (const capture of captures) {
        if (!capture.jobId) continue;
        try {
          await capturePage({ host, port, url: capture.url, timeoutMs: 45_000 });
          await sleep(2200);
          const detail = await evaluateJson({ host, port, expression: MICRO1_DETAIL_CONTENT_EXPR });
          if (detail?.ok && detail.content) {
            capture.content = detail.content;
            capture.descriptionChars = detail.chars;
            console.error(`[${capture.index}] body ${detail.chars} chars`);
          } else {
            console.error(`[${capture.index}] body unreadable (${detail?.chars || 0} chars)`);
          }
        } catch (error) {
          console.error(`[${capture.index}] body failed â€” ${error?.message || error}`);
        }
        await beatRun();
      }
      // Leave the browser where the next run expects it.
      try { await capturePage({ host, port, url: MICRO1_PLATFORM.listUrl, timeoutMs: 30_000 }); } catch {}
    }

    return { captures, listing };
  } finally {
    if (sharedSession) { try { sharedSession.close(); } catch {} sharedSession = null; }
    if (flag('keep-open', null) === null) {
      try { await runtime.closeProfile(runnerIdentity.envId); } catch {}
    }
  }
}

const runState = { store: null, runId: null, total: 0, done: 0, ok: 0, failed: 0, lastBeat: 0 };

async function startRunTracking(supabase, tenantRow) {
  if (!runIdFlag) return;
  if (agentMode) {
    // No database here: progress goes to the portal, which owns the row.
    runState.agent = true;
    runState.runId = String(runIdFlag);
    return;
  }
  try {
    runState.store = createRunStore({ table: () => supabase.from('browser_actor_runs') });
    const run = await runState.store.claim({ runId: String(runIdFlag) });
    if (!run) { console.error('run tracking: that run does not exist â€” capturing anyway'); runState.store = null; return; }
    runState.runId = run.id;
    console.error(`run tracking: ${run.id} (${run.status})`);
  } catch (error) {
    console.error(`run tracking unavailable: ${error?.message || error} â€” capturing anyway`);
    runState.store = null;
  }
}

async function beatRun({ force = false } = {}) {
  if (!runState.runId) return;
  if (!runState.store && !runState.agent) return;
  const nowMs = Date.now();
  if (!force && nowMs - runState.lastBeat < 2000) return;
  runState.lastBeat = nowMs;
  try {
    if (runState.agent) {
      await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runState.runId)}/progress`, {
        done: runState.done,
        ok: runState.ok,
        failed: runState.failed,
        total: runState.total || undefined
      });
      return;
    }
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
  if (!runState.runId) return;
  if (runState.agent) {
    // Tell the portal even on the crash path: a run left "running" for ever is the failure
    // mode the tenant cannot diagnose. The server still derives the status from counters when
    // no explicit one is given.
    try {
      await agentCall('POST', `/api/agent/runs/${encodeURIComponent(runState.runId)}/finish`, {
        status,
        done: runState.done,
        ok: runState.ok,
        failed: runState.failed,
        total: runState.total || undefined,
        message: message ? String(message).slice(0, 300) : null,
        detail: detail || null
      });
    } catch (error) {
      console.error(`run could not be closed: ${error?.message || error}`);
    }
    return;
  }
  if (!runState.store) return;
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
 * Agent mode: hand the captures to the server, which writes them.
 *
 * The machine that saw the page has no business holding a key that can write for any tenant,
 * so it reports what it observed and stops there. The server re-checks every link before it
 * is attached — holding a valid token makes a worker authentic, not trusted.
 */
async function reportAgentResult({ captures, listing }) {
  const res = await agentCall('POST', `/api/agent/runs/${encodeURIComponent(String(runIdFlag))}/result`, {
    listing: { cards: listing?.count || 0, waitedMs: listing?.waitedMs || null },
    captures: captures.map((capture) => ({
      title: capture.title,
      jobId: capture.jobId,
      externalId: capture.externalId,
      url: capture.url,
      referralUrl: capture.referralUrl,
      content: capture.content,
      rate: capture.rate,
      summary: capture.summary,
      reason: capture.reason,
      descriptionChars: capture.descriptionChars
    }))
  });
  if (!res.ok) {
    const message = res.data?.error || 'the portal rejected the result';
    console.error(`the portal rejected the result (${res.status}): ${message}`);
    return { planned: 0, inserted: 0, withLinks: 0, skipped: [], verification: [], coverage: null, error: message };
  }
  return { ...(res.data?.applied || {}), coverage: res.data?.coverage || null };
}

async function main() {
  // Claim the *reporting* before anything can fail: if the context is refused or the profile
  // will not start, the catch below still owns a run id and can close it. Without this a
  // claimed run stayed "running" for ever and the tenant could not queue another capture.
  if (agentMode && runIdFlag) {
    runState.agent = true;
    runState.runId = String(runIdFlag);
  }
  const { supabase, tenantRow, offers, sourceId, identity } = await loadTenantContext();
  console.error(`tenant=${tenantRow.slug} offers=${offers.length} source_id=${sourceId || '(none)'}`);
  await startRunTracking(supabase, tenantRow);

  const { captures, listing } = await runCapture({ existingOffers: offers, identity });
  const withLink = captures.filter((capture) => capture.referralUrl);
  const withBody = captures.filter((capture) => capture.content);
  console.error(`captured: ${captures.length} roles Â· ${withLink.length} links Â· ${withBody.length} bodies`);

  // One caller writes offers, and it is never the tenant's machine.
  const applied = agentMode
    ? await reportAgentResult({ captures, listing })
    : await applyCaptures({
      supabase,
      tenant: tenantRow,
      offers,
      sourceId,
      sourceSlug: MICRO1_PLATFORM.source,
      captures,
      apply
    });
  if (applied.error) console.error(`insert failed: ${applied.error}`);
  if (apply) console.error(`imported ${applied.inserted} draft offers (${applied.withLinks} with a verified link)`);
  else console.error(`plan only â€” ${applied.planned} new offers would be created; re-run with --apply`);

  const coverage = agentMode ? applied.coverage : await readCoverage(supabase, tenantRow.id);
  if (coverage) {
    console.error(`descriptions: ${coverage.full}/${coverage.marketplace} marketplace offers have full text (median ${coverage.medianChars} chars), ${coverage.thin} still thin`);
  }

  const report = {
    tenant: tenantRow.slug,
    listing: { cards: listing?.count || 0, waitedMs: listing?.waitedMs || null },
    captured: captures.length,
    links: withLink.length,
    bodies: withBody.length,
    applied,
    coverage,
    captures: captures.map((capture) => ({
      index: capture.index,
      title: capture.title,
      jobId: capture.jobId || null,
      referralUrl: capture.referralUrl || null,
      descriptionChars: capture.descriptionChars || 0,
      openings: capture.openings,
      pay: capture.pay,
      referralBonus: capture.referralBonus,
      reason: capture.reason || null
    })),
    generatedAt: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await finishRunTracking({
    message: `${withLink.length}/${captures.length} links, ${applied.inserted} imported`,
    detail: { captured: captures.length, links: withLink.length, bodies: withBody.length, inserted: applied.inserted }
  });
}

main().catch(async (error) => {
  console.error(redact(error?.message || String(error)));
  if (error?.code) console.error(`code: ${error.code}`);
  // A crashed run must not stay "running" in the portal.
  await finishRunTracking({ status: 'failed', message: String(error?.message || error).slice(0, 300) });
  process.exit(1);
});

