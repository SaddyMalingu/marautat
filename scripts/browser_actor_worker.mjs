#!/usr/bin/env node

/**
 * Tenant worker (2026-11-02)
 *
 * Runs on the computer where the tenant's MoreLogin **desktop** profile lives, because that
 * is the only place a local profile can be driven. It claims queued runs from the portal,
 * executes the same capture script an operator would run, and reports the outcome — so the
 * tenant gets a working "Capture now" button without either of us exposing a debug port.
 *
 * What it deliberately does not do: hold a password (nothing to hold — the tenant already
 * signed in inside their own profile), read other tenants' data (the token is scoped), or
 * decide policy (the server says what to run).
 *
 * Usage, on the tenant's machine, from a checkout of this repo:
 *   node scripts/browser_actor_worker.mjs --api https://alphadome.onrender.com --token wkr_…
 *
 * Or, from the zip the portal hands out (what a non-technical tenant actually does):
 *   "Start Worker.cmd"        (Windows)  /  ./start-worker.sh   (macOS, Linux)
 *
 * Flags:
 *   --api <url>        portal base URL (default: $ALPHADOME_API, then --config, then worker-config.json)
 *   --token <token>    worker token from the portal (default: $TENANT_WORKER_TOKEN)
 *   --token-file <p>   read the token from a file instead of the command line, so it does not
 *                      appear in a process list or a shell history
 *   --pair-file <p>    redeem a setup code from the download instead of pasting a token; the
 *                      code is exchanged once for a real token, then deleted
 *   --install          after pairing, register the worker to start at sign-in and run hidden
 *                      (Windows). Nothing to keep open afterwards.
 *   --quiet            log to worker.log instead of the console (used by the auto-start entry)
 *   --config <p>       json file holding { "api": "https://…" } — no secrets in it
 *   --tenant <slug>    only required when the repo's env has no BROWSER_ACTOR_DEFAULT_ENV_ID
 *   --once             claim at most one run, then exit (for a scheduled task)
 *   --interval <ms>    poll interval when idle (default 15000)
 */
// Operator convenience only. The tenant bundle has no node_modules, so this must not be a
// hard import: a missing dotenv just means the environment already has what it needs.
try { await import('dotenv/config'); } catch { /* not installed */ }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { extractAgentToken } from '../utils/browserActor/agentTokens.js';
import { runPlatform, canRunOnWorker } from '../utils/browserActor/runs.js';
import { extractPairingCode } from '../utils/browserActor/pairing.js';
import { maskEnvId } from '../utils/browserActor/identity.js';
import { createMoreloginClient } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

/** Config is a convenience for the bundled worker: a file next to the script, no secrets. */
function readConfig() {
  const explicit = flag('config');
  const candidates = [
    typeof explicit === 'string' ? path.resolve(explicit) : null,
    path.resolve('worker-config.json')
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed?.api) return parsed;
    } catch { /* next candidate */ }
  }
  return {};
}

/**
 * Pull the token out of whatever was pasted.
 *
 * Lives in `utils/browserActor/agentTokens.js` next to the other token rules, so the parsing
 * that repairs a pasted command line is testable without starting a worker.
 */
function extractToken(raw) {
  return extractAgentToken(raw) || '';
}

function readToken() {
  const fromFlag = flag('token', process.env.TENANT_WORKER_TOKEN || '');
  if (fromFlag && fromFlag !== true) {
    const token = extractToken(fromFlag);
    if (token) return token;
    console.error('That --token value does not contain a wkr_ token.');
  }
  const file = flag('token-file');
  if (typeof file === 'string') {
    const resolved = path.resolve(file);
    let value = '';
    try {
      value = fs.readFileSync(resolved, 'utf8');
    } catch { return ''; }
    const token = extractToken(value);
    if (!token) return '';
    if (value.trim() !== token) {
      // Repair the file in place: leaving the whole command line in there would repeat this
      // confusion on every start.
      try { fs.writeFileSync(resolved, `${token}\n`); } catch { /* read-only: not fatal */ }
      console.error('note: worker-token.txt held more than the token — kept just the wkr_ part.');
    }
    return token;
  }
  return '';
}

