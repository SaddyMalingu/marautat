/**
 * Is the tenant's browser still the tenant, and is the marketplace showing the page or a wall?
 * (2026-11-05)
 *
 * The listening path has asked this since the first social run (`classifySocialSession`), and the
 * two marketplace runners never did. That asymmetry is expensive in exactly one situation, and it
 * is the situation a pause creates: the MoreLogin profile comes back after 24 hours away, the
 * marketplace has quietly signed it out, and the runner spends its window clicking "Share & earn"
 * on a listing that is not there. Every role fails, five failures in a row stop the run, and the
 * run says `card_not_found` — which reads like "the marketplace changed its markup" and sends
 * everyone looking in the wrong place.
 *
 * A wall is a fact worth one page read. This module names it, so the runner can stop *before*
 * spending the window and tell the tenant the one thing that fixes it: sign in again.
 *
 * Deliberately structural where it can be: a password field on a listing is not a content
 * decision, it is the login form. Text matching is a fallback for interstitials, which have no DOM
 * to rely on.
 */

/**
 * Phrases that mean "a machine is being asked to prove it is not a machine".
 *
 * Kept narrow on purpose: a false `challenge` refuses a run that would have worked, and the tenant
 * has no way to tell that apart from a real block.
 */
export const CHALLENGE_RE = /\b(verify (that )?you are (a )?human|are you a robot|cf-challenge|complete the security check|checking your browser|unusual (activity|traffic)|too many requests|access denied|request blocked|just a moment|attention required)\b/i;

/** Titles/paths that mean the session is gone rather than the page. */
const LOGIN_RE = /\b(sign[-\s]?in|log[-\s]?in|login|signin|authenticate|session (has )?expired)\b/i;
const LOGIN_PATH_RE = /^\/?(?:.*\/)?(?:login|signin|sign-in|auth|session\/new)(?:[/?#]|$)/i;

/**
 * What the browser is looking at.
 *
 * @param {{url?: string, title?: string, bodyStart?: string, hasPasswordField?: boolean,
 *          hasListing?: boolean}} snapshot
 * @returns {{state: 'signed_in'|'login_wall'|'challenge'|'unknown', reason: string, hint: string|null}}
 */
export function classifyMarketplaceSession(snapshot = {}) {
  const url = String(snapshot.url || '');
  const title = String(snapshot.title || '');
  const body = String(snapshot.bodyStart || '');
  const text = `${title}\n${body}`;

  if (snapshot.hasPasswordField === true) {
    return {
      state: 'login_wall',
      reason: 'password field on the page',
      hint: 'the marketplace has signed this profile out — open MoreLogin, sign in there, then run again'
    };
  }
  if (CHALLENGE_RE.test(text)) {
    return {
      state: 'challenge',
      reason: 'a verification or rate-limit page is showing',
      hint: 'stop for the day and finish the check by hand in MoreLogin; a machine that retries makes it worse'
    };
  }
  let path = '';
  try { path = new URL(url).pathname; } catch { path = ''; }
  if (LOGIN_PATH_RE.test(path)) {
    return {
      state: 'login_wall',
      reason: `the browser was sent to ${path}`,
      hint: 'sign in inside the MoreLogin profile, then run again'
    };
  }
  if (LOGIN_RE.test(title)) {
    return {
      state: 'login_wall',
      reason: `the page title is "${title.slice(0, 80)}"`,
      hint: 'sign in inside the MoreLogin profile, then run again'
    };
  }
  if (snapshot.hasListing === true) {
    return { state: 'signed_in', reason: 'the listing is on the page', hint: null };
  }
  return {
    state: 'unknown',
    reason: 'the page loaded but nothing recognisable is on it',
    hint: null
  };
}

/** True when the run must not continue. */
export function blocksRun(state) {
  return state === 'login_wall' || state === 'challenge';
}

/**
 * The error a runner throws when a wall is in the way.
 *
 * A thrown error rather than a `return []`, because an empty capture list is indistinguishable from
 * a quiet marketplace — and it is exactly that confusion ("0 captured, succeeded") that let a
 * signed-out profile look like a normal morning.
 */
export function sessionWallError(gate = {}) {
  const what = gate.state === 'challenge' ? 'a verification page' : 'a sign-in page';
  const message = `${what} is showing: ${gate.reason || 'the session is not signed in'}. ${gate.hint || ''}`
    .replace(/\s+/g, ' ')
    .trim();
  const error = new Error(message);
  error.code = `session_${gate.state || 'wall'}`;
  error.gate = gate;
  return error;
}

/**
 * One read that answers the question above, for any marketplace.
 *
 * `listingSelector` is the marketplace's own container: if it is on the page, the page is the page.
 * Everything else the expression collects is evidence for a wall, never a way to proceed.
 */
export function sessionGateExpr({ listingSelector }) {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  let hasListing = false;
  try { hasListing = Boolean(${JSON.stringify(String(listingSelector || 'body'))}) && document.querySelectorAll(${JSON.stringify(String(listingSelector || 'body'))}).length > 0; } catch { hasListing = false; }
  return JSON.stringify({
    url: String(location.href),
    title: clean(document.title).slice(0, 200),
    hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
    hasListing,
    bodyStart: clean(document.body ? document.body.innerText : '').slice(0, 300)
  });
})()`;
}
