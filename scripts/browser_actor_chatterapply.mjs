#!/usr/bin/env node

/**
 * Fill the ChatterApply application, then hand the live page to a human (2026-11-13)
 *
 * The whole point is the last part: when this stops, the browser is **still open, still on the step it
 * stopped at**, so the person can take over without starting again. So — unlike every other script in
 * this folder — it does **not** close the profile when it finishes. Closing is opt-in with `--close`.
 *
 * Per step: read the fields on screen, match them to the profile by label, write the ones it
 * recognises, verify each write landed, click Next, verify the page actually moved on. It stops at
 * step 15 (the human's) and in front of the typing test (which measures the applicant, not the
 * machine), and it never clicks anything that submits.
 *
 *   # see what the page asks for and what the profile covers — touches nothing
 *   node scripts/browser_actor_chatterapply.mjs --tenant malingu-ventures --profile ca-profile.json --dry-run
 *
 *   # drive the form, stop before the typing test / step 15
 *   node scripts/browser_actor_chatterapply.mjs --tenant malingu-ventures --profile ca-profile.json
 *
 *   # record the current step's fields (the fast way to build the profile)
 *   node scripts/browser_actor_chatterapply.mjs --tenant malingu-ventures --discover
 *
 * Flags:
 *   --profile <file>   json of profile values keyed per PROFILE_FIELDS (firstName, email, country, …)
 *   --set key=value    repeatable; overrides one profile value without editing the file
 *   --discover         read the step on screen, write it to --out, stop (keeps the page open)
 *   --dry-run          read + plan, never fill or click
 *   --include-typing   let the agent take the typing test too (off by default: see chatterApply.js)
 *   --open             navigate to the apply URL first (default: use whatever tab is already there)
 *   --headful          show the browser window
 *   --close            close the MoreLogin profile on exit (default: leave it running and open)
 *   --out <path>       where --discover writes its json (default tmp_chatterapply/step.json)
 */
try { await import('dotenv/config'); } catch { /* the tenant bundle has no node_modules */ }
import fs from 'node:fs';
import path from 'node:path';
import { createMoreloginClient } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { resolveDebugTarget, CdpSession } from '../utils/browserActor/cdp.js';
import { maskEnvId } from '../utils/browserActor/identity.js';
import { resolveRunnerIdentity } from '../utils/tenantRunnerIdentity.js';
import {
  CHATTER_APPLY,
  describeOutcome,
  readStepExpr,
  runApplication
} from '../utils/browserActor/tasks/chatterApply.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}
/** Every `--set key=value`, because one flag can carry only one pair. */
function collectSets() {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--set') continue;
    const pair = argv[i + 1];
    if (!pair || pair.startsWith('--')) continue;
    const at = pair.indexOf('=');
    if (at < 1) continue;
    out[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return out;
}

const tenant = flag('tenant');
const discover = flag('discover', null) !== null;
const dryRun = flag('dry-run', null) !== null;
const includeTyping = flag('include-typing', null) !== null;
const shouldOpen = flag('open', null) !== null;
const closeWhenDone = flag('close', null) !== null;
const headless = flag('headful', null) === null;
const outPath = path.resolve(String(flag('out', 'tmp_chatterapply/step.json')));
const targetUrl = String(flag('url', CHATTER_APPLY.applyUrl));

if (!tenant) {
  console.error('usage: --tenant <slug> [--profile <file>] [--set key=value]… [--dry-run] [--discover]');
  process.exit(1);
}

/** Read the profile: a json file, then `--set` overrides on top. */
function readProfile() {
  const file = flag('profile');
  let base = {};
  if (typeof file === 'string' && file) {
    const resolved = path.resolve(file);
    try {
      base = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (error) {
      console.error(`could not read ${resolved}: ${error.message}`);
      process.exit(1);
    }
  }
  return { ...base, ...collectSets() };
}

/**
 * One CDP round trip. Each call re-resolves the target, which costs a little and buys the thing that
 * matters here: the page surviving a dialog, a frame rebuild or a devtools reconnect mid-form.
 */
async function evaluateJson({ host, port, expression }) {
  const target = await resolveDebugTarget({ host, port });
  const session = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  try {
    const result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 30_000 });
    if (result?.exceptionDetails) {
      const message = result.exceptionDetails.text || 'evaluate threw';
      const detail = result.exceptionDetails.exception?.description || '';
      throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
    }
    const raw = result?.result?.value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } finally {
    session.close();
  }
}

/** Where is the tab right now? Used to avoid navigating over a half-filled form. */
async function currentUrl({ host, port }) {
  const target = await resolveDebugTarget({ host, port });
  const session = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  try {
    const result = await session.send(
      'Runtime.evaluate',
      { expression: 'String(location.href)', returnByValue: true },
      { timeoutMs: 5_000 }
    );
    return String(result?.result?.value || '');
  } catch {
    return '';
  } finally {
    session.close();
  }
}

/** The only navigation this script can perform, and only when explicitly asked for it. */
async function navigateOnce({ host, port, url }) {
  const target = await resolveDebugTarget({ host, port });
  const session = await CdpSession.open({ wsUrl: target.pageWsUrl, timeoutMs: 10_000 });
  try {
    await session.send('Page.enable', {}, { timeoutMs: 5_000 });
    await session.send('Page.navigate', { url }, { timeoutMs: 20_000 });
  } finally {
    session.close();
  }
}

