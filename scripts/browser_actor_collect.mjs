#!/usr/bin/env node

/**
 * Run a marketplace adapter against the tenant's live session (2026-10-31).
 *
 *   BROWSER_ACTOR_PROFILES='{"writers-flow":"<envId>"}' \
 *   node scripts/browser_actor_collect.mjs --tenant writers-flow --platform turing \
 *     --out tmp_inspect/turing_roles.json
 *
 * It navigates, waits for the listing to finish rendering, reads the cards, and
 * normalizes them. Read-only: no clicks, no "Load more", no applying. The output
 * is exactly what would be written to `opportunities`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMoreloginClient, redact } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { capturePage, resolveDebugTarget, CdpSession } from '../utils/browserActor/cdp.js';
import { parseProfileMap, resolveIdentity, describeIdentity } from '../utils/browserActor/identity.js';
import { TURING_PLATFORM, TURING_COLLECT_EXPR, normalizeTuringCollection, TURING_REFERRAL_URL, TURING_REFERRAL_EXPR, pickReferralUrl, TURING_LIST_COUNT_EXPR, TURING_LOAD_MORE_EXPR } from '../utils/browserActor/tasks/turing.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

const tenant = flag('tenant');
const platform = String(flag('platform', 'turing'));
const outPath = flag('out');
if (!tenant) {
  console.error('usage: --tenant <slug> [--platform turing] [--out <path>] [--headful]');
  process.exit(1);
}
if (platform !== 'turing') {
  console.error(`no adapter for "${platform}" yet — only turing is verified`);
  process.exit(1);
}

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

async function clickLoadMore({ host, port }) {
  return evaluateJson({ host, port, expression: TURING_LOAD_MORE_EXPR });
}

async function waitForCardsAbove({ host, port, above, maxMs = 15000 }) {
  const startedAt = Date.now();
  let last = above;
  while (Date.now() - startedAt < maxMs) {
    last = await countCards({ host, port });
    if (last > above) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

async function waitForAbsent({ host, port, selector, maxMs }) {
  const target = await resolveDebugTarget({ host, port });
  const session = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  const expression = `document.querySelectorAll(${JSON.stringify(selector)}).length === 0`;
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < maxMs) {
      const result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 5000 });
      if (result?.result?.value === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
  } finally {
    session.close();
  }
}

async function main() {
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
  console.error(`tenant=${tenant} profile=${describeIdentity(identity).envIdMasked} port=${started.debugPort}`);

  try {
    // Refer-and-earn mode: read the tenant's own referral link, which is the CTA
    // every generated offer page needs. Without it the page helps the marketplace
    // for free.
    if (flag('referral', null) !== null) {
      await capturePage({ host: started.host, port: started.debugPort, url: TURING_REFERRAL_URL, timeoutMs: 45_000 });
      const raw = await evaluateJson({ host: started.host, port: started.debugPort, expression: TURING_REFERRAL_EXPR });
      const picked = pickReferralUrl(raw.candidates || []);
      console.log(JSON.stringify({
        mode: 'referral',
        tenant,
        page: raw.url,
        title: raw.title,
        picked,
        candidates: (raw.candidates || []).slice(0, 12)
      }, null, 2));
      return;
    }

    await capturePage({ host: started.host, port: started.debugPort, url: TURING_PLATFORM.listUrl, timeoutMs: 45_000 });
    const cleared = await waitForAbsent({
      host: started.host,
      port: started.debugPort,
      selector: TURING_PLATFORM.wait.selector,
      maxMs: TURING_PLATFORM.wait.maxMs
    });
    console.error(`skeletonsCleared=${cleared}`);

    // Paging: click "Load more roles" in paced steps and write progress after each
    // one, so a long run is watchable instead of several minutes of silence.
    const clickBudget = Number(flag('load-more', 0)) || 0;
    const progressPath = path.resolve(String(flag('progress', 'tmp/collect_progress.json')));
    const history = [];
    let cards = await countCards({ host: started.host, port: started.debugPort });
    const writeProgress = (step, note) => {
      const state = {
        updatedAt: new Date().toISOString(),
        tenant,
        source: 'turing',
        cards,
        clicks: step,
        clickBudget,
        note: note || null,
        progressFile: progressPath,
        history
      };
      fs.mkdirSync(path.dirname(progressPath), { recursive: true });
      fs.writeFileSync(progressPath, JSON.stringify(state, null, 2));
      console.error(`progress cards=${cards} clicks=${step}/${clickBudget} ${note || ''}`);
    };
    writeProgress(0, 'listing loaded');

    for (let step = 1; step <= clickBudget; step += 1) {
      const clicked = await clickLoadMore({ host: started.host, port: started.debugPort });
      if (!clicked || clicked.clicked !== true) {
        writeProgress(step - 1, `stopped: ${(clicked && clicked.reason) || 'not clicked'}`);
        break;
      }
      const next = await waitForCardsAbove({ host: started.host, port: started.debugPort, above: cards });
      history.push({ click: step, at: new Date().toISOString(), before: cards, after: next });
      if (next <= cards) {
        writeProgress(step, 'stopped: no growth');
        break;
      }
      cards = next;
      writeProgress(step, 'grew');
      await new Promise((resolve) => setTimeout(resolve, 600)); // paced, not a hammer
    }

    const raw = await evaluateJson({ host: started.host, port: started.debugPort, expression: TURING_COLLECT_EXPR });

    // The paging loop above grew the DOM monotonically (12 -> 24 -> 84 ...), so one
    // read at the end covers every page. If a future redesign ever *replaces* the
    // list instead of appending, the growth guard stops the loop rather than
    // silently collecting only the last page — that is the failure this comment is
    // here to prevent, and it is why the count is checked after every click.
    const result = normalizeTuringCollection(raw);

    if (outPath) {
      const abs = path.resolve(String(outPath));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify({
      ok: result.ok,
      tenant,
      source: result.source,
      totals: result.totals,
      count: result.count,
      first: result.items.slice(0, 3),
      out: outPath ? path.resolve(String(outPath)) : null
    }, null, 2));
  } finally {
    if (flag('keep-open', null) === null) {
      try { await runtime.closeProfile(identity.envId); } catch {}
    }
  }
}

main().catch((error) => {
  console.error(redact(error?.message || String(error)));
  if (error?.code) console.error(`code: ${error.code}`);
  process.exit(1);
});
