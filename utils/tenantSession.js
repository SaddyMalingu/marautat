/**
 * Tenant portal sessions that survive a deploy.
 *
 * The portal kept its sessions in `const tenantSessions = new Map()` (server.js).
 * On Render every deploy starts a new process, so the Map was empty on boot and
 * every signed-in client was bounced to the sign-in form mid-session — visible
 * in the deploy log as three 401s followed by a fresh `POST /tenant/session/login`.
 * Nothing is wrong with the sessions themselves; they simply lived only in RAM.
 *
 * A token here carries its own session: `v1.<payload>.<hmac>`. The payload is
 * public (tenant id, phone, name, expiry) and the HMAC is what makes it
 * unforgeable, so the server can validate a token it has never seen before —
 * which is exactly the case after a restart.
 *
 * Deliberately unchanged: the TTL, the cookie flags (HttpOnly, SameSite=Lax,
 * Secure behind a proxy), the tenant-is-active check on every data route
 * (`tenantSiteFromSession` re-reads the tenant from the database), and same-
 * process logout (the caller keeps an in-memory revocation list, so logging out
 * is immediate on the instance that holds the session).
 *
 * No new environment variable is required: the signing key falls back to
 * TENANT_DASHBOARD_PASS, which the portal already refuses to serve without.
 *
 * Pure functions, no IO, so this can be tested offline.
 */
import crypto from 'crypto';

export const TENANT_SESSION_COOKIE = 'td_session';

const VERSION = 'v1';

/** The key the token is signed with. Empty string means "cannot sign". */
export function tenantSessionSecret(env = process.env) {
  const secret = env.TENANT_SESSION_SECRET || env.TENANT_DASHBOARD_PASS || '';
  return String(secret || '').trim();
}

const b64u = (input) => Buffer.from(input).toString('base64url');

/**
 * Sign a session into a token. Returns '' when no key is configured, in which
 * case the caller keeps using the in-memory Map and behaviour is unchanged.
 */
export function signTenantSession(session, secret, now = Date.now()) {
  if (!secret) return '';
  const payload = {
    t: session && session.tenantId,
    p: session && session.tenantPhone,
    n: (session && session.tenantName) || '',
    e: Number((session && session.expiresAt) || 0),
    j: (session && session.jti) || crypto.randomBytes(8).toString('hex'),
  };
  if (!payload.t || !payload.p || !payload.e || payload.e <= now) return '';
  const body = VERSION + '.' + b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest();
  return body + '.' + b64u(mac);
}

/**
 * Validate a token and return the session it carries, or null.
 *
 * Rejects: a missing key, a malformed token, any tampering with the payload
 * (the MAC is compared in constant time), a missing tenant id or phone, and an
 * expired token.
 */
export function verifyTenantSession(token, secret, now = Date.now()) {
  if (!secret) return null;
  const raw = String(token == null ? '' : token);
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) return null;

  const body = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  let given;
  try {
    given = Buffer.from(parts[2], 'base64url');
  } catch (e) {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.t || !payload.p || typeof payload.e !== 'number') return null;
  if (payload.e <= now) return null;

  return {
    tenantId: payload.t,
    tenantPhone: payload.p,
    tenantName: payload.n || '',
    expiresAt: payload.e,
    jti: payload.j || null,
    token: raw,
  };
}
