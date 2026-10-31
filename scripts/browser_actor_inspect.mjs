#!/usr/bin/env node

/**
 * Live page inspection for adapter discovery (2026-10-31).
 *
 * Writing selectors from imagination produces adapters that return zero rows on
 * the real page. This script starts the tenant's MoreLogin profile, opens a URL
 * as that tenant, and records three things an adapter can be written against:
 *
 *   <out>.json  page facts (title/text/links), a DOM structure probe
 *               (repeating containers, tables, buttons), and login-wall signals
 *   <out>.png   a screenshot, so a human (or an agent reading images) can see
 *               whether the session is real and where the listing lives
 *
 * Read-only: it navigates and reads. It never clicks, submits or applies.
 *
 * Usage:
 *   BROWSER_ACTOR_PROFILES='{"writers-flow":"<envId>"}' \
 *   node scripts/browser_actor_inspect.mjs --tenant writers-flow \
 *     --url https://work.turing.com/jobs --out tmp_inspect/turing
 *
 * Flags: --headful (show the window), --keep-open (leave the profile running)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMoreloginClient, redact } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { capturePage, captureScreenshot, resolveDebugTarget, CdpSession } from '../utils/browserActor/cdp.js';
import { parseProfileMap, resolveIdentity, describeIdentity } from '../utils/browserActor/identity.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

const tenant = flag('tenant');
const url = flag('url');
const outBase = String(flag('out', 'tmp_inspect/page'));
if (!tenant || !url) {
  console.error('usage: --tenant <slug> --url <https url> [--out <path>] [--headful] [--keep-open]');
  process.exit(1);
}
const headless = flag('headful', null) === null;

/**
 * Finds the shapes an adapter needs: containers that repeat children (a listing),
 * real tables, button labels, and whether the page looks like a login wall.
 */
