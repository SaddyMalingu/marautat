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
import { TURING_PLATFORM, TURING_COLLECT_EXPR, normalizeTuringCollection, TURING_REFERRAL_URL, TURING_REFERRAL_EXPR, pickReferralUrl } from '../utils/browserActor/tasks/turing.js';

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

    const raw = await evaluateJson({ host: started.host, port: started.debugPort, expression: TURING_COLLECT_EXPR });

    // Paging. Each click may append more cards or replace the page; merging what we
    // have seen after every pass covers both, and normalisation dedupes by title.
    const pages = Math.max(0, Number(flag('load-more', 0)) || 0);
    const seen = new Map();
    const absorb = (payload) => {
      for (const item of (payload && payload.items) || []) {
        const key = String(item.titleText || '').trim().toLowerCase();
        if (key && !seen.has(key)) seen.set(key, item);
      }
    };
    absorb(raw);

    let clicks = 0;
    for (let page = 1; page <= pages; page += 1) {
      const before = await evaluateJson({ host: started.host, port: started.debugPort, expression: COUNT_CARDS_EXPR }).catch(() => null);
      const click = await evaluateJson({ host: started.host, port: started.debugPort, expression: CLICK_LOAD_MORE_EXPR }).catch(() => ({ clicked: false }));
      if (!click || !click.clicked) {
        console.error(`load-more: stopping at page ${page} (${(click && click.reason) || 'no button'})`);
        break;
      }
      clicks += 1;
      // The list rebuilds behind skeletons, so wait for them to clear before reading.
      const cleared = await waitForAbsent({
        host: started.host,
        port: started.debugPort,
        selector: TURING_PLATFORM.wait.selector,
        maxMs: TURING_PLATFORM.wait.maxMs
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const next = await evaluateJson({ host: started.host, port: started.debugPort, expression: TURING_COLLECT_EXPR });
      const after = await evaluateJson({ host: started.host, port: started.debugPort, expression: COUNT_CARDS_EXPR }).catch(() => null);
      absorb(next);
      console.error(`load-more: page ${page} cards ${before}->${after} cleared=${cleared} total=${seen.size}`);
    }

    const result = normalizeTuringCollection({ ...raw, items: Array.from(seen.values()) });

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
