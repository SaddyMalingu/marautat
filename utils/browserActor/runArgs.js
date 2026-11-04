/**
 * The argv a run needs, built where it can be tested (2026-11-04)
 *
 * Why this is a module and not six lines inside the worker: those six lines chose the wrong branch
 * for every social network and nothing caught it. `isListen` compared an **absolute** resolved
 * script path against a **relative** registry entry, so it was always false — the worker handed
 * the listener the *marketplace* arguments (`--limit`, `--apply`, no `--platform`), the listener
 * fell back to its default network, and every "Start on X / YouTube" run silently read LinkedIn.
 *
 * Worse, the log line naming the spawn was hand-written (`--platform ${platform}`) rather than the
 * real argv, so the window *said* it launched X while launching a LinkedIn read. A log that
 * describes an intention instead of the arguments is a log that lies.
 *
 * So: pure, imported by the worker, and asserted directly by the suite.
 */

import { SOCIAL_PLATFORM_IDS } from './tasks/socialPlatforms.js';

/**
 * The one script that serves every social network.
 *
 * Written with a forward slash and never built with `path.join`: on Windows that produces
 * `scripts\browser_actor_social_listen.mjs`, and comparing that against this literal is exactly
 * how every "Start on X" run became a LinkedIn read twice over (2026-11-04). `path.resolve` copes
 * with either separator; string equality does not.
 */
export const SOCIAL_LISTENER = 'scripts/browser_actor_social_listen.mjs';

/** Does this platform run through the social listener? Decided by the platform, never by a path. */
export function usesSocialListener(platform) {
  return SOCIAL_PLATFORM_IDS.includes(String(platform || '').trim().toLowerCase());
}

/**
 * @param {{relative: string, platform: string, tenantSlug: string, runId: string,
 *          limit?: number|string, api: string}} input
 * @returns {string[]} argv for the child, script path first (relative; the caller makes it absolute)
 */
export function buildRunArgs({ relative, platform, tenantSlug, runId, limit, api }) {
  // The branch is chosen by the **platform id**, which is a value the queue route validated,
  // rather than by comparing paths. Paths differ by separator, by resolution and by casing; an id
  // does not. That mistake cost two rounds and four networks.
  if (usesSocialListener(platform)) {
    return [
      relative,
      '--tenant', tenantSlug,
      // Which network to read. Without this the listener defaults to LinkedIn, quietly.
      '--platform', String(platform),
      '--queries', String(Math.min(6, Math.max(1, Number(limit) || 3))),
      '--run-id', String(runId),
      '--agent-api', api
    ];
  }
  return [
    relative,
    '--tenant', tenantSlug,
    '--limit', String(limit || 70),
    '--apply',
    '--only-missing',
    '--run-id', String(runId),
    '--agent-api', api
    // The token goes through the environment, not argv: a command line is visible to every
    // process on the machine (Task Manager, `ps`), and this one is a credential.
  ];
}

/** The argv with the absolute script path swapped in, for `spawn`. */
export function absoluteArgv(argv, resolvePath) {
  if (!Array.isArray(argv) || !argv.length) return argv;
  return [resolvePath(argv[0]), ...argv.slice(1)];
}
