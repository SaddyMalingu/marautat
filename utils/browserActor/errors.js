/**
 * Browser Actor errors (2026-10-31)
 *
 * The Browser Actor Runtime sits between an Alphadome agent and a MoreLogin
 * browser/phone. Every failure an agent can hit has to be machine-readable,
 * because the agent decides what to do next from the code — retry, wait for the
 * lease to expire, ask the operator to map a profile, or give up:
 *
 *   profile_unmapped  -> an operator must bind this tenant to a MoreLogin profile
 *   profile_busy      -> another agent owns it; wait for release or expiry
 *   cli_missing       -> the MoreLogin client/CLI is not installed on this host
 *   provider_*        -> MoreLogin rejected or failed the call
 *   cdp_*             -> the profile started but the agent could not drive it
 *
 * The other job is secrecy. A started Cloud runtime returns a `cdpUrl` that is a
 * bearer credential, and the Local API key is a bearer credential too. Nothing in
 * this file ever copies a token into `message` or `details`; `toPublicError`
 * is the only shape that leaves the process.
 */

export const BROWSER_ACTOR_CODES = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  NOT_CONFIGURED: 'not_configured',
  UNAUTHORIZED: 'unauthorized',
  PROFILE_UNMAPPED: 'profile_unmapped',
  GEO_MISMATCH: 'geo_mismatch',
  PROFILE_BUSY: 'profile_busy',
  SESSION_NOT_FOUND: 'session_not_found',
  LEASE_CONFLICT: 'lease_conflict',
  CLI_MISSING: 'cli_missing',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  PROVIDER_ERROR: 'provider_error',
  PROVIDER_TIMEOUT: 'provider_timeout',
  /**
   * The plan's daily startup allowance is spent (e.g. MoreLogin 19124, "The daily
   * startup limit is exceeded"). Distinct from `provider_error` because the fix is
   * different in kind: not a retry, not a lock to clear — wait for the reset or upgrade.
   */
  PROVIDER_QUOTA: 'provider_quota',
  CDP_ERROR: 'cdp_error',
  CDP_TIMEOUT: 'cdp_timeout',
  UNSUPPORTED_TRANSPORT: 'unsupported_transport'
});


// Every code maps to one HTTP status so a caller can branch on either.
const HTTP_STATUS = Object.freeze({
  invalid_request: 400,
  not_configured: 503,
  unauthorized: 401,
  profile_unmapped: 409,
  geo_mismatch: 409,
  profile_busy: 409,
  session_not_found: 404,
  lease_conflict: 409,
  cli_missing: 503,
  provider_unavailable: 503,
  provider_error: 502,
  provider_timeout: 504,
  // 429 is the honest status for "your plan's allowance for today is gone".
  provider_quota: 429,
  cdp_error: 502,
  cdp_timeout: 504,
  unsupported_transport: 501
});

export class BrowserActorError extends Error {
  /**
   * @param {string} code one of BROWSER_ACTOR_CODES
   * @param {string} message short, already safe to log
   * @param {{details?: object|null, status?: number, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'BrowserActorError';
    this.code = BROWSER_ACTOR_CODES[code] ? code : String(code || 'provider_error');
    this.status = options.status || HTTP_STATUS[this.code] || 500;
    this.details = options.details || null;
    if (options.cause) this.cause = options.cause;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isBrowserActorError(value) {
  return value instanceof BrowserActorError;
}

/**
 * Convert anything thrown into the public error envelope the routes return.
 * Unknown errors deliberately lose their message: a stack message can carry a
 * URL with a Cloud runtime token in it.
 */
export function toPublicError(error) {
  if (isBrowserActorError(error)) {
    return {
      status: error.status,
      body: { ok: false, error: error.code, message: error.message, details: error.details }
    };
  }
  return {
    status: 500,
    body: { ok: false, error: 'internal_error', message: 'Browser actor request failed', details: null }
  };
}

export function httpStatusForCode(code) {
  return HTTP_STATUS[code] || 500;
}

/**
 * Is this failure the plan's daily startup allowance running out?
 *
 * The wording is the vendor's, so it is matched rather than inferred from a code: the
 * same 19124 has been observed for a genuine start failure too. Two conditions are
 * required — a limit/quota word *and* an exceed/upgrade word — so a message like
 * "rate limit: retrying" is not mistaken for an exhausted plan.
 */
export const QUOTA_LIMIT_WORDS = /(quota|limit|allowance)/i;
export const QUOTA_EXCEEDED_WORDS = /(exceed|exhaust|reached|upgrade|insufficient|used up)/i;

export function isQuotaExhaustedMessage(text) {
  const value = String(text || '');
  if (!value) return false;
  if (/daily startup limit/i.test(value)) return true;
  return QUOTA_LIMIT_WORDS.test(value) && QUOTA_EXCEEDED_WORDS.test(value);
}

/**
 * Every provider failure an operator will actually see, mapped to what they should do.
 * A quota error is not retryable today, and saying so is the whole point: retrying it is
 * what wasted the allowance in the first place.
 */
export function classifyProviderFailure(error) {
  const message = String(error?.message || error || '');
  const details = [
    message,
    String(error?.details?.stderr || ''),
    String(error?.details?.raw || ''),
    String(error?.details?.body || '')
  ].join(' ');

  if (isQuotaExhaustedMessage(details)) {
    return {
      code: 'provider_quota',
      retryable: false,
      actionable: "The MoreLogin plan's daily startup limit is spent. Wait for the daily reset or upgrade the package, then re-run. Nothing is lost: captured roles are skipped on the next run."
    };
  }
  return { code: 'provider_error', retryable: true, actionable: null };
}

