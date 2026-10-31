/**
 * X (Twitter) publishing adapter (2026-10-31)
 *
 * Why an API and not the browser actor: X explicitly supports programmatic
 * posting through API v2 with a user-context OAuth 2.0 token, and the repo
 * already uses the X API (minihack/bounty2-trendjack/sources.js). Driving the
 * web composer instead would buy nothing and risk the tenant's account.
 *
 * The contract this module keeps:
 *   - the token is a bearer credential: it never appears in an error, a detail
 *     object, or a log line;
 *   - text is measured the way X measures it (t.co 23-char links, wide chars 2)
 *     BEFORE the call, so a 282-character post fails locally instead of burning
 *     a rate-limit slot and a round trip;
 *   - every failure is typed, because the caller routes on it: `unauthorized`
 *     means fix the token, `rate_limited` means wait until `retryAt`.
 */
import { weightedLength, X_LIMIT } from './postText.js';

export const SOCIAL_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'social_not_configured',
  UNAUTHORIZED: 'social_unauthorized',
  RATE_LIMITED: 'social_rate_limited',
  REJECTED: 'social_rejected',
  INVALID_REQUEST: 'social_invalid_request',
  NETWORK: 'social_network'
});

const HTTP_STATUS = Object.freeze({
  social_not_configured: 409,
  social_unauthorized: 401,
  social_rate_limited: 429,
  social_rejected: 502,
  social_invalid_request: 400,
  social_network: 503
});

const CODE_VALUES = new Set(Object.values(SOCIAL_ERROR_CODES));

/**
 * Accept either the key ('UNAUTHORIZED') or the value ('social_unauthorized')
 * and always store the value. Storing the key silently broke every status
 * mapping downstream, because HTTP_STATUS is keyed by the value.
 */
export function normalizeSocialCode(code) {
  if (CODE_VALUES.has(code)) return code;
  return SOCIAL_ERROR_CODES[code] || 'social_rejected';
}

export class SocialError extends Error {
  constructor(code, message, { details = null, retryAt = null, cause } = {}) {
    super(message || code);
    this.name = 'SocialError';
    this.code = normalizeSocialCode(code);
    this.status = HTTP_STATUS[this.code] || 500;
    this.details = details;
    this.retryAt = retryAt;
    if (cause) this.cause = cause;
  }
}

/** Strip anything token-shaped before it can reach a log or a response. */
export function redactSecret(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/"(access_token|token)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"');
}

const DEFAULT_BASE = 'https://api.x.com';

/**
 * Per-tenant user token.
 *
 * v1 reads `SOCIAL_X_TOKENS`, a JSON map keyed by tenant slug — the same shape
 * as BROWSER_ACTOR_PROFILES, so operators learn one convention. A single-tenant
 * deployment can set X_USER_ACCESS_TOKEN instead. When this outgrows an env var,
 * move it to a tenant_social_accounts table behind the same `tokenFor` contract.
 */
export function resolveXToken(tenantSlug, env = process.env) {
  const slug = String(tenantSlug || '').trim().toLowerCase();
  const raw = env.SOCIAL_X_TOKENS;
  if (raw && String(raw).trim()) {
    let map;
    try {
      map = JSON.parse(raw);
    } catch {
      throw new SocialError('NOT_CONFIGURED', 'SOCIAL_X_TOKENS is not valid JSON', {
        details: { hint: 'expected {"tenant-slug":"user-access-token"}' }
      });
    }
    const token = map && typeof map === 'object' ? map[slug] : null;
    if (token) return String(token);
  }
  const fallback = env.X_USER_ACCESS_TOKEN;
  if (fallback) return String(fallback);
  throw new SocialError('NOT_CONFIGURED', `No X token configured for tenant "${slug}"`, {
    details: { tenant: slug, fix: 'Add the slug to SOCIAL_X_TOKENS, or set X_USER_ACCESS_TOKEN' }
  });
}

export function createXPublisher(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = String(options.baseUrl || env.X_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const tokenFor = typeof options.tokenFor === 'function'
    ? options.tokenFor
    : (tenant) => resolveXToken(tenant, env);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  async function publish({ tenant, text } = {}) {
    const body = String(text || '').trim();
    if (!tenant) throw new SocialError('INVALID_REQUEST', 'tenant is required');
    if (!body) throw new SocialError('INVALID_REQUEST', 'text is required');

    // Measure before the call: X counts links as 23 chars, so a naive length
    // check would reject posts that actually fit (or accept ones that do not).
    const measured = weightedLength(body);
    if (measured > X_LIMIT) {
      throw new SocialError('INVALID_REQUEST', `Post is ${measured} weighted characters; X allows ${X_LIMIT}`, {
        details: { measured, limit: X_LIMIT }
      });
    }

    const token = tokenFor(tenant);
    if (!token) throw new SocialError('NOT_CONFIGURED', `No X token configured for tenant "${tenant}"`);

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/2/tweets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text: body }),
        signal: AbortSignal.timeout(Number(env.X_API_TIMEOUT_MS) || 20_000)
      });
    } catch (error) {
      throw new SocialError('NETWORK', 'Could not reach the X API', {
        details: { reason: error?.cause?.code || error?.name || null }
      });
    }

    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }

    if (response.status === 429) {
      const resetSeconds = Number(response.headers?.get?.('x-rate-limit-reset'));
      const retryAt = Number.isFinite(resetSeconds) && resetSeconds > 0
        ? new Date(resetSeconds * 1000).toISOString()
        : null;
      throw new SocialError('RATE_LIMITED', 'X rate limit reached', { retryAt });
    }
    if (response.status === 401 || response.status === 403) {
      throw new SocialError('UNAUTHORIZED', 'X rejected the token or its scopes', {
        details: {
          status: response.status,
          detail: redactSecret(parsed?.detail || parsed?.title || '').slice(0, 200) || null
        }
      });
    }
    if (!response.ok) {
      throw new SocialError('REJECTED', `X returned HTTP ${response.status}`, {
        details: {
          status: response.status,
          detail: redactSecret(parsed?.detail || parsed?.title || parsed?.errors?.[0]?.message || raw).slice(0, 300) || null
        }
      });
    }

    const id = parsed?.data?.id;
    if (!id) {
      throw new SocialError('REJECTED', 'X accepted the request but returned no tweet id', {
        details: { status: response.status }
      });
    }

    return {
      ok: true,
      id: String(id),
      url: `https://x.com/i/web/status/${id}`,
      text: parsed?.data?.text || body,
      publishedAt: new Date(now()).toISOString()
    };
  }

  return { publish };
}

