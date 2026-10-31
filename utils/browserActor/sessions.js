/**
 * Browser session leases (2026-10-31)
 *
 * MoreLogin lets the same profile be started more than once, and two agents
 * driving one profile corrupt each other's cookies, tabs and checkout flows.
 * One profile therefore has exactly one active lease, and the lease is the
 * contract an agent holds:
 *
 *   - `acquire()` refuses while another lease is live  -> profile_busy
 *   - every write needs the lease token                -> lease_conflict
 *   - the lease expires unless it is heartbeated       -> profile_busy clears
 *
 * The clock and the id factory are injectable so expiry is tested in
 * milliseconds instead of waiting fifteen real minutes. The broker keeps no
 * timers of its own; the route module owns the sweeper interval, because a
 * module-level timer would keep the process alive in tests.
 */
import { randomUUID } from 'node:crypto';
import { BrowserActorError } from './errors.js';
import { maskEnvId } from './identity.js';

export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
export const MAX_LEASE_MS = 4 * 60 * 60 * 1000;

export function clampLease(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_LEASE_MS;
  return Math.min(Math.max(Math.floor(ms), 30_000), MAX_LEASE_MS);
}

export function createSessionBroker(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const newId = typeof options.idFactory === 'function' ? options.idFactory : () => randomUUID();
  const newToken = typeof options.tokenFactory === 'function' ? options.tokenFactory : () => randomUUID();
  const defaultLeaseMs = clampLease(options.ttlMs ?? DEFAULT_LEASE_MS);
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  /** @type {Map<string, object>} */
  const sessions = new Map();

  function isExpired(session, at = now()) {
    return session.expiresAt <= at;
  }

  function activeForEnv(envId, at = now()) {
    for (const session of sessions.values()) {
      if (session.envId === envId && !isExpired(session, at)) return session;
    }
    return null;
  }

  function requireSession(id) {
    const session = sessions.get(String(id || ''));
    if (!session) {
      throw new BrowserActorError('session_not_found', 'No such browser session', {
        details: { sessionId: String(id || '') }
      });
    }
    return session;
  }

  function requireHolder(session, token) {
    if (!token || String(token) !== session.leaseToken) {
      throw new BrowserActorError('lease_conflict', 'This session is held by another actor', {
        details: { sessionId: session.id, tenant: session.tenantSlug }
      });
    }
  }

  /** Drop expired leases. Returns the sessions that were reclaimed. */
  function sweep(at = now()) {
    const reclaimed = [];
    for (const [id, session] of sessions.entries()) {
      if (!isExpired(session, at)) continue;
      sessions.delete(id);
      reclaimed.push(publicSession(session, { includeCdp: true }));
      onEvent({ type: 'session_expired', session: publicSession(session) });
    }
    return reclaimed;
  }

  /**
   * Claim a profile for one actor.
   *
   * @param {{identity: object, actor?: string, cdp?: object, leaseMs?: number, purpose?: string}} input
   */
  function acquire({ identity, actor = 'agent', cdp = null, leaseMs, purpose = null } = {}) {
    if (!identity?.envId || !identity?.tenantSlug) {
      throw new BrowserActorError('invalid_request', 'acquire requires a resolved identity');
    }
    const at = now();
    sweep(at);

    const busy = activeForEnv(identity.envId, at);
    if (busy) {
      throw new BrowserActorError('profile_busy', 'That profile is already held by another agent', {
        details: {
          tenant: identity.tenantSlug,
          envIdMasked: maskEnvId(identity.envId),
          sessionId: busy.id,
          heldByTenant: busy.tenantSlug,
          expiresAt: new Date(busy.expiresAt).toISOString()
        }
      });
    }

    const ttl = clampLease(leaseMs ?? defaultLeaseMs);
    const session = {
      id: newId(),
      leaseToken: newToken(),
      tenantSlug: identity.tenantSlug,
      envId: identity.envId,
      runtime: identity.runtime,
      label: identity.label || null,
      actor: String(actor || 'agent').slice(0, 80),
      purpose: purpose ? String(purpose).slice(0, 200) : null,
      cdp: cdp || null,
      createdAt: at,
      lastHeartbeatAt: at,
      expiresAt: at + ttl
    };
    sessions.set(session.id, session);
    onEvent({ type: 'session_opened', session: publicSession(session, { includeCdp: true }) });
    return session;
  }

  /** Extend a lease. Only the holder may extend it. */
  function heartbeat(id, token, leaseMs) {
    const session = requireSession(id);
    requireHolder(session, token);
    const at = now();
    const ttl = clampLease(leaseMs ?? session.expiresAt - session.lastHeartbeatAt);
    session.lastHeartbeatAt = at;
    session.expiresAt = at + ttl;
    return session;
  }

  /** Give the profile back. `reason` lands in the audit table. */
  function release(id, token, reason = 'released') {
    const session = requireSession(id);
    requireHolder(session, token);
    sessions.delete(session.id);
    onEvent({ type: 'session_closed', session: publicSession(session, { includeCdp: true }), reason });
    return session;
  }

  /** Record the attach point once the profile has actually started. */
  function attach(id, token, cdp) {
    const session = requireSession(id);
    requireHolder(session, token);
    session.cdp = cdp || null;
    return session;
  }

  /** Read a session; a tenant may only read its own. */
  function get(id, { tenantSlug = null } = {}) {
    const session = requireSession(id);
    if (tenantSlug && session.tenantSlug !== tenantSlug) {
      throw new BrowserActorError('session_not_found', 'No such browser session', {
        details: { sessionId: String(id || '') }
      });
    }
    return session;
  }

  function list({ tenantSlug = null } = {}) {
    sweep();
    const out = [];
    for (const session of sessions.values()) {
      if (tenantSlug && session.tenantSlug !== tenantSlug) continue;
      out.push(publicSession(session, { includeCdp: true }));
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function stats() {
    sweep();
    return { active: sessions.size };
  }

  return { acquire, attach, heartbeat, release, get, list, sweep, stats, isExpired, activeForEnv };
}

/**
 * The shape returned to callers. `leaseToken` is only included for the agent
 * that created the session — it is the write credential, and a list endpoint
 * must never hand it to a different actor on the same tenant.
 */
export function publicSession(session, { includeToken = false, includeCdp = false } = {}) {
  const base = {
    sessionId: session.id,
    tenant: session.tenantSlug,
    envIdMasked: maskEnvId(session.envId),
    runtime: session.runtime,
    actor: session.actor,
    purpose: session.purpose || null,
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    lastHeartbeatAt: new Date(session.lastHeartbeatAt).toISOString()
  };
  if (includeToken) base.leaseToken = session.leaseToken;
  if (includeCdp && session.cdp) {
    // A local debug port is not a credential, but a Cloud cdpUrl is. The port
    // form is the only one ever serialised.
    base.cdp = session.cdp.debugPort
      ? { host: session.cdp.host || '127.0.0.1', port: session.cdp.debugPort }
      : null;
  }
  return base;
}

