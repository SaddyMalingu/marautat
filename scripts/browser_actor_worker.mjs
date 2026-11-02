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
 *   --config <p>       json file holding { "api": "https://…" } — no secrets in it
 *   --tenant <slug>    only required when the repo's env has no BROWSER_ACTOR_DEFAULT_ENV_ID
 *   --once             claim at most one run, then exit (for a scheduled task)
 *   --interval <ms>    poll interval when idle (default 15000)
 */
// Operator convenience only. The tenant bundle has no node_modules, so this must not be a
// hard import: a missing dotenv just means the environment already has what it needs.
try { await import('dotenv/config'); } catch { /* not installed */ }
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { extractAgentToken } from '../utils/browserActor/agentTokens.js';

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

const config = readConfig();
const api = String(flag('api', process.env.ALPHADOME_API || config.api || '')).replace(/\/+$/, '');
let token = readToken();
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

async function tick(tenantSlug) {
  const listed = await call('GET', '/api/agent/runs');
  if (!listed.ok) {
    console.error(`listing runs failed (${listed.status}): ${listed.data?.error || ''}`);
    return false;
  }
  const run = (listed.data.runs || []).find((row) => row.status === 'queued');
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
  console.error(`capture exited ${code}; the run row already records the outcome`);
  return true;
}

const tenantSlug = await health();
if (!tenantSlug) process.exit(2);

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
