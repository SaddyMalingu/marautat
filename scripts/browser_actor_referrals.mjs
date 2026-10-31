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
import { parseProfileMap, resolveIdentity, describeIdentity } from '../utils/browserActor/identity.js';
import { TURING_PLATFORM, TURING_LIST_COUNT_EXPR, TURING_LOAD_MORE_EXPR } from '../utils/browserActor/tasks/turing.js';
import {
  REFERRAL_MODAL_TIMEOUT_MS,
  REFERRAL_PACE_MS,
  TURING_CLOSE_MODAL_EXPR,
  TURING_DETAIL_REFERRAL_EXPR,
  TURING_MODAL_CANDIDATES_EXPR,
  TURING_REFERRAL_HOST,
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

async function evaluateJson({ host, port, expression }) {
  const target = await resolveDebugTarget({ host, port });
  const session = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  try {
    const result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 30_000 });
    const raw = result?.result?.value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } finally {
    session.close();
  }
}

async function countCards({ host, port }) {
  const value = await evaluateJson({ host, port, expression: TURING_LIST_COUNT_EXPR });
  return Number(value) || 0;
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
 * The modal renders after the click, so poll instead of reading once. A dialog that
 * never appears is reported as such — not as "no link", which would be a lie.
 */
async function waitForModalCandidates({ host, port, maxMs = REFERRAL_MODAL_TIMEOUT_MS }) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < maxMs) {
    last = await evaluateJson({ host, port, expression: TURING_MODAL_CANDIDATES_EXPR });
    if (last?.ok && (last.inDialog || (Array.isArray(last.candidates) && last.candidates.length))) return last;
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
 * Drive the live session: page to the requested window, then read one role at a
 * time. Every role is paced, and leaving the listing is recovered rather than
 * ignored.
 */
async function runCapture() {
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

  const captures = [];
  try {
    await capturePage({ host, port, url: TURING_PLATFORM.listUrl, timeoutMs: 45_000 });
    const cleared = await waitForSkeletons({ host, port });
    const needed = skip + limit;
    let cards = await ensureCards({ host, port, needed });
    console.error(`skeletonsCleared=${cleared} cards=${cards} window=${skip + 1}..${skip + limit}`);

    if (cards <= skip) {
      console.error(`the listing stops at ${cards} cards — nothing in the requested window`);
      return captures;
    }

    for (let index = skip; index < Math.min(cards, needed); index += 1) {
      const { capture, leftListing, note } = await captureOne({ host, port, index });
      captures.push(capture || { index, title: null, externalId: null, referralUrl: null, reason: note || 'probe_failed' });
      const label = String(capture?.title || '(no title)').slice(0, 60);
      console.error(`[${index}] ${capture?.referralUrl ? 'LINK' : capture?.reason || note || 'no link'} — ${label}`);

      if (leftListing) {
        // Recover instead of proceeding against the wrong page: every later index
        // refers to a card that no longer exists.
        console.error(`[${index}] left the listing — returning`);
        await capturePage({ host, port, url: TURING_PLATFORM.listUrl, timeoutMs: 45_000 });
        await waitForSkeletons({ host, port });
        cards = await ensureCards({ host, port, needed });
      }
      await sleep(pace);
    }
    return captures;
  } finally {
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
    captures = await runCapture();
  }

  const plan = planReferralBackfill({ offers, captures, host: TURING_REFERRAL_HOST });
  const report = {
    tenant: tenantRow.slug,
    mode: fromFile ? 'from_file' : 'capture',
    requested: fromFile ? null : { skip, limit },
    captured: captures.length,
    withLink: captures.filter((row) => row && row.referralUrl).length,
    headline: referralCaptureHeadline(plan),
    plan
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




