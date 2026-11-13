/**
 * Unwrap Node's `fetch failed` (2026-11-13).
 *
 * `TypeError: fetch failed` is what the caller sees, and it names nothing: the actual reason is
 * on `error.cause` — `ENOTFOUND` (DNS), `ECONNREFUSED`, `CERT_HAS_EXPIRED`, `ETIMEDOUT`. On
 * 2026-11-13 a Render cron job failed with exactly this and the log could not say whether the
 * URL was wrong, the DNS was wrong, or the key was wrong.
 *
 * Returns a one-line explanation plus the raw code, for logs.
 */
export function describeFetchError(error) {
  const cause = error?.cause || {};
  const code = cause.code || cause.errno || null;
  const detail = cause.message || error?.message || 'unknown';

  const hints = {
    ENOTFOUND: 'the host does not resolve — the project URL is wrong (or its project ref no longer exists)',
    EAI_AGAIN: 'DNS lookup failed temporarily — retrying usually works',
    ECONNREFUSED: 'the host refused the connection — wrong port or a local address',
    ECONNRESET: 'the connection was reset mid-request',
    ETIMEDOUT: 'the connection timed out — egress may be blocked from this service',
    CERT_HAS_EXPIRED: 'the TLS certificate has expired — check the URL is the current project',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS verification failed — a proxy is intercepting the connection',
    UND_ERR_CONNECT_TIMEOUT: 'connect timeout — egress may be blocked from this service'
  };

  const hint = code ? hints[code] || `network error ${code}` : 'the request never left this host';
  return { code, detail, hint, text: `${hint} (${code || 'no code'}: ${detail})` };
}

/** Wrap one Supabase call so a transport failure arrives with its cause attached. */
export async function withCause(run, what) {
  try {
    return await run();
  } catch (error) {
    const described = describeFetchError(error);
    // The message is what lands in a Render log, so it has to carry the cause itself.
    throw new Error(`${what}: ${described.text}`);
  }
}