const STRUCTURE_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const cls = (el) => (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
  const name = (el) => el.tagName.toLowerCase() + (cls(el) ? '.' + cls(el) : '');
  const root = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;

  const repeaters = [];
  let guard = 0;
  for (const el of root.querySelectorAll('*')) {
    if (guard++ > 4000 || repeaters.length >= 12) break;
    const kids = el.children;
    if (!kids || kids.length < 3) continue;
    const tag = kids[0].tagName.toLowerCase();
    let same = 0;
    for (const k of kids) if (k.tagName.toLowerCase() === tag) same++;
    if (same < 3 || same < kids.length * 0.6) continue;
    repeaters.push({
      parent: name(el),
      childTag: tag,
      childClass: cls(kids[0]),
      count: kids.length,
      sample: clean(kids[0].innerText || kids[0].textContent).slice(0, 180)
    });
  }

  const tables = Array.from(document.querySelectorAll('table')).slice(0, 5).map((t) => ({
    cols: Array.from(t.querySelectorAll('thead th')).slice(0, 10).map((th) => clean(th.textContent).slice(0, 40)),
    rows: t.querySelectorAll('tbody tr').length
  }));

  const buttons = Array.from(document.querySelectorAll('button, a[role="button"]'))
    .slice(0, 40).map((b) => clean(b.innerText || b.textContent).slice(0, 40)).filter(Boolean);

  const text = clean(root.innerText || root.textContent || '');
  const lower = text.toLowerCase();

  return JSON.stringify({
    url: String(location.href),
    title: clean(document.title),
    readyState: document.readyState,
    root: name(root),
    textLength: text.length,
    textHead: text.slice(0, 2500),
    counts: {
      links: document.querySelectorAll('a[href]').length,
      tables: document.querySelectorAll('table').length,
      lists: document.querySelectorAll('ul,ol').length,
      buttons: document.querySelectorAll('button').length,
      forms: document.forms.length
    },
    tables,
    repeaters,
    buttons,
    loginSignals: ['sign in', 'log in', 'signin', 'login', 'password', 'forgot password']
      .filter((s) => lower.includes(s))
  });
})()`;

/** Dump the anatomy of the first few cards so a parser keys off the DOM, not prose. */
function cardAnatomyExpr(selector) {
  return `(() => {
  const sel = ${JSON.stringify(selector)};
  const container = document.querySelector(sel);
  if (!container) return JSON.stringify({ ok: false, reason: 'not_found', selector: sel, cards: [] });
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const cls = (el) => (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
  const cards = Array.from(container.children).slice(0, 3).map((card) => {
    const nodes = [];
    const walk = (el, depth) => {
      if (depth > 3 || nodes.length >= 16) return;
      for (const child of el.children) {
        nodes.push({
          tag: child.tagName.toLowerCase(),
          cls: cls(child),
          text: clean(child.innerText || child.textContent).slice(0, 90),
          href: child.tagName === 'A' ? String(child.getAttribute('href') || '') : null
        });
        walk(child, depth + 1);
      }
    };
    walk(card, 0);
    return {
      cardClass: cls(card),
      cardText: clean(card.innerText).slice(0, 300),
      links: Array.from(card.querySelectorAll('a[href]')).slice(0, 4).map((a) => String(a.getAttribute('href'))),
      nodes
    };
  });
  return JSON.stringify({ ok: true, selector: sel, count: container.children.length, cards });
})()`;
}

/**
 * Poll until a selector appears (or disappears, via a `!` prefix in the flag).
 *
 * SPA listings render after the load event, so a capture taken right after
 * `readyState: complete` shows skeletons and zero rows — which would send an
 * adapter author hunting for selectors that were never on the page.
 */
async function waitForSelector({ host, port, selector, mode = 'present', maxMs = 15000 }) {
  const target = await resolveDebugTarget({ host, port });
  const session = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  const expression = mode === 'absent'
    ? `document.querySelectorAll(${JSON.stringify(selector)}).length === 0`
    : `document.querySelectorAll(${JSON.stringify(selector)}).length > 0`;
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < maxMs) {
      const result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 5000 });
      if (result?.result?.value === true) {
        return { selector, mode, satisfied: true, waitedMs: Date.now() - startedAt };
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return { selector, mode, satisfied: false, waitedMs: Date.now() - startedAt };
  } finally {
    session.close();
  }
}

async function structureOf({ host, port }) {
  const target = await resolveDebugTarget({ host, port });
  const session = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  try {
    const result = await session.send(
      'Runtime.evaluate',
      { expression: STRUCTURE_EXPR, returnByValue: true },
      { timeoutMs: 30_000 }
    );
    const raw = result?.result?.value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } finally {
    session.close();
  }
}

async function evaluateJson({ host, port, expression }) {
  const target = await resolveDebugTarget({ host, port });
  const session = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  try {
    const result = await session.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      { timeoutMs: 30_000 }
    );
    const raw = result?.result?.value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
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
  console.error(`tenant=${tenant} profile=${describeIdentity(identity).envIdMasked} headless=${headless}`);

  const runtime = createBrowserRuntime({ client: createMoreloginClient() });
  const started = await runtime.startProfile(identity.envId, { runtime: identity.runtime, headless });
  if (!started.debugPort) {
    console.error(`profile not ready (status=${started.status}); retry shortly`);
    process.exit(1);
  }
  console.error(`attached on port ${started.debugPort}`);

  try {
    const page = await capturePage({
      host: started.host,
      port: started.debugPort,
      url,
      timeoutMs: 45_000,
      maxChars: 4000,
      maxLinks: 60
    });
    // Wait for the listing to finish rendering before reading the DOM.
    const waitSpec = flag('wait');
    if (typeof waitSpec === 'string' && waitSpec) {
      const absent = waitSpec.startsWith('!');
      const selector = absent ? waitSpec.slice(1) : waitSpec;
      const waitResult = await waitForSelector({
        host: started.host,
        port: started.debugPort,
        selector,
        mode: absent ? 'absent' : 'present',
        maxMs: Number(flag('wait-ms', 15000))
      });
      console.error(`wait ${waitSpec} -> ${JSON.stringify(waitResult)}`);
      await new Promise((resolve) => setTimeout(resolve, Number(flag('settle', 800))));
    }

    const structure = await structureOf({ host: started.host, port: started.debugPort });
    const cardsSpec = flag('cards');
    const cards = typeof cardsSpec === 'string' && cardsSpec
      ? await evaluateJson({ host: started.host, port: started.debugPort, expression: cardAnatomyExpr(cardsSpec) })
      : null;
    const shot = await captureScreenshot({ host: started.host, port: started.debugPort });

    const outPath = path.resolve(`${outBase}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ identity: describeIdentity(identity), page, structure, cards }, null, 2));
    const pngPath = path.resolve(`${outBase}.png`);
    fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));

    console.log(JSON.stringify({
      ok: true,
      json: outPath,
      png: pngPath,
      title: structure?.title || page?.title || null,
      url: structure?.url || page?.url || null,
      readyState: structure?.readyState || null,
      loginSignals: structure?.loginSignals || [],
      counts: structure?.counts || null,
      repeaters: (structure?.repeaters || []).slice(0, 5),
      cards: cards ? { count: cards.count, first: (cards.cards || [])[0] || null } : null,
      textHead: String(structure?.textHead || '').slice(0, 400)
    }, null, 2));
  } finally {
    if (flag('keep-open', null) === null) {
      try { await runtime.closeProfile(identity.envId); } catch {}
    }
  }
}

main().catch((error) => {
  console.error(redact(error?.message || String(error)));
  if (error?.details) console.error(JSON.stringify(error.details));
  if (error?.code) console.error(`code: ${error.code}`);
  process.exit(1);
});

