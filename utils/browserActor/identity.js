/**
 * Tenant -> MoreLogin profile identity (2026-10-31)
 *
 * A MoreLogin profile is not just a browser: it is the tenant's persistent
 * anti-detection identity (fingerprint, proxy, cookies, logged-in sessions).
 * Two tenants must never share one, or tenant A's cookies answer tenant B's
 * questions. So the mapping is explicit and validated, never inferred.
 *
 * Resolution order, highest first:
 *   1. BROWSER_ACTOR_PROFILES  — JSON map { "tenant-slug": "envId" | { envId, runtime, label, phoneId } }
 *   2. browser_identities table — rows shaped like { tenant_slug, env_id, runtime, label, phone_id }
 *   3. BROWSER_ACTOR_DEFAULT_ENV_ID — single-profile demo mode
 *
 * Everything here is pure so the rules can be tested without MoreLogin, a
 * database, or a network. IDs are decimal strings end to end: MoreLogin uses
 * 64-bit integers and JSON numbers lose precision past 2^53.
 */
import { BrowserActorError } from './errors.js';

export const IDENTITY_TABLE = 'browser_identities';
export const SESSION_TABLE = 'browser_actor_sessions';
export const IDENTITY_MIGRATION = 'migrations/2026-10-31_browser_actor_runtime.sql';

const ENV_ID_RE = /^\d{1,20}$/;
const RUNTIMES = new Set(['local', 'cloud']);

/** Tenant slugs are already the Alphadome convention (site_tenants.slug). */
export function normalizeTenantSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function coerceEntry(tenantSlug, raw) {
  if (raw == null) return null;
  if (typeof raw === 'string' || typeof raw === 'number') {
    return { tenantSlug, envId: String(raw), runtime: 'local', label: null, phoneId: null };
  }
  if (typeof raw !== 'object') return null;
  const envId = raw.envId ?? raw.env_id ?? null;
  if (envId == null) return null;
  const runtime = String(raw.runtime || 'local').toLowerCase();
  return {
    tenantSlug,
    envId: String(envId),
    runtime: RUNTIMES.has(runtime) ? runtime : 'local',
    label: raw.label ? String(raw.label).slice(0, 120) : null,
    phoneId: raw.phoneId ?? raw.phone_id ? String(raw.phoneId ?? raw.phone_id) : null
  };
}

/**
 * Parse the BROWSER_ACTOR_PROFILES value. Accepts either a JSON string or an
 * already-parsed object. A malformed map is a config_error, not an empty map:
 * silently resolving nobody would look like "tenant not onboarded" and hide a
 * typo in a deploy.
 */
export function parseProfileMap(raw) {
  if (raw == null || raw === '') return {};
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new BrowserActorError('not_configured', 'BROWSER_ACTOR_PROFILES is not valid JSON', {
        details: { hint: 'expected {"tenant-slug":"envId"} or {"tenant-slug":{"envId":"...","runtime":"local"}}' },
        cause: error
      });
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BrowserActorError('not_configured', 'BROWSER_ACTOR_PROFILES must be an object keyed by tenant slug');
  }

  const map = {};
  for (const [key, value] of Object.entries(parsed)) {
    const slug = normalizeTenantSlug(key);
    if (!slug) continue;
    const entry = coerceEntry(slug, value);
    if (entry) map[slug] = entry;
  }
  return map;
}

export function isValidEnvId(value) {
  return ENV_ID_RE.test(String(value ?? '').trim());
}

export function listIdentities(map) {
  return Object.values(map || {}).sort((a, b) => a.tenantSlug.localeCompare(b.tenantSlug));
}


/**
 * Resolve one tenant to one profile.
 *
 * @param {{tenantSlug: string, map?: object, tableRows?: object[], defaultEnvId?: string}} input
 * @returns {{tenantSlug: string, envId: string, runtime: 'local'|'cloud', label: string|null, phoneId: string|null, source: string}}
 */
export function resolveIdentity({ tenantSlug, map = {}, tableRows = [], defaultEnvId = '' } = {}) {
  const slug = normalizeTenantSlug(tenantSlug);
  if (!slug) {
    throw new BrowserActorError('invalid_request', 'tenant is required (a site_tenants slug)');
  }

  const fromMap = map[slug];
  if (fromMap) {
    assertUsable(fromMap, 'BROWSER_ACTOR_PROFILES');
    return { ...fromMap, source: 'env_map' };
  }

  const row = (Array.isArray(tableRows) ? tableRows : []).find(
    (candidate) => normalizeTenantSlug(candidate?.tenant_slug ?? candidate?.tenantSlug) === slug
  );
  if (row) {
    const entry = coerceEntry(slug, {
      envId: row.env_id ?? row.envId,
      runtime: row.runtime,
      label: row.label,
      phoneId: row.phone_id ?? row.phoneId
    });
    if (entry) {
      assertUsable(entry, IDENTITY_TABLE);
      return { ...entry, source: 'table' };
    }
  }

  const fallback = String(defaultEnvId || '').trim();
  if (fallback) {
    const entry = coerceEntry(slug, { envId: fallback, runtime: 'local', label: 'default' });
    assertUsable(entry, 'BROWSER_ACTOR_DEFAULT_ENV_ID');
    return { ...entry, source: 'default' };
  }

  throw new BrowserActorError('profile_unmapped', `No MoreLogin profile is mapped to tenant "${slug}"`, {
    details: {
      tenant: slug,
      fix: `Add "${slug}" to BROWSER_ACTOR_PROFILES or insert a row into ${IDENTITY_TABLE} (${IDENTITY_MIGRATION})`
    }
  });
}

function assertUsable(entry, source) {
  if (!isValidEnvId(entry.envId)) {
    throw new BrowserActorError('not_configured', `Invalid MoreLogin envId in ${source}`, {
      details: { envId: String(entry.envId), expected: 'decimal string, e.g. "1673823102599682"' }
    });
  }
  if (!RUNTIMES.has(entry.runtime)) {
    throw new BrowserActorError('not_configured', `Invalid runtime in ${source}`, {
      details: { runtime: entry.runtime, expected: 'local | cloud' }
    });
  }
}

/** Show enough of an ID to correlate logs, not enough to reuse it. */
export function maskEnvId(envId) {
  const value = String(envId ?? '');
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}

/** Public shape for /profiles and logs. No tokens, no full profile IDs. */
export function describeIdentity(identity) {
  return {
    tenant: identity.tenantSlug,
    envIdMasked: maskEnvId(identity.envId),
    runtime: identity.runtime,
    label: identity.label || null,
    phoneId: identity.phoneId || null,
    source: identity.source || null
  };
}