/** Last resort for a tenant who double-clicked the script itself. */
async function askForToken() {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question('Paste your worker token (it starts with wkr_), then press Enter: ', resolve));
  rl.close();
  const token = extractToken(answer);
  if (!token && String(answer || '').trim()) {
    console.error('That did not look like a worker token — it should start with wkr_ and come from your portal.');
  }
  return token;
}

/**
 * Redeem the setup code that came inside the download (2026-11-02).
 *
 * This is the convenience: no credential to copy between two applications. The code is
 * single-use and expires in 30 minutes, and the token it buys is saved locally so the next
 * start needs nothing at all. The file is deleted afterwards so the folder does not keep a
 * spent key lying around.
 */
async function redeemPairingCode() {
  const file = flag('pair-file');
  if (typeof file !== 'string') return '';
  const resolved = path.resolve(file);
  let raw = '';
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch {
    return '';
  }
  const code = extractPairingCode(raw);
  if (!code) return '';
  if (!api) {
    console.error('The setup code needs the portal address — worker-config.json looks empty.');
    return '';
  }

  console.error('setting up with the code in this download…');
  const res = await fetch(`${api}/api/agent/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: error.message }) }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.token) {
    console.error(`setup failed (${res.status || 'no response'}): ${data?.error || 'no message'}`);
    console.error('Download the worker again from the portal to get a fresh code.');
    return '';
  }

  // Keep the token, drop the spent code: the code is worthless now, the token is the thing
  // this machine will use from here on.
  try {
    fs.writeFileSync(path.resolve('worker-token.txt'), `${data.token}\n`);
    fs.rmSync(resolved, { force: true });
  } catch (error) {
    console.error(`could not save worker-token.txt (${error.message}) — the token is only in memory`);
  }
  console.error(`paired with ${data.tenant || 'your tenant'}. This machine is now set up.`);
  return data.token;
}

const config = readConfig();
const api = String(flag('api', process.env.ALPHADOME_API || config.api || '')).replace(/\/+$/, '');
const quiet = flag('quiet', null) !== null;
let token = readToken();
if (!token) token = await redeemPairingCode();
if (!token) token = await askForToken();
const once = flag('once', null) !== null;
const intervalMs = Number(flag('interval', 15_000)) || 15_000;

if (!api || !token) {
  console.error('This worker needs the portal address and a worker token.');
  console.error('Easiest: double-click "Start Worker.cmd" (Windows) or run ./start-worker.sh.');
  console.error('Or: node scripts/browser_actor_worker.mjs --api https://<portal> --token wkr_…');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, pathname, body) {
  const res = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

/** Fail at startup, not halfway through a claim loop. */
async function health() {
  const res = await call('GET', '/api/agent/health');
  if (!res.ok) {
    console.error(`token rejected (${res.status}): ${res.data?.error || 'no message'}`);
    process.exit(2);
  }
  console.error(`worker online for tenant=${res.data.tenant} → ${api}`);
  return res.data.tenant;
}

/**
 * Remember what we learned, so the tenant decides once and never again.
 *
 * `worker-config.json` comes from the download and holds the portal URL. Adding the profile
 * id keeps the file free of anything secret while removing a MoreLogin call on every start.
 */
function rememberConfig(patch) {
  const file = path.resolve('worker-config.json');
  try {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
    fs.writeFileSync(file, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
  } catch (error) {
    console.error(`note: could not save worker-config.json (${error.message}) — pass --env-id next time`);
  }
}

/**
 * Which browser is on this computer? (2026-11-03)
 *
 * This is the step that made setup feel like homework: paste a MoreLogin API key, then choose
 * a profile id from a list. Both questions are answerable by the machine the worker is
 * already running on — `ml-cli env list` needs no key — so it answers them itself and the
 * tenant never sees an id.
 *
 * Order, cheapest first:
 *   1. `--env-id` / `ML_ENV_ID` — someone who knows what they want should not wait for a probe.
 *   2. what a previous start remembered in `worker-config.json`;
 *   3. MoreLogin's own list: one profile needs no decision, several matching the tenant name
 *      is still unambiguous, and anything else is printed for the tenant to pick once.
 */
async function discoverProfile(tenantSlug) {
  const explicit = flag('env-id', process.env.ML_ENV_ID || config.envId || null);
  if (explicit && explicit !== true) {
    return { envId: String(explicit).trim(), envName: null, why: 'configured' };
  }

  let items = [];
  try {
    const runtime = createBrowserRuntime({ client: createMoreloginClient({}) });
    const listed = await runtime.listProfiles({ pageNo: 1, pageSize: 50 });
    items = (listed.items || []).filter((item) => item.envId);
  } catch (error) {
    // No MoreLogin, or ml-cli is not installed. Say the real reason once: it is more useful
    // than the 409 this would otherwise turn into after a claim.
    console.error(`could not read the MoreLogin profiles on this computer: ${error?.message || error}`);
    if (error?.details?.install) console.error(`  install it from ${error.details.install}, or pass --env-id <profileId>`);
    return null;
  }

  if (!items.length) {
    console.error('MoreLogin is running but has no browser profiles on this computer — create one and sign into Micro1 inside it.');
    return null;
  }
  if (items.length === 1) {
    return { envId: String(items[0].envId), envName: items[0].envName, why: 'only one profile' };
  }

  // Several profiles: prefer one that names the tenant, because that is how a recruiter with
  // two clients will have labelled it.
  const tokens = String(tenantSlug || '').toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 2);
  const named = items.filter((item) => {
    const haystack = `${item.envName || ''} ${item.groupName || ''}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });
  if (named.length === 1) {
    return { envId: String(named[0].envId), envName: named[0].envName, why: 'named after the tenant' };
  }

  console.error(`MoreLogin has ${items.length} profiles on this computer, so I cannot tell which is yours:`);
  for (const item of items) {
    console.error(`  · ${item.envName || '(no name)'} — ${maskEnvId(item.envId)}${item.running ? ' (running)' : ''}`);
  }
  console.error('Run once with the one you use: node scripts/browser_actor_worker.mjs --env-id <profileId>');
  console.error('It is remembered in worker-config.json afterwards, so this is a one-time choice.');
  return null;
}

