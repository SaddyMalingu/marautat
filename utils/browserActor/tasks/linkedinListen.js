/**
 * LinkedIn listening adapter (2026-11-04)
 *
 * What this is: the eyes. It opens the tenant's own signed-in LinkedIn, runs the taxonomy's
 * search phrases, and reads what people wrote. It does **not** score, store, connect to anyone,
 * or decide whether a post matters — that happens server-side, so a worker token can describe
 * what it saw but cannot rank a tenant's prospects.
 *
 * Why content search and not the feed: the feed is what LinkedIn wants a human to read; search
 * is what answers "who just said they need this". `sortBy=date_posted` keeps it to the last week
 * instead of a relevance ranking that has not changed since 2019.
 *
 * Why no messaging here at all: a first touch on LinkedIn is a human act, on a human's account,
 * with a human's name on it. The run stops at "here is the post, here is a first line". The
 * velocity budget below exists so that *reading* cannot look like scraping, not so this can send.
 */

export const LINKEDIN_PLATFORM = Object.freeze({
  slug: 'linkedin',
  name: 'LinkedIn',
  origin: 'https://www.linkedin.com',
  feedUrl: 'https://www.linkedin.com/feed/'
});

/** Content search, newest first, last week. The one URL shape LinkedIn has kept stable. */
export function linkedInSearchUrl(phrase) {
  const keywords = encodeURIComponent(String(phrase || '').trim());
  return `${LINKEDIN_PLATFORM.origin}/search/results/content/?keywords=${keywords}`
    + '&datePosted=%22past-week%22&sortBy=%22date_posted%22';
}

/** How many results to read per query before moving on. Reading is the expensive part. */
export const LINKEDIN_MAX_POSTS_PER_QUERY = 15;

/** Pause between queries. A human reading six searches does not do it in nine seconds. */
export const LINKEDIN_PACE = Object.freeze({ minMs: 4500, maxMs: 11000 });

/**
 * Jitter, not a constant delay: a fixed interval is the clearest possible machine signature.
 * `rng` is injectable so the pacing is testable without waiting.
 */
export function linkedInPaceMs({ rng = Math.random, minMs = LINKEDIN_PACE.minMs, maxMs = LINKEDIN_PACE.maxMs } = {}) {
  const low = Math.max(0, Number(minMs) || 0);
  const high = Math.max(low, Number(maxMs) || low);
  return Math.round(low + (high - low) * rng());
}

/** Is this profile actually signed in? A logged-out search looks exactly like "no results". */
export const LINKEDIN_SESSION_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const url = String(location.href);
  const text = clean(document.body ? document.body.innerText : '').toLowerCase();
  const wall = /authwall|\\/login|\\/signup|sign in to continue|join linkedin/.test(url + ' ' + text);
  const me = Boolean(document.querySelector('img.global-nav__me-photo, .global-nav__me, [data-test-id="nav-me"], button[data-control-name="nav.settings"], .feed-identity-module'));
  const posts = document.querySelectorAll('[data-urn*="urn:li:activity"], .feed-shared-update-v2').length;
  return JSON.stringify({ ok: true, url: url, me: me, wall: wall, posts: posts });
})()`;

/**
 * Read the posts on the page.
 *
 * LinkedIn's class names are hashed and change; the `data-urn` attribute carries the activity id
 * and has survived every redesign so far, so identity comes from there and everything else is a
 * best-effort selector. A card whose text cannot be read is skipped rather than stored empty —
 * an empty post would score as a signal with no evidence behind it.
 */
export const LINKEDIN_POSTS_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const cards = Array.from(document.querySelectorAll('[data-urn*="urn:li:activity"], .feed-shared-update-v2, div[data-id^="urn:li:activity"]'));
  const seen = new Set();
  const posts = [];
  for (const card of cards) {
    const urn = card.getAttribute('data-urn') || card.getAttribute('data-id') || '';
    const textEl = card.querySelector('[class*="update-components-text"], .feed-shared-text, [class*="commentary"]');
    const text = clean(textEl ? textEl.innerText : '').slice(0, 3000);
    if (text.length < 20) continue;
    const authorEl = card.querySelector('[class*="actor__name"], [class*="update-components-actor__title"] span, .feed-shared-actor__name');
    const authorName = clean(authorEl ? authorEl.innerText : '').slice(0, 120);
    const linkEl = card.querySelector('a[href*="/feed/update/"], a[href*="/posts/"]');
    const href = linkEl ? String(linkEl.href).split('?')[0] : '';
    const postUrl = href || (urn ? 'https://www.linkedin.com/feed/update/' + urn + '/' : '');
    const profileEl = card.querySelector('a[href*="/in/"]');
    if (!postUrl) continue;
    if (seen.has(postUrl)) continue;
    seen.add(postUrl);
    posts.push({
      postUrl: postUrl,
      authorName: authorName,
      profileUrl: profileEl ? String(profileEl.href).split('?')[0] : '',
      text: text
    });
  }
  return JSON.stringify({ ok: true, url: String(location.href), count: posts.length, posts: posts.slice(0, 40) });
})()`;

/**
 * Snapshot -> the same vocabulary `signedIn.js` uses, so a run's message is consistent across
 * marketplaces: a login wall is a `reauthRequired`, never an empty run.
 */
export function classifyLinkedInSession(snapshot) {
  if (!snapshot || snapshot.ok === false) return 'unknown';
  if (snapshot.fragile) return 'unknown';
  if (snapshot.wall && !snapshot.me) return 'login_wall';
  if (Number(snapshot.posts) > 0) return 'signed_in';
  if (snapshot.me) return 'signed_in';
  return 'unknown';
}

/** The descriptor the runner and the tests agree on. */
export function describeLinkedInTask() {
  return {
    platform: LINKEDIN_PLATFORM.slug,
    kind: 'listen',
    label: 'Listen on LinkedIn',
    maxPostsPerQuery: LINKEDIN_MAX_POSTS_PER_QUERY,
    pace: { ...LINKEDIN_PACE },
    // Reads only. Nothing in this adapter can send, connect, or react.
    writes: false
  };
}
