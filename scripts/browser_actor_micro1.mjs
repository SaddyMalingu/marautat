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
import { captureGroupsOnPage } from '../utils/browserActor/tasks/micro1Referrals.js';
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
import { blocksRun, classifyMarketplaceSession, sessionGateExpr, sessionWallError } from '../utils/browserActor/sessionGate.js';

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

/**
 * Group mode (2026-11-16): one link per PAIR of roles.
 *
 * Micro1 only mints a referral link when at least two roles are selected in its builder, so the per-role pass
 * that follows cannot produce an attributable link — it produces a healthy-looking run that pays nothing.
 *
 * It is therefore the default rather than a flag: a run that pairs nothing has nothing to sell, and making the
 * payable path the opt-in one is how months of single-role runs happened. `--groups` is still accepted (the
 * portal passes it), and `--per-role` restores the old behaviour for the diagnostic case where job ids matter
 * more than links.
 */
const groupMode = flag('per-role', null) === null;
const groupSize = Math.max(2, Number(flag('group-size', 2)) || 2);
const maxGroups = Math.min(25, Math.max(1, Number(flag('max-groups', 12)) || 12));

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

  // The pairing flow ends with the page copying a referral link, which raises Chrome's clipboard permission bubble
  // over the window. A worker cannot click that bubble, so the permission is granted up front and the page is brought
  // to the front — a blurred tab is enough for clicks to be ignored (2026-11-16). Both are best-effort: the in-page
  // clipboard hook already makes the run independent of the real clipboard.
  try { await sharedSession.send('Page.bringToFront', {}, { timeoutMs: 5_000 }); } catch {}
  for (const origin of ['https://refer.micro1.ai', 'https://jobs.micro1.ai', 'https://micro1.ai']) {
    try {
      await sharedSession.send('Browser.grantPermissions', {
        origin,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
      }, { timeoutMs: 5_000 });
    } catch (error) {
      // Browser-domain commands are not always reachable from a page session; the hook covers it.
      console.error(`clipboard permission not granted for ${origin}: ${error?.message || error}`);
    }
  }
  return sharedSession;
}

