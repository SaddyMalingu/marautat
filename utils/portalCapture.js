/**
 * Start a capture from the portal, for tenants whose browser is in the cloud (2026-11-02)
 *
 * Why this exists: with BYO MoreLogin the profile lives in **their** cloud, not on an
 * operator's Windows box. So the portal can start it, drive it over CDP and report back
 * without anybody's laptop being involved. That is the difference between "the tenant waits
 * for us" and "the tenant presses a button".
 *
 * Scope, deliberately narrow:
 *   - only a **tenant-owned** profile (source `tenant`), never the operator's hosted one;
 *   - only `runtime: 'cloud'`, because a local profile has no route from Render;
 *   - only Micro1, the marketplace with a verified adapter;
 *   - one run at a time, enforced by the same `browser_actor_runs` index the runners use.
 *
 * Execution is a spawned child process, not inline work: a capture takes tens of seconds,
 * web requests time out, and a redeploy should not leave a half-finished import inside the
 * server process. The route answers 202 immediately and the portal watches the run row.
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { canQueue, createRunStore, RUN_TABLE } from '../utils/browserActor/runs.js';

/** Platforms the server can capture on its own today. One, and honestly so. */
export const SERVER_SIDE_PLATFORMS = Object.freeze(['micro1']);

/**
 * Bounds for a capture.
 *
 * Twelve was one page of the Micro1 grid, and the cap of 24 was written believing a run could
 * only read one page. The runner now pages the listing (`MICRO1_ADVANCE_EXPR`), and a MoreLogin
 * start is scarce enough that a run has to be worth it: seventy roles is a page of work, three to
 * five minutes, and still short enough to finish while someone is watching.
 */
export const CAPTURE_DEFAULT_LIMIT = 70;
export const CAPTURE_MAX_LIMIT = 150;

/**
 * Spawn the existing, tested runner as a child process.
 *
 * Reusing the script rather than re-implementing the loop is the whole point: one capture
 * path, whether an operator or the portal starts it. Its output goes to a log file so a
 * failure is diagnosable, and its report goes to `tmp/run-<id>.json`.
 */
export function defaultSpawnRun({ slug, runId, limit, cwd = process.cwd() }) {
  const outPath = path.resolve(cwd, 'tmp', `run-${runId}.json`);
  const logPath = path.resolve(cwd, 'tmp', `run-${runId}.log`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const log = fs.openSync(logPath, 'a');
  const args = [
    path.join('scripts', 'browser_actor_micro1.mjs'),
    '--tenant', slug,
    '--limit', String(limit),
    '--apply',
    '--only-missing',
    '--run-id', String(runId),
    '--out', outPath
  ];
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: ['ignore', log, log],
    // The child reads the same env the portal has: SUPABASE_* and TENANT_SECRET_KEY.
    env: process.env
  });
  child.unref();
  return { pid: child.pid || null, outPath, logPath };
}