/**
 * Tell the portal which browser this computer uses.
 *
 * Without this the server has no idea, a capture queues, and the run dies on a 409 that the
 * tenant cannot see. One call at startup replaces the whole "connect your profile" ritual
 * for a tenant whose browser lives on their own desk: no key to find, no id to type.
 */
async function reportProfile(profile) {
  const res = await call('POST', '/api/agent/browser', {
    envId: profile.envId,
    label: profile.envName || null,
    machine: os.hostname()
  });
  if (!res.ok) {
    // Older portal, or the route is missing: the worker must still run, because hosted and
    // keyed profiles resolve server-side without this call.
    console.error(`could not report this computer's browser (${res.status}): ${res.data?.error || 'no message'}`);
    if (res.status === 404) console.error('  the portal is probably older than this worker — download the worker again from the portal');
    return false;
  }
  const label = profile.envName ? `"${profile.envName}" ` : '';
  console.error(`browser: ${label}${maskEnvId(profile.envId)} (${profile.why}) — the portal will use it`);
  if (res.data?.uses && res.data.uses !== 'worker') console.error(`note: ${res.data.note}`);
  return true;
}

/**
 * Run one queued run locally.
 *
 * The child is the same capture script an operator uses, pointed at the run id the portal
 * assigned — so progress lands in the run row the tenant is watching, there is one capture
 * path, and this worker contains no browser logic of its own to drift.
 *
 * It runs in **agent mode**: the child gets the portal URL and the worker token, never a
 * database key. It fetches what it needs from `/api/agent/runs/:id/context` and posts the
 * captures back, so the machine doing the browsing holds no credential that could write to
 * another tenant's data.
 */
function runCapture({ tenantSlug, runId, limit }) {
  const args = [
    path.join('scripts', 'browser_actor_micro1.mjs'),
    '--tenant', tenantSlug,
    '--limit', String(limit || 12),
    '--apply',
    '--only-missing',
    '--run-id', String(runId),
    '--agent-api', api
    // The token goes through the environment, not argv: a command line is visible to every
    // process on the machine (Task Manager, `ps`), and this one is a credential.
  ];
  const childEnv = { ...process.env, TENANT_WORKER_TOKEN: token };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: childEnv });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(`could not start the capture: ${error.message}`);
      resolve(1);
    });
  });
}

