/**
 * The tenant worker as one downloadable file (2026-11-02)
 *
 * The first version of the worker was a command line meant for someone with a checkout of
 * this repo. That was not a product: the tenant most likely to need it is a recruiter with
 * MoreLogin open in another window, not a developer.
 *
 * What makes this safe to hand out is what it **leaves out**:
 *
 *   - no `.env` and no credentials of any kind — the zip is built from source files and a
 *     generated config that contains only the portal URL;
 *   - no `node_modules`, because every module the capture needs is plain Node (the browser
 *     layer talks CDP and `ml-cli` directly), so there is nothing to install and nothing to
 *     audit for a supply-chain surprise;
 *   - nothing tenant-specific. The token is typed by the tenant on their own machine and
 *     never leaves it except as an `Authorization` header.
 *
 * The files are the **real** repo files, not copies. A copy would drift, and the day it drifts
 * is the day a tenant runs a capture path nobody tested.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildZipStore } from '../zipStore.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Files that must exist in the zip or the worker cannot start. */
export const REQUIRED_ENTRIES = Object.freeze([
  'Start Worker.cmd',
  'start-worker.sh',
  'README.txt',
  'package.json',
  'worker-config.json',
  'scripts/browser_actor_worker.mjs',
  'scripts/browser_actor_micro1.mjs',
  'utils/tenantRunnerIdentity.js',
  'utils/tenantAccess.js',
  'utils/browserActor/moreloginClient.js',
  'utils/browserActor/runtime.js',
  'utils/browserActor/cdp.js',
  'utils/browserActor/applyCaptures.js',
  'scripts/browser_actor_referrals.mjs',
  // The listener rides the same worker since 2026-11-04: it needs the same profile, the same
  // token and the same context call, and a zip without it would claim a listen run and fail.
  'scripts/browser_actor_linkedin_listen.mjs',
  'utils/browserActor/tasks/linkedinListen.js'
]);

/** Every module under a directory, sorted so two builds are identical. */
function listModuleFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listModuleFiles(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/**
 * @param {{apiBase: string, pairCode?: string|null, repoRoot?: string, mtime?: Date}} input
 * @returns {{zip: Buffer, entries: {name: string, data: Buffer}[], bytes: number}}
 */
export function buildWorkerBundle({ apiBase, pairCode = null, repoRoot = REPO_ROOT, mtime = new Date(0) } = {}) {
  const api = String(apiBase || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(api)) throw new Error('buildWorkerBundle needs the portal base URL');

  const read = (relPath) => fs.readFileSync(path.join(repoRoot, relPath));
  const entries = [];

  // Templates the tenant reads. Present as files so they can be edited and reviewed like code.
  for (const name of ['Start Worker.cmd', 'start-worker.sh', 'README.txt']) {
    entries.push({ name, data: read(path.join('worker-bundle', name)) });
  }

  entries.push({
    name: 'package.json',
    data: JSON.stringify({
      name: 'alphadome-worker',
      private: true,
      // Required: the repo's shared modules are ESM `.js` files.
      type: 'module',
      description: 'Alphadome capture worker — runs on this computer, next to your MoreLogin profile.'
    }, null, 2)
  });
  entries.push({
    name: 'worker-config.json',
    // The portal URL only. Never a token: that is typed on the machine, once.
    data: JSON.stringify({ api }, null, 2)
  });

  // The pairing code is what removes the copy-paste. It is single-use and short-lived, so a
  // download that gets forwarded stops working after the first run — see
  // migrations/2026-11-02_browser_pairings.sql.
  if (pairCode) {
    entries.push({ name: 'pair-code.txt', data: `${String(pairCode).trim()}\n` });
  }

  entries.push({ name: 'scripts/browser_actor_worker.mjs', data: read(path.join('scripts', 'browser_actor_worker.mjs')) });
  entries.push({ name: 'scripts/browser_actor_micro1.mjs', data: read(path.join('scripts', 'browser_actor_micro1.mjs')) });
  // Turing runs on the same worker since 2026-11-03 (agent mode), so the bundle carries the
  // runner the worker dispatches to — a zip without it would queue Turing and fail on claim.
  entries.push({ name: 'scripts/browser_actor_referrals.mjs', data: read(path.join('scripts', 'browser_actor_referrals.mjs')) });
  // And the listener since 2026-11-04. It imports `utils/socialIntent.js` for nothing at runtime —
  // scoring is server-side — but the adapter's DOM expressions live in `tasks/`, which is copied
  // with the rest of `utils/browserActor` below.
  entries.push({ name: 'scripts/browser_actor_linkedin_listen.mjs', data: read(path.join('scripts', 'browser_actor_linkedin_listen.mjs')) });
  for (const file of listModuleFiles(path.join(repoRoot, 'utils', 'browserActor'))) {
    entries.push({ name: path.relative(repoRoot, file).split(path.sep).join('/'), data: fs.readFileSync(file) });
  }
  entries.push({ name: 'utils/tenantRunnerIdentity.js', data: read(path.join('utils', 'tenantRunnerIdentity.js')) });
  entries.push({ name: 'utils/tenantAccess.js', data: read(path.join('utils', 'tenantAccess.js')) });

  const missing = REQUIRED_ENTRIES.filter((name) => !entries.some((entry) => entry.name === name));
  if (missing.length) throw new Error(`worker bundle is missing: ${missing.join(', ')}`);

  const zip = buildZipStore(entries, { mtime });
  return { zip, entries, bytes: zip.length };
}
