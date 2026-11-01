#!/usr/bin/env node

/**
 * Micro1 capture (2026-11-02) — the first marketplace adapter that is not Turing.
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
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createMoreloginClient, redact } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { capturePage, resolveDebugTarget, CdpSession } from '../utils/browserActor/cdp.js';
import { parseProfileMap, resolveIdentity, describeIdentity } from '../utils/browserActor/identity.js';
import { verifyReferralLink } from '../utils/browserActor/referralVerify.js';
import { planOfferImport } from '../utils/browserActor/offersImport.js';
import { describeEnrichment } from '../utils/browserActor/enrichment.js';
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
  planMicro1Window
} from '../utils/browserActor/tasks/micro1.js';
import { classifyProviderFailure } from '../utils/browserActor/errors.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

const tenant = flag('tenant');
const limit = Number(flag('limit', 12)) || 0;
const skip = Number(flag('skip', 0)) || 0;
const pace = Number(flag('pace', 900)) || 900;
const apply = flag('apply', null) !== null;
const withDescriptions = flag('no-descriptions', null) === null;
// Skip roles this tenant already has. One start per day is expensive; spending it on
// offers that already exist is worse than useless.
const onlyMissing = flag('only-missing', null) !== null;

const outPath = path.resolve(String(flag('out', 'tmp/micro1.json')));
const runIdFlag = flag('run-id');

if (!tenant) {
  console.error('usage: --tenant <slug> [--limit 12] [--skip 0] [--apply] [--only-missing] [--no-descriptions] [--out tmp/micro1.json]');
  process.exit(1);
}
if (limit <= 0) {
  console.error('--limit must be a positive number of roles to read');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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


function loadSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SB_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SB_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing Supabase credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');
    process.exit(1);
  }
  return createClient(url, key);
}

/** The tenant, its offers, and the Micro1 source row. Nothing outside this may be touched. */
async function loadTenantContext() {
  const supabase = loadSupabase();
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

  return { supabase, tenantRow, offers: offers || [], sourceId: sourceRow?.id || null };
}

/**
 * Drive the live session.
 *
 * Two passes, because they disagree about what is expensive:
 *
 *   Pass 1 (links)  — never leaves the listing. Click, read, next. One navigation total.
 *   Pass 2 (bodies) — one navigation per role, because the job page is client-rendered.
 *
 * Doing them interleaved would mean one navigation per role for the link *and* the body,
 * which is double the work for the same result. Splitting them also means `--no-descriptions`
 * is a real speed dial rather than an untested branch.
 */
