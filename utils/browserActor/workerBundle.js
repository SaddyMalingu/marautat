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
  // The rule that decides whether a link can earn, shared by the portal's funnel and the runner. Named here because the
  // day it was only in a server-side file, `applyCaptures.js` imported it and every worker died with
  // ERR_MODULE_NOT_FOUND before running a capture (2026-11-17).
  'utils/browserActor/referralCode.js',
  'scripts/browser_actor_referrals.mjs',
  // The OF application runner rides the same worker: the profile is on the tenant's machine, so the
  // browser that fills the form has to be driven from there. A zip without it would claim an apply
  // run and fail — the same mistake the listener made on 2026-11-04.
  'scripts/browser_actor_chatterapply.mjs',
  // The listener rides the same worker since 2026-11-04: it needs the same profile, the same
  // token and the same context call, and a zip without it would claim a listen run and fail.
  'scripts/browser_actor_social_listen.mjs',
  'utils/browserActor/tasks/socialPlatforms.js'
]);

/**
 * Modules under `utils/browserActor` that the worker never loads.
 *
 * `workerBundle.js` *builds* the zip, so shipping it inside the zip is dead weight — and it is the one file that cannot
 * satisfy the bundle's own rule, because it imports `../zipStore.js`, which is server-side. Keeping it out makes the
 * invariant true for every file that does ship: an import in the zip always resolves inside the zip (2026-11-17).
 */
export const SERVER_ONLY_MODULES = Object.freeze(new Set(['utils/browserActor/workerBundle.js']));

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

  // One-click setup (2026-11-07): fetches Node into runtime\ and puts an Alphadome icon on the
  // Desktop. Added as optional extras rather than required entries, because a tenant who
  // already has Node can start the worker without ever opening them — and a zip that refused
  // to build without an icon would be a worse failure than a bundle missing one.
  for (const name of ['Install Worker.cmd', 'Alphadome.ico']) {
    try {
      entries.push({ name, data: read(path.join('worker-bundle', name)) });
    } catch (error) {
      console.warn('[bundle] ' + name + ' is missing from worker-bundle/ — the zip will still work, ' +
        'but the tenant gets no one-click installer. Run: node scripts/make_worker_icon.mjs');
    }
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
  // And the listener since 2026-11-04, for every social network: one script, told which site to
  // read with `--platform`. Its per-site descriptions live in `tasks/`, which is copied with the
  // rest of `utils/browserActor` below.
  entries.push({ name: 'scripts/browser_actor_social_listen.mjs', data: read(path.join('scripts', 'browser_actor_social_listen.mjs')) });
  // And the OF application runner since 2026-11-14: it drives a real application form, so the browser that
  // does it must be the tenant's own. Its modules live under `utils/browserActor`, which is copied below.
  entries.push({ name: 'scripts/browser_actor_chatterapply.mjs', data: read(path.join('scripts', 'browser_actor_chatterapply.mjs')) });
  for (const file of listModuleFiles(path.join(repoRoot, 'utils', 'browserActor'))) {
    const name = path.relative(repoRoot, file).split(path.sep).join('/');
    if (SERVER_ONLY_MODULES.has(name)) continue;
    entries.push({ name, data: fs.readFileSync(file) });
  }
  entries.push({ name: 'utils/tenantRunnerIdentity.js', data: read(path.join('utils', 'tenantRunnerIdentity.js')) });
  entries.push({ name: 'utils/tenantAccess.js', data: read(path.join('utils', 'tenantAccess.js')) });

  const missing = REQUIRED_ENTRIES.filter((name) => !entries.some((entry) => entry.name === name));
  if (missing.length) throw new Error(`worker bundle is missing: ${missing.join(', ')}`);

  const zip = buildZipStore(entries, { mtime });
  return { zip, entries, bytes: zip.length };
}