/** Wait until the form document is readable — the frame loads after the shell does. */
async function waitForForm({ host, port, maxMs = 30_000 }) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < maxMs) {
    last = await evaluateJson({ host, port, expression: readStepExpr({ includeValues: false }) });
    if (last?.ok) return { ok: true, waitedMs: Date.now() - startedAt, snapshot: last };
    // A cross-origin frame will never become readable by waiting: stop early and say why.
    if (last?.reason === 'cross_origin_frame') return { ok: false, reason: 'cross_origin_frame', snapshot: last };
    await new Promise((r) => setTimeout(r, 750));
  }
  return { ok: false, reason: last?.reason || 'timeout', snapshot: last };
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}


async function main() {
  const profile = readProfile();
  const identity = await resolveRunnerIdentity({ tenantSlug: tenant });
  console.error(`tenant=${tenant} profile=${maskEnvId(identity.envId)} source=${identity.source} headless=${headless}`);

  const runtime = createBrowserRuntime({
    client: createMoreloginClient(identity.apiKey ? { apiKey: identity.apiKey } : {})
  });
  const started = await runtime.startProfile(identity.envId, { runtime: identity.runtime, headless });
  if (!started.debugPort) {
    console.error(`profile not ready (status=${started.status}); retry shortly`);
    process.exit(1);
  }
  console.error(`attached on port ${started.debugPort}`);
  const connection = { host: started.host, port: started.debugPort };

  let outcome = null;
  let leaveOpen = false;
  try {
    const before = await currentUrl(connection);
    const onTarget = /chatterapply\.com/i.test(before);
    console.error(`current tab: ${before || '(blank)'}`);
    if (shouldOpen || !onTarget) {
      // Navigating destroys a half-filled form, so it happens only when the tab is somewhere else or
      // the caller asked for it by name.
      console.error(`opening ${targetUrl} (the form itself is an iframe inside this page)`);
      await navigateOnce({ ...connection, url: targetUrl });
      await new Promise((r) => setTimeout(r, 2500));
    } else {
      console.error('reusing the tab that is already on the form — no navigation, so nothing is lost');
    }

    const ready = await waitForForm(connection);
    if (!ready.ok) {
      outcome = {
        ok: false,
        reason: ready.reason,
        detail: ready.snapshot?.detail || null,
        frameSrc: ready.snapshot?.frameSrc || null,
        keepOpen: true
      };
      leaveOpen = true;
      writeJson(outPath, { outcome, snapshot: ready.snapshot || null });
      console.log(JSON.stringify({ ...outcome, out: outPath }, null, 2));
      return;
    }
    console.error(`form readable after ${ready.waitedMs}ms (mode=${ready.snapshot.mode || 'n/a'})`);

    if (discover) {
      writeJson(outPath, { when: new Date().toISOString(), url: targetUrl, snapshot: ready.snapshot });
      leaveOpen = true;
      console.log(JSON.stringify({
        ok: true,
        discovered: outPath,
        step: ready.snapshot.step,
        headings: ready.snapshot.headings,
        fields: (ready.snapshot.fields || []).map((f) => ({
          label: f.label, name: f.name, type: f.type, required: f.required, options: f.options
        })),
        buttons: (ready.snapshot.buttons || []).map((b) => b.label),
        keepOpen: true
      }, null, 2));
      return;
    }

    outcome = await runApplication({
      evaluate: (expression) => evaluateJson({ ...connection, expression }),
      profile,
      options: {
        dryRun,
        includeTyping,
        handoffAt: CHATTER_APPLY.steps.handoffAt,
        typingTest: CHATTER_APPLY.steps.typingTest,
        speedTest: CHATTER_APPLY.steps.speedTest
      },
      log: (entry) => console.error(
        `  ${entry.event}${entry.step ? ` step ${entry.step}` : ''}`
        + ` — ${entry.action || entry.reason || ''}`
        + `${entry.applied ? ` (+${entry.applied})` : ''}`
        + `${entry.moved === false ? ' (did not move)' : ''}`
      )
    });
    leaveOpen = outcome.keepOpen !== false;

    writeJson(outPath, { when: new Date().toISOString(), url: targetUrl, profileKeys: Object.keys(profile), outcome });
    console.log(JSON.stringify({
      ok: outcome.ok,
      handoff: Boolean(outcome.handoff),
      stoppedAt: outcome.step ?? null,
      reason: outcome.reason || null,
      message: describeOutcome(outcome),
      steps: (outcome.steps || []).map((s) => ({
        step: s.step,
        heading: (s.headings || [])[0] || null,
        fields: (s.fields || []).length,
        filled: (s.planned || []).length,
        unresolved: (s.unresolved || []).map((u) => u.label)
      })),
      needsValues: outcome.needsValues || [],
      failures: outcome.failures || [],
      transcript: outPath,
      keepOpen: leaveOpen
    }, null, 2));
  } finally {
    if (closeWhenDone) {
      try { await runtime.closeProfile(identity.envId); } catch { /* already gone */ }
      console.error('profile closed (--close)');
    } else {
      console.error(leaveOpen
        ? 'browser left OPEN on purpose — take over from here, and close the profile yourself when done.'
        : 'browser left open; pass --close to shut the profile down when the run ends.');
    }
  }
}

main().catch((error) => {
  console.error(`failed: ${error?.message || error}`);
  process.exit(1);
});