/**
 * Close a run the child left behind.
 *
 * The child reports its own outcome. When it dies before it can — a refused context, a
 * missing ml-cli, a hard crash — the run stays `running`, and because only one run per tenant
 * may be active, the tenant's next "Capture now" is refused for no visible reason. So after a
 * non-zero exit, close it ourselves; if the child already closed it, the run is no longer in
 * the queued/running list and this does nothing.
 */
async function closeAbandonedRun(runId, code) {
  const listed = await call('GET', '/api/agent/runs').catch(() => null);
  const stillOpen = (listed?.data?.runs || []).some((row) => row.id === runId);
  if (!stillOpen) return;
  const closed = await call('POST', `/api/agent/runs/${encodeURIComponent(runId)}/finish`, {
    status: 'failed',
    message: `the capture stopped with code ${code} before it could report`
  }).catch(() => null);
  console.error(closed?.ok
    ? `run ${runId} closed as failed — press Capture now again after fixing the cause above`
    : `could not close run ${runId} (${closed?.status ?? 'no response'}); the portal will show it as stalled`);
}

/**
 * Which capture script a queued run belongs to, and whether this machine can run it.
 *
 * The rule lives in `utils/browserActor/runs.js` so it is testable; see `runPlatform` and
 * `canRunOnWorker`. Claiming a run this worker cannot drive would take it away from the
 * operator's runner and then capture the wrong marketplace.
 */
function platformOf(run) {
  return runPlatform(run);
}

function canRunHere(run) {
  return canRunOnWorker(run);
}

async function tick(tenantSlug) {
  const listed = await call('GET', '/api/agent/runs');
  if (!listed.ok) {
    console.error(`listing runs failed (${listed.status}): ${listed.data?.error || ''}`);
    return false;
  }
  const queued = (listed.data.runs || []).filter((row) => row.status === 'queued');
  // Leave runs this worker cannot drive alone, and say so once. Claiming one would take it
  // away from the operator's runner and then capture the wrong marketplace.
  const skipped = queued.filter((row) => !canRunHere(row));
  if (skipped.length) {
    const names = [...new Set(skipped.map((row) => platformOf(row) || row.kind || 'unknown'))].join(', ');
    console.error(`skipping ${skipped.length} queued run(s) for ${names}: this worker only drives micro1 — the operator runs those`);
  }
  const run = queued.find(canRunHere);
  if (!run) return false;

  const claimed = await call('POST', `/api/agent/runs/${run.id}/claim`);
  if (!claimed.ok) {
    // Another worker won the race, or the tenant cancelled it. Either way: nothing to do.
    console.error(`could not claim ${run.id} (${claimed.status}) — skipping`);
    return false;
  }

  const limit = Number(claimed.data?.run?.detail?.limit) || 12;
  console.error(`claimed ${run.id} (limit ${limit}) — capturing`);
  const code = await runCapture({ tenantSlug, runId: run.id, limit });
  if (code !== 0) {
    await closeAbandonedRun(run.id, code);
  } else {
    console.error(`capture exited 0; the run row records the outcome`);
  }
  return true;
}

const tenantSlug = await health();
if (!tenantSlug) process.exit(2);

// Which browser is on this computer? The portal cannot answer that — the machine can, and it
// already has MoreLogin open. Reporting it here is what removes the last setup step, and it
// is why a tenant with a local profile no longer needs to find an API key at all.
const localProfile = await discoverProfile(tenantSlug);
if (localProfile) {
  await reportProfile(localProfile);
  rememberConfig({ envId: localProfile.envId, envLabel: localProfile.envName || null });
} else {
  console.error('continuing — captures still work if the portal already has a profile mapped for you');
}

console.error(once ? 'checking for one run…' : `polling every ${Math.round(intervalMs / 1000)}s`);
for (;;) {
  let didWork = false;
  try {
    didWork = await tick(tenantSlug);
  } catch (error) {
    // A network blip must not kill an unattended worker; the next poll retries.
    console.error(`poll failed: ${error?.message || error}`);
  }
  if (once) break;
  if (!didWork) await sleep(intervalMs);
}
