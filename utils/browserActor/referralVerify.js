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

  // A page we cannot read is not a wrong link. This is the difference that lost 120 correct
  // Turing links on 2026-11-04: an SPA shell answers every URL with `Turing Jobs`, and every
  // role was therefore judged `mismatch` and refused. The **raw** title goes in, because
  // normalisation turns "Just a moment..." into "just-a-moment" and loses the phrase.
  if (looksLikeShellTitle(resolvedTitle)) {
    return { verdict: 'unresolvable', reason: 'shell_page', expectedTitle, resolvedTitle };
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
 * Titles that mean "I got the application shell, not the role".
 *
 * Turing (and most modern job boards) render the role in JavaScript: a plain fetch gets the same
 * `<title>` for every URL — the brand, or a sign-in page. Judging that as `mismatch` refused 120
 * correct links in one run on 2026-11-04. A page we cannot *read* is `unresolvable`, which is a
 * different statement from "this link points at another role", and it lets the caller accept
 * evidence from the browser that actually loaded the page.
 */
const AUTH_TITLE_RE = /\b(sign[\s-]?in|log[\s-]?in|login|signin|just a moment|attention required|access denied|captcha|verify you are human|are you a robot|blocked|forbidden)\b/i;
const BRAND_ONLY_WORDS = Object.freeze(['turing', 'micro1', 'jobs', 'careers', 'job', 'home', 'search']);

/**
 * Is this the application shell rather than the role?
 *
 * Two shapes only, because a loose test is worse than none: it silently disables verification.
 *
 *   - an **auth or interstitial** phrase (`Sign in`, `Just a moment`, `Access denied`), matched
 *     against the raw title because normalisation destroys the phrase (`sign-in-turing` is three
 *     words, none of which is `sign-in`);
 *   - a **brand-only** title (`Turing Jobs`, `Careers`), where every word is the site's own name.
 *
 * `Business Analyst - US | Turing` is a real role with a brand suffix and must stay comparable —
 * `judgeReferralLink` already accepts that as `title_plus_marketing_tail`.
 */
export function looksLikeShellTitle(resolvedTitle) {
  const raw = String(resolvedTitle || '').trim();
  if (!raw) return true;
  if (AUTH_TITLE_RE.test(raw)) return true;
  const words = normalizeTitleForCompare(raw).split('-').filter(Boolean);
  return words.length <= 3 && words.every((word) => BRAND_ONLY_WORDS.includes(word));
}

/**
 * Judge a title the tenant's own browser reported.
 *
 * Used when the server cannot read a JS-rendered role page: the machine that minted the link is
 * the machine that can see it, and its evidence is checked with the same rules as a fetch.
 */
export function judgeWorkerReportedTitle({ expectedTitle = '', pageTitle = null } = {}) {
  const resolvedTitle = String(pageTitle || '').trim() || null;
  if (!resolvedTitle) {
    return { verdict: 'unresolvable', reason: 'worker_sent_no_title', expectedTitle, resolvedTitle: null, source: 'worker' };
  }
  return { ...judgeReferralLink({ expectedTitle, resolvedTitle }), source: 'worker' };
}

/**
 * The one decision about a captured link, shared by the portal and the laptop (2026-11-05).
 *
 * It existed twice and disagreed with itself. The server learned that a shell title is
 * `unresolvable` and may be answered by the browser that minted the link; the Turing runner — which
 * runs the same check when a tenant drives it by hand — still accepted only `match`, so the manual
 * path refused every link the server would have attached. Two truths about the same evidence is
 * worse than one wrong one, because nothing tells you which is which.
 *
 * Rules, in order:
 *   1. the fetch says `match` → accept, source `server`;
 *   2. the fetch says `mismatch` → refuse. Real HTML naming another role is evidence, and a
 *      browser title cannot overrule it: the page may simply not have navigated yet;
 *   3. the fetch cannot read the page (`unresolvable`) and the browser reported a title → that
 *      title is judged by the same rules; `match` accepts it as source `worker`;
 *   4. anything else stays `unresolvable` — a link with no readable evidence is not attached.
 */
export function resolveLinkVerdict({ check = null, expectedTitle = '', pageTitle = null } = {}) {
  const fetchVerdict = String(check?.verdict || 'unresolvable');
  const fetchReason = String(check?.reason || 'no_verdict');

  if (fetchVerdict === 'match') {
    return { verdict: 'match', reason: fetchReason, source: 'server', resolvedTitle: check?.resolvedTitle || null };
  }
  if (fetchVerdict === 'mismatch') {
    return { verdict: 'mismatch', reason: fetchReason, source: 'server', resolvedTitle: check?.resolvedTitle || null };
  }
  if (pageTitle) {
    const byWorker = judgeWorkerReportedTitle({ expectedTitle, pageTitle });
    return {
      verdict: byWorker.verdict === 'match' ? 'match' : byWorker.verdict,
      reason: byWorker.reason,
      source: 'worker',
      resolvedTitle: byWorker.resolvedTitle || null
    };
  }
  return { verdict: 'unresolvable', reason: fetchReason, source: 'server', resolvedTitle: check?.resolvedTitle || null };
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

/**
 * Where the code lives, and what that means.
 *
 *   path   `/r/<code>`      — the code IS the role (Turing). Repeats are duplicates.
 *   query  `?referralCode=` — the code is the account (Micro1). Repeats are normal,
 *                             and a *different* code means a different payee.
 *
 * Deriving this from URL shape rather than code frequency matters: a first version
 * guessed "the most common code is the account" and immediately flagged all five
 * Micro1 links as duplicates of each other, which is exactly how they are supposed
 * to look.
 */
export function parseReferralCode(url) {
  try {
    const parsed = new URL(String(url || ''));
    for (const name of ['referralCode', 'ref', 'code']) {
      const value = parsed.searchParams.get(name);
      if (value && String(value).trim()) return { code: String(value).trim(), kind: 'query' };
    }
    const path = parsed.pathname.match(/\/r\/([^/]+)\/?$/i);
    if (path) return { code: decodeURIComponent(path[1]).trim(), kind: 'path' };
    return { code: null, kind: 'none' };
  } catch {
    return { code: null, kind: 'none' };
  }
}

/** The referral code a link carries, if it carries one. */
export function extractReferralCode(url) {
  return parseReferralCode(url).code;
}

/**
 * Cross-link integrity: is every stored link paying *this* tenant?
 *
 * Title verification proves a link lands on the right job. It does NOT prove the
 * link credits the tenant — a link can open the correct job while carrying somebody
 * else's referral code, and then the tenant does the work and another account gets
 * paid. That is the failure this check exists for.
 *
 * Rules, chosen by where the code lives:
 *
 *   - **query codes (account level):** the tenant's dominant code should cover the
 *     marketplace. A link carrying anything else pays somebody else. Flagged.
 *   - **path codes (per role):** one code per role, so the same code on two offers
 *     means one of them is mislabelled. Flagged.
 *
 * Pure: takes rows, returns findings. No network, no database.
 */
export function planCodeIntegrity(rows = [], { dominantShare = 0.5 } = {}) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = String(row?.referral_url || '').trim();
    if (!url) continue;
    let host = 'unknown';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = 'unknown'; }
    const shortHost = host.endsWith('turing.com') ? 'turing.com' : host.endsWith('micro1.ai') ? 'micro1.ai' : host;
    const { code, kind } = parseReferralCode(url);
    if (kind === 'none') continue;
    const key = `${shortHost}|${kind}`;
    if (!groups.has(key)) groups.set(key, { host: shortHost, kind, rows: [] });
    groups.get(key).rows.push({ ...row, code });
  }

  const issues = [];
  const summary = {};

  for (const { host, kind, rows: groupRows } of groups.values()) {
    const counts = new Map();
    for (const row of groupRows) counts.set(row.code, (counts.get(row.code) || 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const dominant = ranked[0] || null;
    const key = `${host}:${kind}`;
    summary[key] = {
      links: groupRows.length,
      codes: ranked.length,
      kind,
      dominantCode: dominant ? dominant[0] : null,
      dominantCount: dominant ? dominant[1] : 0
    };

    if (kind === 'query') {
      const dominantIsMost = Boolean(dominant) && dominant[1] / groupRows.length >= dominantShare;
      if (!dominantIsMost) continue;
      for (const row of groupRows) {
        if (row.code === dominant[0]) continue;
        issues.push({
          offerId: row.id || null,
          title: row.title || null,
          code: row.code,
          expectedCode: dominant[0],
          reason: 'foreign_code',
          detail: `${host} pays ${dominant[0]} on ${dominant[1]} of ${groupRows.length} links; this one pays ${row.code}`
        });
      }
      continue;
    }

    // Per-role codes: a repeat means two offers claim the same role.
    for (const [code, count] of ranked) {
      if (count <= 1) continue;
      const titles = groupRows.filter((r) => r.code === code).map((r) => r.title || '(untitled)');
      issues.push({
        offerId: null,
        title: titles[0],
        code,
        expectedCode: null,
        reason: 'shared_code',
        detail: `${code} is attached to ${count} offers: ${titles.join(' | ')}`
      });
    }
  }

  return {
    issues,
    summary,
    checked: (Array.isArray(rows) ? rows : []).filter((row) => row && row.referral_url).length
  };
}
