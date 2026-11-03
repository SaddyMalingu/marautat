/**
 * Pairing codes (2026-11-02)
 *
 * A worker needs a tenant-scoped credential. Making a human copy it between two apps is the
 * step that has failed most in practice — a whole command line pasted into the prompt, and a
 * live token pasted into a chat window. Neither was carelessness; both were an interface
 * asking a non-technical person to move a secret by hand.
 *
 * So the portal mints a **code** instead, ships it inside the download, and the worker trades
 * it once for a real token. The rules mirror agent tokens, plus two of its own:
 *
 *   1. **Hash-only.** A leak of this table yields nothing presentable.
 *   2. **Single use.** `used_at` is set on redemption; a second attempt is refused even if the
 *      code has not expired. A download forwarded to a colleague therefore stops working after
 *      the first run — which is the point.
 *   3. **Short life.** 30 minutes by default: long enough to unzip and double-click, short
 *      enough that a forgotten download is not a permanent key.
 *   4. **The token it becomes is ordinary.** Nothing downstream can tell a paired worker from
 *      one whose token came from the panel, so revocation and audit work identically.
 *
 * Pure apart from the store; the crypto is testable without a database.
 */
import crypto from 'node:crypto';

export const PAIRING_TABLE = 'browser_actor_pairings';

/** Marks the code's purpose at a glance, in a file and in a log. */
export const PAIRING_PREFIX = 'pair';

/** 20 bytes -> 27 base64url characters: short enough to look like a code, long enough to guess-proof. */
const CODE_BYTES = 20;

export const PAIRING_TTL_MS = 30 * 60_000;

export function hashPairingCode(code) {
  return crypto.createHash('sha256').update(String(code || ''), 'utf8').digest('hex');
}

/** A new code. The plaintext goes into the download and is never stored. */
export function createPairingCode({ label = null, now = Date.now(), ttlMs = PAIRING_TTL_MS } = {}) {
  const secret = crypto.randomBytes(CODE_BYTES).toString('base64url');
  return {
    code: `${PAIRING_PREFIX}_${secret}`,
    codeHash: hashPairingCode(`${PAIRING_PREFIX}_${secret}`),
    label: label ? String(label).slice(0, 80) : null,
    expiresAt: new Date(now + ttlMs).toISOString(),
    ttlMs
  };
}

/** Pull a code out of whatever was pasted — a bare code, or a line that contains one. */
export function extractPairingCode(text) {
  const raw = String(text || '').replace(/["'`]/g, ' ').trim();
  if (!raw) return null;
  const match = raw.match(/pair_[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}

/**
 * Is this row still redeemable, at `now`?
 *
 * A used code is spent whether or not it has expired — that is what makes the download safe to
 * hand to one person. An expired one is refused with a message that says how to get another.
 */
export function pairingState(row, now = Date.now()) {
  if (!row) return { ok: false, reason: 'not_found', message: 'That setup code is not valid. Download the worker again from the portal.' };
  if (row.used_at) return { ok: false, reason: 'already_used', message: 'That setup code has already been used. Download the worker again to get a fresh one.' };
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (!expiresAt || Number.isNaN(expiresAt) || expiresAt <= now) {
    return { ok: false, reason: 'expired', message: 'That setup code has expired (they last 30 minutes). Download the worker again.' };
  }
  return { ok: true, reason: 'live', message: '' };
}

/** What a tenant is allowed to see about their own codes. */
export function describePairing(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label || null,
    createdAt: row.created_at || null,
    expiresAt: row.expires_at || null,
    usedAt: row.used_at || null,
    usedTokenId: row.used_token_id || null
  };
}

/**
 * The store. `table()` returns a query builder, so tests need no database.
 *
 * `redeem` is a compare-and-set on `used_at`: two machines racing with the same code means one
 * wins and the other gets `already_used`, without a lock or a transaction.
 */
export function createPairingStore({ table, now = () => Date.now() } = {}) {
  if (typeof table !== 'function') throw new Error('createPairingStore needs a table() function');

  return {
    async issue({ tenantId, label }) {
      const created = createPairingCode({ label, now: now() });
      const { data, error } = await table()
        .insert({
          tenant_id: tenantId,
          label: created.label,
          code_hash: created.codeHash,
          expires_at: created.expiresAt
        })
        .select('*')
        .maybeSingle();
      if (error) throw error;
      return { code: created.code, expiresAt: created.expiresAt, row: data || null };
    },

    /** Find a code that could still be redeemed. Console/debug only — `redeem` re-checks. */
    async find(code) {
      const { data, error } = await table()
        .select('*')
        .eq('code_hash', hashPairingCode(code))
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },

    /**
     * Atomically mark the code used. Returns the row that *this* call claimed, or null when
     * someone else got there first.
     */
    async claim(code, { tokenId = null } = {}) {
      const { data, error } = await table()
        .update({ used_at: new Date(now()).toISOString(), used_token_id: tokenId })
        .eq('code_hash', hashPairingCode(code))
        .is('used_at', null)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async list({ tenantId, limit = 15 }) {
      const { data, error } = await table()
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    }
  };
}
