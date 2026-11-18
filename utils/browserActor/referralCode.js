/**
 * The referral code behind a URL (2026-11-17)
 *
 * One function, two very different callers: the portal's funnel and the tenant's worker. It lives **here**, under
 * `utils/browserActor/`, because that directory is copied wholesale into the downloadable worker bundle — a shared rule
 * that only exists in a server-only file cannot be used by the runner, and on 17 Nov an import of `utils/writerFlow.js`
 * from `applyCaptures.js` broke every tenant's worker with `ERR_MODULE_NOT_FOUND` before it ran a single capture.
 *
 * `payable` has to answer one question: if a reader clicks this, does anybody get credited? That is a property of the
 * URL alone. Two forms exist in this repo:
 *
 *   - query form — `?referralCode=<uuid>` — Micro1's per-account share code, one per account, so *every* role carries
 *     the same value. Two values on one host means a capture used a second account (see `linkAttribution`).
 *   - path form  — `/r/<code>` — Turing's per-role invite code, a different value for every role by design.
 */

/** Query keys the marketplaces use to carry an attribution code. */
export const REFERRAL_QUERY_KEYS = Object.freeze([
  'referralCode', 'referral_code', 'ref', 'ref_code', 'code', 'invite', 'invite_code', 'aff', 'affiliate'
]);

/**
 * @param {string} url
 * @returns {{code: string, host: string, form: 'query'|'path'}|null}
 */
export function referralCodeOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  for (const key of REFERRAL_QUERY_KEYS) {
    const value = parsed.searchParams.get(key);
    if (value && value.trim()) return { code: value.trim(), host: parsed.host, form: 'query' };
  }
  // Turing's codes are short (`/r/1RaIcR1_hi`, and `/r/a` in fixtures), so no minimum length: refusing short ones would
  // call a working link unpayable.
  const path = parsed.pathname.match(/\/(?:r|ref|refs|invite|i)\/([A-Za-z0-9_-]+)/i);
  if (path) return { code: path[1], host: parsed.host, form: 'path' };
  return null;
}

/** Can a click through this URL earn anything? */
export function creditsSomebody(url) {
  return Boolean(referralCodeOf(url));
}

/**
 * The first URL of these that credits somebody, else the first usable one (2026-11-18).
 *
 * An offer carries up to three URLs and only some of them can earn. A Micro1 role has
 * `destination_url = jobs.micro1.ai/post/<id>` — the plain posting — and `referral_url = jobs.micro1.ai/post/<id>?referralCode=…`.
 * Resolving the destination as `destination_url || referral_url` therefore sends every CTA, and every `/go/:id` hop, to
 * the URL that pays the marketplace for the tenant's traffic: the pages convert and the tenant earns nothing.
 *
 * The order is by what the URL *does*, not by which column it arrived in. `creditsSomebody` is the same test the Payable
 * filter uses, so "which link is the earning one" has one answer everywhere.
 */
export function preferCreditingUrl(...urls) {
  const usable = urls
    .map((url) => String(url || '').trim())
    .filter((url) => /^https?:\/\//i.test(url));
  return usable.find((url) => creditsSomebody(url)) || usable[0] || null;
}