async function runCapture({ existingOffers = [] } = {}) {
  const identity = resolveIdentity({
    tenantSlug: tenant,
    map: parseProfileMap(process.env.BROWSER_ACTOR_PROFILES || ''),
    defaultEnvId: process.env.BROWSER_ACTOR_DEFAULT_ENV_ID || ''
  });
  const runtime = createBrowserRuntime({ client: createMoreloginClient() });
  // MoreLogin caps **starts per day**. Two consequences, both deliberate:
  //
  //   1. A start failure is classified before it is retried. If the plan's allowance is
  //      spent, retrying is exactly what wastes it — so the run stops with the one
  //      instruction that helps (wait for the reset, or upgrade), and says that nothing
  //      was lost.
  //   2. A start that *does* succeed must be worth it: `--only-missing` filters the
  //      cards down to roles this tenant does not already have (see planMicro1Window).
  let started = null;
  for (let attempt = 1; attempt <= 2 && !started; attempt += 1) {
    try {
      started = await runtime.startProfile(identity.envId, {
        runtime: identity.runtime,
        headless: flag('headful', null) === null
      });
    } catch (error) {
      const failure = classifyProviderFailure(error);
      if (!failure.retryable) {
        console.error(`\nSTOPPED — ${failure.code}`);
        console.error(String(error?.message || error));
        console.error(`\n${failure.actionable}\n`);
        const quota = new Error(failure.actionable);
        quota.code = failure.code;
        quota.quotaExhausted = true;
        throw quota;
      }
      if (attempt === 2) throw error;
      console.error(`profile start failed (${error?.message || error}) — releasing it and retrying`);
      try { await runtime.closeProfile(identity.envId); } catch {}
      await sleep(6_000);
    }
  }
  if (!started.debugPort) {
    console.error(`profile not ready (status=${started.status})`);
    process.exit(1);
  }
  const host = started.host;
  const port = started.debugPort;
  console.error(`tenant=${tenant} profile=${describeIdentity(identity).envIdMasked} port=${port}`);

  const captures = [];
  try {
    await capturePage({ host, port, url: MICRO1_PLATFORM.listUrl, timeoutMs: 45_000 });
    const listing = await waitForListing({ host, port });
    if (!listing.ok || !listing.count) {
      console.error(`listing did not render (waited ${listing.waitedMs}ms) — nothing captured`);
      return { captures, listing };
    }
    console.error(`listing: ${listing.count} cards after ${listing.waitedMs}ms`);

    const page = await evaluateJson({ host, port, expression: MICRO1_LIST_EXPR });
    const items = (page?.items || []).map(normalizeMicro1Item).filter(Boolean);
    // Which cards are worth clicking. With a daily start allowance, re-capturing roles
    // the tenant already owns is the most expensive way to learn nothing.
    const plan = planMicro1Window(items, {
      existingOffers,
      tenantSlug: tenant,
      skip,
      limit,
      onlyMissing
    });
    const window = plan.window;
    console.error(`listing: ${plan.considered} cards · ${plan.alreadyImported} already imported${onlyMissing ? ' (skipped)' : ''}`);
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
        // page" therefore returned the previous card's link when a click was slow — two
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
          console.error(`[${item.index}] ${capture.reason} — ${String(item.title).slice(0, 50)}${opened.buttons ? ` · buttons: ${opened.buttons.join(' / ')}` : ''}${opened.titles ? ` · titles: ${opened.titles.slice(0, 4).join(' / ')}` : ''}`);
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
            console.error(`[${item.index}] no NEW link appeared after ${waited}ms — ${String(item.title).slice(0, 50)}`);
          } else {
            capture.referralUrl = picked;
            capture.jobId = (picked.match(/\/post\/([0-9a-f-]{16,})/i) || [])[1] || null;
            capture.externalId = capture.jobId ? `micro1:${capture.jobId}` : null;
            capture.url = micro1JobUrl(capture.jobId);
            console.error(`[${item.index}] LINK ${capture.jobId} (${waited}ms) — ${String(item.title).slice(0, 60)}`);
          }
        }
      } catch (error) {
        // One card must never end the run: record it and keep going.
        capture.reason = `error:${error?.code || 'unknown'}`;
        console.error(`[${item.index}] FAILED — ${error?.message || error}`);
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
          console.error(`[${item.index}] duplicate job ${capture.jobId} already used by "${clash.title}" — discarding this link`);
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
          console.error(`[${capture.index}] body failed — ${error?.message || error}`);
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
      try { await runtime.closeProfile(identity.envId); } catch {}
    }
  }
}

const runState = { store: null, runId: null, total: 0, done: 0, ok: 0, failed: 0, lastBeat: 0 };

async function startRunTracking(supabase, tenantRow) {
  if (!runIdFlag) return;
  try {
    runState.store = createRunStore({ table: () => supabase.from('browser_actor_runs') });
    const run = await runState.store.claim({ runId: String(runIdFlag) });
    if (!run) { console.error('run tracking: that run does not exist — capturing anyway'); runState.store = null; return; }
    runState.runId = run.id;
    console.error(`run tracking: ${run.id} (${run.status})`);
  } catch (error) {
    console.error(`run tracking unavailable: ${error?.message || error} — capturing anyway`);
    runState.store = null;
  }
}

