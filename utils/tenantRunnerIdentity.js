/**
 * Which browser a runner should drive, per tenant (2026-11-02)
 *
 * The runners started life reading `BROWSER_ACTOR_PROFILES` — an operator's env map, which
 * works for a hosted profile but cannot carry a **tenant's own** MoreLogin key, because that
 * key belongs in the database, sealed, one row per tenant.
 *
 * So resolution order is explicit and the reason is not performance:
 *
 *   1. **tenant**  `site_tenants.metadata.browserAccess` — the tenant's own profile and key.
 *                  Wins, always: a tenant who connected their own browser must never be run
 *                  through the operator's profile by accident.
 *   2. **hosted**  `BROWSER_ACTOR_PROFILES` — how the first tenant was onboarded, kept so
 *                  existing pilots keep working.
 *   3. **default** `BROWSER_ACTOR_DEFAULT_ENV_ID` — single-profile demo mode.
 *
 * A tenant with none of the three is refused (`profile_unmapped`), never guessed: two
 * tenants sharing a browser is the one mistake this subsystem must not make.
 *
 * A seal that will not open is refused with `reconnect_required` rather than silently
 * falling back to the hosted profile — running as the wrong account is worse than stopping.
 */
import { BrowserActorError } from './browserActor/errors.js';
import { parseProfileMap } from './browserActor/identity.js';
import { openSecretFromEnv, readAccess, secretsConfigured, ACCESS_KEY_ENV, ACCESS_KEY_PREVIOUS_ENV } from './tenantAccess.js';

export const RUNNER_IDENTITY_SOURCES = Object.freeze(['tenant', 'hosted', 'default']);

/**
 * @param {{supabase: object, tenantSlug: string, env?: object}} input
 * @returns {Promise<{envId: string, runtime: 'local'|'cloud', apiKey: string|null, label: string|null, source: string}>}
 */
export async function resolveRunnerIdentity({ supabase, tenantSlug, env = process.env } = {}) {
  const slug = String(tenantSlug || '').trim().toLowerCase();
  if (!slug) throw new BrowserActorError('invalid_request', 'tenant is required');

  let metadata = null;
  if (supabase) {
    const { data, error } = await supabase
      .from('site_tenants')
      .select('id, slug, metadata')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw error;
    metadata = data?.metadata || null;
  }

  const access = readAccess(metadata);
  if (access) {
    if (!access.keySealed) {
      throw new BrowserActorError('profile_unmapped', `Tenant "${slug}" has a browser profile but no stored key`, {
        details: { tenant: slug, fix: 'Reconnect the MoreLogin profile from the portal' }
      });
    }
    if (!secretsConfigured(env)) {
      throw new BrowserActorError('not_configured', `Cannot open the tenant's MoreLogin key without ${ACCESS_KEY_ENV}`, {
        details: { tenant: slug, env: ACCESS_KEY_ENV }
      });
    }
    const opened = openSecretFromEnv(access.keySealed, env);
    if (opened.source === 'previous') {
      // Half-finished rotation: this runs, but the tenant should reconnect so the seal
      // moves to the current key and the retiring one can actually be removed.
      console.error(`[runner-identity] tenant=${slug} still sealed with ${ACCESS_KEY_PREVIOUS_ENV} — ask them to reconnect`);
    }
    const apiKey = opened.value;
    if (!apiKey) {
      throw new BrowserActorError('profile_unmapped', `The stored MoreLogin key for "${slug}" can no longer be read`, {
        details: { tenant: slug, reason: 'reconnect_required' }
      });
    }
    return {
      envId: access.envId,
      runtime: access.runtime,
      apiKey,
      label: access.label,
      source: 'tenant'
    };
  }

  const map = parseProfileMap(env.BROWSER_ACTOR_PROFILES || '');
  const hosted = map[slug];
  if (hosted?.envId) {
    return {
      envId: String(hosted.envId),
      runtime: hosted.runtime === 'cloud' ? 'cloud' : 'local',
      apiKey: null,
      label: hosted.label || null,
      source: 'hosted'
    };
  }

  const fallback = String(env.BROWSER_ACTOR_DEFAULT_ENV_ID || '').trim();
  if (fallback) {
    return { envId: fallback, runtime: 'local', apiKey: null, label: 'default', source: 'default' };
  }

  throw new BrowserActorError('profile_unmapped', `No browser is mapped to tenant "${slug}"`, {
    details: {
      tenant: slug,
      fix: 'Connect a MoreLogin profile from the tenant portal, or add the tenant to BROWSER_ACTOR_PROFILES'
    }
  });
}
