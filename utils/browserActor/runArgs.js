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

/** The one script that serves every social network. */
export const SOCIAL_LISTENER = 'scripts/browser_actor_social_listen.mjs';

/**
 * @param {{relative: string, platform: string, tenantSlug: string, runId: string,
 *          limit?: number|string, api: string}} input
 * @returns {string[]} argv for the child, script path first (relative; the caller makes it absolute)
 */
export function buildRunArgs({ relative, platform, tenantSlug, runId, limit, api }) {
  // Chosen from the *registry* path, which is relative like the map it came from — never from a
  // resolved path, because that comparison is the bug this module exists to prevent.
  if (relative === SOCIAL_LISTENER) {
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
