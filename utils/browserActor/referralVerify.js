/**
 * Referral link verification (2026-10-31)
 *
 * The tenant's rule: **a referral link drives revenue, so it must never be
 * invented, guessed or assumed.** Verified live on this account:
 *
 *   1. A Turing `/r/<code>` link is **stable per role**. It does not re-mint when
 *      the page reloads or the card is clicked again.
 *   2. Therefore two different codes for one role is not "both valid" — one of them
 *      is wrong.
 *   3. The link itself is checkable without a browser: `GET /r/<code>` returns a page
 *      whose `<title>` is the job title, e.g.
 *        r/xako-8LrQK  -> "Project Lead - AI Training - Turing"        (correct)
 *        r/9PkwepYCFE  -> "Strategic Project Lead – Software Engineering - Turing"
 *
 * That last line is a real link found in production, sitting on the Project Lead
 * offer and pointing at a different job. A guard that only checks "is there already
 * a link?" protects bad data as faithfully as good data. Checking where the link
 * actually lands is what makes the write safe.
 *
 * Pure except for `verifyReferralLink`, which takes an injectable fetch so the rules
 * can be tested without the network.
 */

/** Turing titles are rendered as "<job title> - Turing". */
export const TITLE_SUFFIX = /\s*[-–—]\s*Turing\s*$/i;

/**
 * Tail words a marketplace may append to a job title on the referral page itself.
 *
 * Verified live: Micro1 serves "<job title> | Apply on Job", while the offer title
 * is just "<job title>". Treating that as a mismatch failed 5 correct links, and a
 * checker that cries wolf is as dangerous as one that accepts anything — it trains
 * the operator to ignore it.
 *
 * Only these words are allowed to appear in the extra tail, so
 * "Project Lead - AI Training" still cannot match
 * "Strategic Project Lead - Software Engineering".
 */
export const KNOWN_TAIL_WORDS = new Set([
  'apply', 'on', 'job', 'jobs', 'turing', 'careers', 'career', 'hiring', 'remote',
  'position', 'role', 'work', 'with', 'us', 'now', 'open'
]);

/** Decode the few entities a job title realistically contains. */
export function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&rsquo;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}


/**
 * Canonical form for comparing a job title to a page title.
 * Dashes are the whole problem here: the marketplace mixes `-`, `–` and `—`, and
 * "Medical Expert – Dermatology" must equal "Medical Expert - Dermatology".
 */
export function normalizeTitleForCompare(value) {
  return String(value || '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The raw <title> of an HTML document, whitespace collapsed. */
export function extractHtmlTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (!match) return null;
  const title = match[1].replace(/\s+/g, ' ').trim();
  return title || null;
}

/** The job title a referral page advertises, with the site suffix removed. */
export function resolvedJobTitle(html) {
  const title = extractHtmlTitle(html);
  if (!title) return null;
  const decoded = decodeHtmlEntities(title);
  return decoded.replace(TITLE_SUFFIX, '').trim() || null;
}

/**
 * Decide whether a resolved page may stand for an offer.
 *
 * Two ways to pass, both strict:
 *   1. the normalized titles are identical;
 *   2. the resolved title is the expected title followed by a dash and nothing but
 *      known marketing tail words ("apply on job", "turing", …).
 *
 * Deliberately NOT "one contains the other": "Project Lead - AI Training" contains
 * "Project Lead", and so does "Strategic Project Lead - Software Engineering" — the
 * exact pair that produced a wrong link in production.
 */
export function judgeReferralLink({ expectedTitle = '', resolvedTitle = null, status = null } = {}) {
  const expected = normalizeTitleForCompare(expectedTitle);
  const resolved = normalizeTitleForCompare(resolvedTitle);

  if (!resolved) {
    return { verdict: 'unresolvable', reason: status ? `http_${status}` : 'no_title_found', expectedTitle, resolvedTitle: resolvedTitle || null };
  }
  if (!expected) {
    return { verdict: 'unresolvable', reason: 'offer_has_no_title', expectedTitle, resolvedTitle };
  }
  if (expected === resolved) {
    return { verdict: 'match', reason: 'title_identical', expectedTitle, resolvedTitle };
  }

  if (resolved.startsWith(`${expected}-`)) {
    const tail = resolved.slice(expected.length + 1).split('-').filter(Boolean);
    if (tail.length && tail.every((word) => KNOWN_TAIL_WORDS.has(word))) {
      return { verdict: 'match', reason: 'title_plus_marketing_tail', expectedTitle, resolvedTitle };
    }
  }

  return { verdict: 'mismatch', reason: 'title_differs', expectedTitle, resolvedTitle };
}

/**
 * Fetch a referral link and judge it against the offer it is supposed to serve.
 * Never throws for a bad link: an unreachable page is a verdict, not a crash,
 * because the caller's next move (refuse to write) is the same either way.
 */
export async function verifyReferralLink({
  url,
  expectedTitle = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
} = {}) {
  if (!url) return { ...judgeReferralLink({ expectedTitle }), url: null, status: null };
  if (typeof fetchImpl !== 'function') {
    return { ...judgeReferralLink({ expectedTitle }), url: String(url), status: null, reason: 'no_fetch' };
  }

  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'user-agent': userAgent, accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return {
      ...judgeReferralLink({ expectedTitle }),
      url: String(url),
      status: null,
      reason: `fetch_failed:${error?.name || 'error'}`
    };
  }

  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }

  return {
    ...judgeReferralLink({ expectedTitle, resolvedTitle: resolvedJobTitle(body), status: response.status }),
    url: String(url),
    status: response.status
  };
}