async function evaluateJson({ host, port, expression }) {
  let session = await ensureSession({ host, port });
  // `awaitPromise` is not optional here. The select/clear expressions are async IIFEs (they wait for the page to
  // confirm a tick), and without this flag CDP returns the pending Promise — which deserialises to undefined, so
  // every selection came back empty and the run reported "counter ?→?" five times without ever reading the page.
  // The timeout covers the waits inside those expressions.
  const options = { timeoutMs: 45_000 };
  const params = { expression, returnByValue: true, awaitPromise: true };
  try {
    const result = await session.send('Runtime.evaluate', params, options);
    const raw = result?.result?.value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    // A session can die with the page. Rebuild it once rather than failing the run.
    sharedSession = null;
    session = await ensureSession({ host, port });
    const result = await session.send('Runtime.evaluate', params, options);
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
    /**
     * Before blaming the markup, ask the browser what it is looking at (2026-11-05).
     *
     * Micro1 used to report `listing did not render (waited 30000ms) — nothing captured` and close.
     * After a day away, that sentence is usually a signed-out profile, and it reads like a broken
     * adapter. The grid's own shape is the listing test (`div.grid`), so a page with a grid is a
     * page we can read; a password field or a verification page is not.
     */
    const gate = classifyMarketplaceSession(await evaluateJson({
      host,
      port,
      expression: sessionGateExpr({ listingSelector: 'div.grid, main' })
    }).catch(() => null) || {});
    if (blocksRun(gate.state)) {
      console.error(`stopping: ${gate.state} — ${gate.reason}`);
      if (gate.hint) console.error(`  ${gate.hint}`);
      throw sessionWallError(gate);
    }
    if (!listing.ok || !listing.count) {
      console.error(`listing did not render (waited ${listing.waitedMs}ms) · session=${gate.state} (${gate.reason}) — nothing captured`);
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
      if (!advanced.scrolled) break;
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

    // ---- Pass 0: grouped links (2026-11-16) ------------------------------------
    //
    // Micro1 mints a referral link only when two or more roles are selected together, so the per-role pass
    // cannot attribute a click at all — it produced runs that looked healthy and paid nothing. With `--groups`
    // the pairing engine runs first, related roles only, and its link is attached to each role it covers.
    let groupedLinks = new Map();
    let groupedOk = true;
    if (groupMode) {
      const engine = await captureGroupsOnPage({
        evaluateJson,
        host,
        port,
        size: groupSize,
        maxGroups,
        // Only roles that already CARRY A LINK are skipped: a role imported without one is exactly what a pair
        // is for. The first live run passed every imported title, so 67 roles were excluded and 3 were left.
        alreadyGrouped: existingOffers.filter((offer) => offer.referral_url).map((offer) => offer.title).filter(Boolean),
        // Every role this tenant holds. Pairing is limited to these, because a link minted for a role we do not own has
        // nowhere to go and is wasted — four links died that way on 2026-11-16.
        knownTitles: existingOffers.map((offer) => offer.title).filter(Boolean),
        allowMixed: flag('group-mixed', null) !== null,
        log: (line) => console.error(line)
      }).catch((error) => ({ ok: false, reason: `group_error:${error?.message || error}`, captures: [], failures: [], skipped: [] }));

      if (engine.ok) {
        console.error(`group pass: ${engine.captures.length} role(s) linked across ${engine.groups || 0} pair(s)`);
      } else {
        groupedOk = false;
        console.error(`group pass stopped — ${engine.reason}`);
        // Print what the page actually offers. The first live attempt said only "no_builder_entry", which named
        // nothing and cost a round trip; these labels are the fix.
        if (Array.isArray(engine.controls) && engine.controls.length) {
          console.error(`  controls on the page: ${engine.controls.map((c) => `[${c.tag}${c.role ? ` ${c.role}` : ''}] ${c.text}`).join(' | ')}`);
        }
      }
      for (const failure of engine.failures || []) {
        console.error(`  group ${failure.groupId}: ${failure.reason} — ${(failure.titles || []).join(' + ')}`);
      }
      for (const single of engine.skipped || []) {
        console.error(`  no related partner: ${String(single.title).slice(0, 60)} (${single.reason})`);
      }
      groupedLinks = new Map((engine.captures || []).map((c) => [String(c.title).toLowerCase(), c]));
    }

    // ---- Pass 1: the referral link for each card -------------------------------
    for (const item of window) {
      const pair = groupedLinks.get(String(item.title || '').toLowerCase());
      if (pair) {
        // One URL covers the whole pair — micro1's own model — so both roles carry the same link and the
        // partner is recorded with it, which is what makes the recommendation look deliberate.
        const pairJobId = (String(pair.referralUrl || '').match(/\/post\/([0-9a-f-]{16,})/i) || [])[1] || null;
        captures.push({
          ...item,
          referralUrl: pair.referralUrl,
          jobId: pairJobId,
          externalId: pairJobId ? `micro1:${pairJobId}` : (item.externalId || null),
          url: pairJobId ? micro1JobUrl(pairJobId) : item.url,
          reason: null,
          groupId: pair.groupId,
          sharedWith: pair.sharedWith,
          attribution: pair.attribution
        });
        runState.done += 1;
        runState.ok += 1;
        console.error(`[${item.index}] GROUP ${pair.groupId} — ${String(item.title).slice(0, 60)} (with ${(pair.sharedWith || []).join(' + ')})`);
        await beatRun();
        continue;
      }
      if (groupMode) {
        // When the pairing pass failed outright, every role would print the same sentence: one line, not thirty-two.
        if (!groupedOk) { runState.done += 1; await beatRun(); continue; }
        // No related role to pair with, and micro1 will not mint a link for one role. Say so rather than
        // hunting a link that does not exist, and never pair it with an unrelated role to make the number look better.
        captures.push({ ...item, referralUrl: null, jobId: null, reason: 'no_related_partner' });
        runState.done += 1;
        runState.failed += 1;
        console.error(`[${item.index}] skipped — no related role to pair with`);
        await beatRun();
        continue;
      }
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


    // Roles paired by the group pass that were outside this run's window still deserve their link: the pair was
    // minted for them, and dropping it wastes a group that a MoreLogin start already paid for. They are existing
    // offers by definition (they were not in the window), so `applyCaptureUpdates` matches them by title.
    const linkedTitles = new Set(captures.map((capture) => String(capture.title || '').toLowerCase()));
    for (const pair of groupedLinks.values()) {
      if (linkedTitles.has(String(pair.title || '').toLowerCase())) continue;
      const pairJobId = (String(pair.referralUrl || '').match(/\/post\/([0-9a-f-]{16,})/i) || [])[1] || null;
      captures.push({
        title: pair.title,
        index: null,
        referralUrl: pair.referralUrl,
        jobId: pairJobId,
        externalId: pairJobId ? `micro1:${pairJobId}` : null,
        url: pairJobId ? micro1JobUrl(pairJobId) : null,
        reason: null,
        groupId: pair.groupId,
        sharedWith: pair.sharedWith,
        attribution: pair.attribution
      });
      console.error(`GROUP ${pair.groupId} — ${String(pair.title).slice(0, 60)} (outside this run's window, still linked)`);
    }

    // ---- Pass 2: the job body, one navigation per role ------------------------
    if (withDescriptions) {
      // A paired link has no job id, so its roles get no body here. Say so once, instead of leaving the tenant
      // wondering why "bodies 0".
      const paired = captures.filter((capture) => capture.groupId && !capture.jobId).length;
      if (paired) console.error(`bodies: ${paired} paired role(s) skipped — a group link is a list, not a role page (use a thin-coverage pass for those)`);
      // The page shell and the chat widget both return long text that is identical for every role; that happened on
      // 2026-11-16 (36 roles, 17467 chars each) and would have written the same description onto 36 offers. Distinct
      // bodies only.
      const seenBodies = new Map();
      for (const capture of captures) {
        if (!capture.jobId) continue;
        try {
          await capturePage({ host, port, url: capture.url, timeoutMs: 45_000 });
          await sleep(2200);
          const detail = await evaluateJson({ host, port, expression: MICRO1_DETAIL_CONTENT_EXPR });
          if (detail?.ok && detail.content) {
            const signature = `${detail.chars}:${String(detail.content).slice(0, 120)}`;
            const already = seenBodies.get(signature);
            if (already) {
              capture.content = null;
              capture.reason = 'duplicate_body';
              console.error(`[${capture.index}] body identical to "${String(already).slice(0, 40)}" — discarded, the extractor is reading the shell`);
            } else {
              seenBodies.set(signature, capture.title);
              capture.content = detail.content;
              capture.descriptionChars = detail.chars;
              console.error(`[${capture.index}] body ${detail.chars} chars`);
            }
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
  // Chunked for the same reason the Turing runner chunks: one request per 20 roles keeps the body
  // far below any server limit, and a 413 splits rather than loses the batch.
  const CHUNK = 20;
  const applied = {
    planned: 0, inserted: 0, withLinks: 0, skipped: [], verification: [], coverage: null, error: null,
    // The other half of a capture: existing offers given their link or body. Without this the run printed "imported 0"
    // while two links had been attached — a summary that reads like failure after success (2026-11-16).
    linksUpdated: 0, descriptionsUpdated: 0, existingSkipped: []
  };
  for (let index = 0; index < captures.length; index += CHUNK) {
    const chunk = captures.slice(index, index + CHUNK);
    const res = await agentCall('POST', `/api/agent/runs/${encodeURIComponent(String(runIdFlag))}/result`, {
      listing: { cards: listing?.count || 0, waitedMs: listing?.waitedMs || null },
      captures: chunk.map((capture) => ({
        title: capture.title,
        jobId: capture.jobId,
        externalId: capture.externalId,
        url: capture.url,
        referralUrl: capture.referralUrl,
        content: capture.content,
        rate: capture.rate,
        summary: capture.summary,
        reason: capture.reason,
        descriptionChars: capture.descriptionChars,
        // The pair this link came from. Without these three the server cannot tell a group link — which resolves to
        // a LIST of roles — from a single-role link, and refuses it as a title mismatch.
        groupId: capture.groupId,
        sharedWith: capture.sharedWith,
        attribution: capture.attribution
      }))
    });
    if (!res.ok) {
      const message = res.data?.error || `the portal rejected the result (${res.status})`;
      console.error(`the portal rejected the result (${res.status}): ${message}`);
      applied.error = message;
      return applied;
    }
    const body = res.data?.applied || {};
    applied.planned += body.planned || 0;
    applied.inserted += body.inserted || 0;
    applied.withLinks += body.withLinks || 0;
    applied.linksUpdated += body.existing?.linksUpdated || 0;
    applied.descriptionsUpdated += body.existing?.descriptionsUpdated || 0;
    applied.existingSkipped.push(...(body.existing?.linkSkipped || []));
    applied.skipped.push(...(body.skipped || []));
    applied.verification.push(...(body.verification || []));
    applied.coverage = res.data?.coverage || applied.coverage;
  }
  return applied;
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
  // A role we could not pair, or could not link, carries nothing the portal can apply. Posting it made every batch
  // mostly noise — and a batch that held only noise was rejected outright, killing the links in the next batch
  // (2026-11-16). Unpaired roles are counted here and reported as a summary, not sent.
  const postable = captures.filter((capture) => capture.referralUrl || capture.content);
  const withheld = captures.length - postable.length;
  // Say what each phase did, separately. "captured 14 roles · 2 links" reads like a broken run when 12 of those roles
  // simply have no related partner yet — and in links mode the offers themselves were captured by an earlier run.
  const unpaired = captures.filter((capture) => capture.reason === 'no_related_partner').length;
  console.error(`captured: ${captures.length} roles Â· ${withLink.length} links Â· ${withBody.length} bodies${unpaired ? ` Â· ${unpaired} role(s) with no related partner` : ''}`);
  if (groupMode) console.error(`links phase: offers already exist â€” this run only mints and attaches links${withDescriptions ? '' : ' (bodies off)'}`);
  if (withheld) console.error(`not sent: ${withheld} role(s) carry no link and no body — counted above, nothing for the portal to apply`);

  // One caller writes offers, and it is never the tenant's machine.
  const applied = agentMode
    ? await reportAgentResult({ captures: postable, listing })
    : await applyCaptures({
      supabase,
      tenant: tenantRow,
      offers,
      sourceId,
      sourceSlug: MICRO1_PLATFORM.source,
      captures: postable,
      apply
    });
  if (applied.error) console.error(`insert failed: ${applied.error}`);
  if (apply) {
    // Two outcomes, both reported: new offers, and existing offers that just received their link. Printing only the
    // insert count told a successful run it had imported nothing (2026-11-16).
    console.error(`imported ${applied.inserted} draft offer(s) (${applied.withLinks} with a verified link) Â· ${applied.linksUpdated} existing offer(s) given their link`);
    for (const skipped of (applied.existingSkipped || []).slice(0, 8)) {
      console.error(`  link skipped — ${String(skipped.title).slice(0, 50)}: ${skipped.reason}`);
    }
  } else console.error(`plan only â€” ${applied.planned} new offers would be created; re-run with --apply`);

  const coverage = agentMode ? applied.coverage : await readCoverage(supabase, tenantRow.id);
  if (coverage) {
    console.error(`descriptions: ${coverage.full}/${coverage.marketplace} marketplace offers have full text (median ${coverage.medianChars} chars), ${coverage.thin} still thin`);
  }

  // The portal no longer closes the run on `/result` (so a long capture can post in batches and
  // an interrupted one keeps what it banked), so closing it is this script's job — once, here.
  if (agentMode) {
    await finishRunTracking({
      status: deriveRunStatus({
        done: captures.length,
        ok: captures.length,
        failed: 0,
        total: captures.length
      }),
      message: `${applied.inserted || 0} imported, ${applied.linksUpdated || 0} existing offer(s) linked of ${captures.length} captured`.slice(0, 300),
      detail: {
        captured: captures.length,
        links: withLink.length,
        inserted: applied.inserted || 0,
        linksUpdated: applied.linksUpdated || 0,
        groupLinks: withLink.filter((capture) => capture.groupId).length
      }
    });
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

