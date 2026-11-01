/**
 * "Is this profile still signed in?" (2026-11-02)
 *
 * The failure this exists to prevent: a logged-out profile looks exactly like a listing
 * with no roles. A run then "succeeds" with zero captures, the portal shows green, and the
 * tenant stops earning quietly — the same class of bug as a referral link that points at
 * the wrong job. So every connect and verify asks the page, not the vendor:
 *
 *   signed_in    cards are rendered, which only happens for a signed-in account
 *   login_wall   a sign-in affordance is present and no cards are
 *   unknown      neither signal — say so rather than guess (a redesign, a slow render)
 *
 * Pure apart from the page expressions, which are evaluated by the caller.
 */
export const SIGNED_IN_STATES = Object.freeze(['signed_in', 'login_wall', 'unknown']);

/** Signals that mean "this page wants credentials". */
export const LOGIN_SIGNAL_WORDS = Object.freeze([
  'sign in', 'signin', 'log in', 'login', 'forgot password', 'create account', 'continue with google'
]);

const CLEAN = `const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();`;
const SIGNALS = `const lower = clean(document.body ? document.body.innerText : '').toLowerCase();
  const signals = ${JSON.stringify(LOGIN_SIGNAL_WORDS)}.filter((word) => lower.includes(word));`;

/** Micro1: the referral dashboard. Cards are `div.grid` children that carry an h2. */
export const MICRO1_SIGNED_IN_PROBE = `(() => {
  ${CLEAN}
  const grid = Array.from(document.querySelectorAll('div.grid'))
    .find((el) => /grid-cols-3/.test(typeof el.className === 'string' ? el.className : '') && el.children.length >= 3);
  const cards = grid ? Array.from(grid.children) : [];
  ${SIGNALS}
  const text = clean(document.body ? document.body.innerText : '');
  return JSON.stringify({
    ok: true,
    url: String(location.href),
    title: clean(document.title),
    cards: cards.filter((card) => card.querySelector('h2')).length,
    // The account chrome only renders for a signed-in referrer.
    accountChrome: /your referral link/i.test(text),
    signals: signals.slice(0, 6)
  });
})()`;

/** Turing: the jobs listing. Cards are direct children of the grid container. */
export const TURING_SIGNED_IN_PROBE = `(() => {
  ${CLEAN}
  const grid = document.querySelector('div.grid.gap-6.grid-cols-1');
  const cards = grid ? Array.from(grid.children).filter((card) => card.querySelector('h3')) : [];
  ${SIGNALS}
  const text = clean(document.body ? document.body.innerText : '');
  return JSON.stringify({
    ok: true,
    url: String(location.href),
    title: clean(document.title),
    cards: cards.length,
    accountChrome: /all \\d+|priority \\d+/i.test(text),
    signals: signals.slice(0, 6)
  });
})()`;

export const SIGNED_IN_PROBES = Object.freeze({
  micro1: MICRO1_SIGNED_IN_PROBE,
  turing: TURING_SIGNED_IN_PROBE
});

export function signedInProbeFor(platform) {
  return SIGNED_IN_PROBES[String(platform || '').toLowerCase()] || null;
}

/**
 * Snapshot -> state.
 *
 * Cards win over signals because a signed-in page can still contain the word "login"
 * somewhere in its chrome; a login wall cannot render cards. Unknown is a real answer and
 * is reported as such, never coerced into "signed in".
 */
export function classifySignedIn(snapshot) {
  if (!snapshot || snapshot.ok === false) return 'unknown';
  const cards = Number(snapshot.cards) || 0;
  if (cards > 0) return 'signed_in';
  const signals = Array.isArray(snapshot.signals) ? snapshot.signals.length : 0;
  if (signals > 0) return 'login_wall';
  return 'unknown';
}

/** Per-platform verdicts -> one record for `metadata.browserAccess`. */
export function summarizeSignedIn(results = {}) {
  const platforms = {};
  const verified = [];
  const reauth = [];
  for (const [platform, snapshot] of Object.entries(results)) {
    const state = classifySignedIn(snapshot);
    platforms[platform] = state;
    if (state === 'signed_in') verified.push(platform);
    if (state === 'login_wall') reauth.push(platform);
  }
  return {
    platforms,
    verified,
    reauth,
    // Only a login wall on every checked platform is a definite re-auth requirement.
    // Unknown alone means the check could not conclude — do not alarm the tenant for it.
    reauthRequired: verified.length === 0 && reauth.length > 0
  };
}