async function beatRun({ force = false } = {}) {
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
 * Write the captures as draft offers.
 *
 * Two rules carried over from Turing, because they are about the marketplace being
 * external rather than about Turing:
 *   - a link is only attached if it provably lands on its own role (`verifyReferralLink`)
 *   - an existing offer is never touched (`planOfferImport` skips by external_id, slug
 *     and title), which is what protects a link the tenant pasted by hand
 */
async function applyCaptures({ supabase, tenantRow, offers, sourceId, captures }) {
  const verification = [];
  for (const capture of captures) {
    if (!capture.referralUrl) continue;
    const check = await verifyReferralLink({ url: capture.referralUrl, expectedTitle: capture.title });
    verification.push({
      title: capture.title,
      jobId: capture.jobId,
      referral_url: capture.referralUrl,
      verdict: check.verdict,
      reason: check.reason,
      resolvedTitle: check.resolvedTitle || null
    });
    if (check.verdict !== 'match') {
      capture.reason = `unverified_${check.verdict}`;
      capture.referralUrl = null;
    }
  }

  const items = captures
    .filter((capture) => capture.title && capture.jobId)
    .map((capture) => ({
      title: capture.title,
      externalId: capture.externalId,
      summary: capture.content || capture.summary || null,
      rate: capture.rate || null,
      url: capture.url || null
    }));

  const plan = planOfferImport({
    items,
    existingOffers: offers,
    tenantSlug: tenantRow.slug,
    tenantId: tenantRow.id,
    sourceSlug: MICRO1_PLATFORM.source,
    sourceId
  });

  // The body and the verified link are attached after planning, so the planner stays the
  // single place that decides *whether* a row is created.
  const byJobId = new Map(captures.filter((c) => c.jobId).map((c) => [c.jobId, c]));
  const rows = plan.create.map((row) => {
    const jobId = String(row.external_id || '').replace(/^micro1:/, '');
    const capture = byJobId.get(jobId) || null;
    if (!capture) return row;
    return {
      ...row,
      description: capture.content || row.description,
      destination_url: capture.url || row.destination_url,
      referral_url: capture.referralUrl || null
    };
  });

  const withLinks = rows.filter((row) => row.referral_url).length;
  const result = {
    planned: rows.length,
    skipped: plan.skipped,
    withLinks,
    withoutLinks: rows.length - withLinks,
    verification,
    inserted: 0,
    error: null
  };

  if (!apply) return { ...result, rows };

  if (rows.length) {
    const { data, error } = await supabase.from('opportunities').insert(rows).select('id, title, slug, referral_url');
    if (error) {
      result.error = error.message;
      return { ...result, rows };
    }
    result.inserted = Array.isArray(data) ? data.length : 0;
    result.created = data || [];
  }
  return { ...result, rows };
}

/** Coverage as the database holds it now — not as the loop hoped. */
async function readCoverage(supabase, tenantId) {
  const { data, error } = await supabase
    .from('opportunities')
    .select('id, title, external_id, description, deleted_at')
    .eq('tenant_id', tenantId);
  if (error) return null;
  const live = (data || []).filter((row) => row.deleted_at == null);
  return describeEnrichment(live);
}

async function main() {
  const { supabase, tenantRow, offers, sourceId } = await loadTenantContext();
  console.error(`tenant=${tenantRow.slug} offers=${offers.length} source_id=${sourceId || '(none)'}`);
  await startRunTracking(supabase, tenantRow);

  const { captures, listing } = await runCapture({ existingOffers: offers });
  const withLink = captures.filter((capture) => capture.referralUrl);
  const withBody = captures.filter((capture) => capture.content);
  console.error(`captured: ${captures.length} roles · ${withLink.length} links · ${withBody.length} bodies`);

  const applied = await applyCaptures({ supabase, tenantRow, offers, sourceId, captures });
  if (applied.error) console.error(`insert failed: ${applied.error}`);
  if (apply) console.error(`imported ${applied.inserted} draft offers (${applied.withLinks} with a verified link)`);
  else console.error(`plan only — ${applied.planned} new offers would be created; re-run with --apply`);

  const coverage = await readCoverage(supabase, tenantRow.id);
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

