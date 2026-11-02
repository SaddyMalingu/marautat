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
 * Flags:
 *   --api <url>        portal base URL (default: $ALPHADOME_API)
 *   --token <token>    worker token from the portal (default: $TENANT_WORKER_TOKEN)
 *   --tenant <slug>    only required when the repo's .env has no BROWSER_ACTOR_DEFAULT_ENV_ID
 *   --once             claim at most one run, then exit (for a scheduled task)
 *   --interval <ms>    poll interval when idle (default 15000)
 */
import 'dotenv/config';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

const api = String(flag('api', process.env.ALPHADOME_API || '')).replace(/\/+$/, '');
const token = String(flag('token', process.env.TENANT_WORKER_TOKEN || ''));
const once = flag('once', null) !== null;
const intervalMs = Number(flag('interval', 15_000)) || 15_000;

if (!api || !token) {
  console.error('usage: node scripts/browser_actor_worker.mjs --api https://<portal> --token wkr_…');
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
 */
function runCapture({ tenantSlug, runId, limit }) {
  const args = [
    path.join('scripts', 'browser_actor_micro1.mjs'),
    '--tenant', tenantSlug,
    '--limit', String(limit || 12),
    '--apply',
    '--only-missing',
    '--run-id', String(runId)
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
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
