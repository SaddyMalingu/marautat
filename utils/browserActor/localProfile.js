/**
 * Which MoreLogin profile is "this tenant's browser", decided where the answer actually is (2026-11-13)
 *
 * Two questions used to be asked of the person instead of the machine: *what is your API key* and *what is
 * your profile id*. Both have answers on the computer the worker already runs on — `ml-cli env list` needs
 * no key and returns every profile — so this module holds the policy for reading that list and choosing,
 * in one place, testable without a browser.
 *
 * The policy, cheapest first:
 *
 *   1. **explicit** an `--env-id` (or `ML_ENV_ID`, or a remembered `worker-config.json` value). Someone who
 *      knows what they want should not wait for a probe.
 *   2. **only one** — nothing to decide.
 *   3. **named after the tenant** — a recruiter with two clients labels the profiles, so a single match on
 *      the tenant's own words is still unambiguous.
 *   4. otherwise **ask**, and show the list with ids masked, because a profile id is a credential-adjacent
 *      value that should not be pasted into a chat window or a ticket.
 *
 * Nothing here picks between two plausible profiles. Guessing means running as the wrong account, which is
 * the one mistake this subsystem must not make — the same rule `resolveRunnerIdentity` follows server-side.
 */

/** Split a tenant slug into words worth matching against a profile name. */
export function tenantTokens(tenantSlug) {
  return String(tenantSlug || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 2);
}

/**
 * Choose one profile from a list, or say why it cannot.
 *
 * @param {{items?: object[], explicitEnvId?: string|null, tenantSlug?: string}} input
 * @returns {{envId: string|null, envName: string|null, why: string, candidates?: object[]}}
 */
export function chooseLocalProfile({ items = [], explicitEnvId = null, tenantSlug = '' } = {}) {
  const explicit = String(explicitEnvId || '').trim();
  if (explicit) {
    // Trusted as given: it may name a profile the list did not return (another group, a new one).
    return { envId: explicit, envName: null, why: 'configured' };
  }

  const usable = (Array.isArray(items) ? items : []).filter((item) => item && item.envId);
  if (!usable.length) return { envId: null, envName: null, why: 'no_profiles' };
  if (usable.length === 1) {
    return { envId: String(usable[0].envId), envName: usable[0].envName || null, why: 'only one profile' };
  }

  const tokens = tenantTokens(tenantSlug);
  if (tokens.length) {
    const named = usable.filter((item) => {
      const haystack = `${item.envName || ''} ${item.groupName || ''}`.toLowerCase();
      return tokens.some((token) => haystack.includes(token));
    });
    if (named.length === 1) {
      return { envId: String(named[0].envId), envName: named[0].envName || null, why: 'named after the tenant' };
    }
  }

  return {
    envId: null,
    envName: null,
    why: 'several profiles',
    // Reported intact so the caller can print them; masking happens at the point of display.
    candidates: usable.map((item) => ({
      envId: String(item.envId),
      envName: item.envName || null,
      groupName: item.groupName || null,
      running: Boolean(item.running)
    }))
  };
}

/**
 * The list a person reads when they have to pick.
 *
 * The id is masked with the shared helper so a support screenshot never carries a live profile id, but the
 * last four characters stay readable — that is what makes "the one I chose" recognisable.
 */
export function describeProfileChoices(items, maskEnvId) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.envId)
    .map((item) => {
      const id = typeof maskEnvId === 'function' ? maskEnvId(String(item.envId)) : String(item.envId);
      const name = item.envName ? `"${item.envName}"` : '(no name)';
      const group = item.groupName ? ` · ${item.groupName}` : '';
      return `  · ${name}${group} — ${id}${item.running ? ' (running)' : ''}`;
    });
}
