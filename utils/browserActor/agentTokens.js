/**
 * Tenant worker tokens (2026-11-02)
 *
 * A worker runs on the tenant's own machine, because that is where a desktop MoreLogin
 * profile can be driven. It therefore needs a credential that is **scoped to one tenant**
 * and cannot be mistaken for a platform credential: it may only see and claim that
 * tenant's queued runs, and nothing else in the system.
 *
 * Three rules, each of which fails silently if broken:
 *
 *   1. **The token is stored hashed.** A database leak must not become a working
 *      credential, and "we can look it up to help you" is not a feature we want.
 *   2. **A token is revocable without being deleted**, so "this worker existed and was
 *      switched off" survives. `revoked_at` is the off switch; the row stays.
 *   3. **Comparison is constant-time.** A prefix check is fine for display, but the
 *      verification path uses `timingSafeEqual`, because the lookup itself is a hash and
 *      the comparison should not leak how much of a wrong token was right.
 *
 * Pure apart from the store; the crypto is testable without a database.
 */
import crypto from 'node:crypto';

export const AGENT_TOKEN_TABLE = 'browser_actor_agent_tokens';

/** Marks the credential's purpose at a glance, in logs and in the UI. */
export const AGENT_TOKEN_PREFIX = 'wkr';

/** 24 random bytes -> 32 base64url characters. Long enough that guessing is not a thing. */
const TOKEN_BYTES = 24;

export function hashAgentToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/** A new token: the plaintext is returned once and never stored. */
export function createAgentToken({ label = null } = {}) {
  const secret = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const token = `${AGENT_TOKEN_PREFIX}_${secret}`;
  return {
    token,
    tokenHash: hashAgentToken(token),
    // Enough to identify a worker in a list, not enough to use it.
    tokenPrefix: `${AGENT_TOKEN_PREFIX}_${secret.slice(0, 4)}`,
    label: label ? String(label).slice(0, 80) : null
  };
}

/** `Authorization: Bearer wkr_…` -> the token, or null. */
export function bearerTokenFromHeader(header) {
  const match = String(header || '').match(/^Bearer\s+([A-Za-z0-9_-]+)$/i);
  return match ? match[1] : null;
}

/** Constant-time comparison of a presented token against a stored hash. */
export function tokenMatchesHash(token, hash) {
  const a = Buffer.from(hashAgentToken(token), 'utf8');
  const b = Buffer.from(String(hash || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** What a tenant is allowed to see about their own workers. */
export function describeAgentToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label || null,
    prefix: row.token_prefix || null,
    createdAt: row.created_at || null,
    lastUsedAt: row.last_used_at || null,
    revoked: Boolean(row.revoked_at),
    revokedAt: row.revoked_at || null
  };
}

/**
 * The store. `table()` returns a query builder, so tests need no database.
 */
export function createAgentTokenStore({ table, now = () => Date.now() } = {}) {
  if (typeof table !== 'function') throw new Error('createAgentTokenStore needs a table() function');

  return {
    async issue({ tenantId, label }) {
      const created = createAgentToken({ label });
      const { data, error } = await table()
        .insert({
          tenant_id: tenantId,
          label: created.label,
          token_hash: created.tokenHash,
          token_prefix: created.tokenPrefix
        })
        .select('*')
        .maybeSingle();
      if (error) throw error;
      // The plaintext leaves the building exactly once, here.
      return { token: created.token, row: data || null };
    },

    async list({ tenantId }) {
      const { data, error } = await table()
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },

    /** Find a live token by value. Revoked tokens are not "found", they are refused. */
    async findLive(token) {
      const { data, error } = await table()
        .select('*')
        .eq('token_hash', hashAgentToken(token))
        .is('revoked_at', null)
        .maybeSingle();
      if (error) throw error;
      const row = data || null;
      // Belt and braces: the query already matched on a hash, so a caller cannot bypass
      // verification by passing a hash instead of a token.
      if (!row || !tokenMatchesHash(token, row.token_hash)) return null;
      return row;
    },

    /** Best-effort: a failed touch must not fail the request that used the token. */
    async touch({ id }) {
      try {
        await table().update({ last_used_at: new Date(now()).toISOString() }).eq('id', id);
      } catch { /* usage telemetry only */ }
    },

    async revoke({ tenantId, id }) {
      const { data, error } = await table()
        .update({ revoked_at: new Date(now()).toISOString() })
        .eq('id', String(id))
        .eq('tenant_id', tenantId)
        .is('revoked_at', null)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      return data || null;
    }
  };
}
