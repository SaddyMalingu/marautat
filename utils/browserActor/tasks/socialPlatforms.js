/**
 * Where social listening looks, per network (2026-11-04)
 *
 * One listener, several sites, each with its own idea of what a "post" is. The first version was
 * LinkedIn-only and hard-coded; on 2026-11-04 it read three searches and reported
 * `0 post(s) on the page` three times, then finished `succeeded`. That is the failure this file
 * exists to make impossible to hide: if a network's DOM has moved, the run must say **which
 * selector list failed and what the page actually contained**, not report an empty week.
 *
 * So every platform is a *description*, not code:
 *
 *   - where to search (`searchUrl(phrase)`)
 *   - how to tell signed-in from walled (`sessionExpr`)
 *   - how to read posts, with **several candidate selectors per field** (`postsExpr`)
 *   - how fast a human would move (`pace`), how many posts to read, how long a first line may be
 *     before the site truncates it (`draftLimit`)
 *
 * Nothing here clicks, sends or reacts. A first touch on any of these networks carries the
 * tenant's own name, so the run stops at "here is the post, here is a first line".
 */

/** The networks the taxonomy names, in the order a Kenyan B2B seller would try them. */
export const SOCIAL_PLATFORM_IDS = Object.freeze(['linkedin', 'x', 'facebook', 'reddit', 'youtube']);

const CLEAN = `const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();`;

/**
 * Read posts from a page using an ordered list of candidate selectors.
 *
 * The first container selector that matches anything wins, and the **name of the strategy** comes
 * back with the posts. That single field is the difference between "LinkedIn changed its markup"
 * and "nobody is talking about this", which look identical from the outside.
 */
export function postsExprFor({ containers, text, author, link, profile, stripQuery = true }) {
  return `(() => {
  ${CLEAN}
  const containers = ${JSON.stringify(containers)};
  const textSel = ${JSON.stringify(text)};
  const authorSel = ${JSON.stringify(author)};
  const linkSel = ${JSON.stringify(link)};
  const profileSel = ${JSON.stringify(profile || [])};
  // A permalink with tracking params is the same post under a different string, which would
  // defeat the (tenant, post_url) uniqueness and show one post twice. Facebook is the exception:
  // its permalinks carry the id in the query, so there the query stays.
  const stripQuery = ${stripQuery ? 'true' : 'false'};
  const first = (root, sels) => {
    for (const sel of sels) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch { /* an invalid selector must not end the run */ }
    }
    return null;
  };
  let strategy = null;
  let nodes = [];
  for (const candidate of containers) {
    let found = [];
    try { found = Array.from(document.querySelectorAll(candidate.selector)); } catch { found = []; }
    if (found.length) { strategy = candidate.name; nodes = found; break; }
  }
  const posts = [];
  const seen = new Set();
  for (const node of nodes) {
    const textEl = first(node, textSel) || node;
    const bodyText = clean(textEl.innerText || textEl.textContent || '').slice(0, 3000);
    if (bodyText.length < 20) continue;
    const linkEl = first(node, linkSel);
    let href = linkEl ? String(linkEl.href || '') : '';
    if (href) href = stripQuery ? href.split(/[?#]/)[0] : href.split('#')[0];
    if (!href || !/^https?:/i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const authorEl = first(node, authorSel);
    const profileEl = first(node, profileSel);
    posts.push({
      postUrl: href,
      text: bodyText,
      authorName: clean(authorEl ? (authorEl.innerText || authorEl.textContent) : '').slice(0, 120),
      profileUrl: profileEl ? String(profileEl.href || '').split('?')[0] : ''
    });
  }
  const bodyStart = clean(document.body ? document.body.innerText : '').slice(0, 240);
  return JSON.stringify({
    ok: true,
    url: String(location.href),
    title: clean(document.title),
    strategy: strategy,
    candidates: nodes.length,
    count: posts.length,
    posts: posts.slice(0, 40),
    bodyStart: bodyStart
  });
})()`;
}

/**
 * Is this profile signed in, walled, half-loaded, or asking for cookies?
 *
 * Four answers, because three of them used to look like "no results": a consent banner covers the
 * page, a login wall replaces it, and a slow render leaves it empty.
 */
export function sessionExprFor({ wallPattern, consentSelectors = [], meSelectors = [], resultsSelectors = [] }) {
  return `(() => {
  ${CLEAN}
  const url = String(location.href);
  const text = clean(document.body ? document.body.innerText : '');
  const lower = text.toLowerCase();
  const wall = ${JSON.stringify(String(wallPattern))}.split('|').some((part) => part && (lower.includes(part) || url.includes(part)));
  const has = (sels) => sels.some((sel) => { try { return Boolean(document.querySelector(sel)); } catch { return false; } });
  const consent = has(${JSON.stringify(consentSelectors)});
  const me = has(${JSON.stringify(meSelectors)});
  const results = has(${JSON.stringify(resultsSelectors)});
  return JSON.stringify({
    ok: true,
    url: url,
    title: clean(document.title),
    wall: wall,
    consent: consent,
    me: me,
    results: results,
    bodyStart: text.slice(0, 240)
  });
})()`;
}
// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Selector lists are ordered by how likely they are to still work. Every one of these sites is
 * obfuscated and redesigns without notice, which is why the lists live here rather than inline,
 * and why the run reports which one matched.
 */
export const SOCIAL_PLATFORMS = Object.freeze({
  linkedin: Object.freeze({
    id: 'linkedin',
    name: 'LinkedIn',
    homeUrl: 'https://www.linkedin.com/feed/',
    actionHint: 'Reply to the post, or message the author',
    draftLimit: 1900,
    pace: { minMs: 4500, maxMs: 11000 },
    maxPostsPerQuery: 15,
    searchUrl: (phrase) => 'https://www.linkedin.com/search/results/content/'
      + `?keywords=${encodeURIComponent(phrase)}&datePosted=%22past-week%22&sortBy=%22date_posted%22`,
    sessionExpr: sessionExprFor({
      wallPattern: 'authwall|/login|/signup|sign in to continue|join linkedin',
      consentSelectors: ['[data-test-id="cookie-banner"]', '.artdeco-cookie-banner', 'button[action-type="ACCEPT"]'],
      meSelectors: ['img.global-nav__me-photo', '.global-nav__me', '[data-test-id="nav-me"]', '.feed-identity-module'],
      resultsSelectors: ['[data-urn*="urn:li:activity"]', '.feed-shared-update-v2', 'div.scaffold-finite-scroll__content']
    }),
    postsExpr: postsExprFor({
      containers: [
        { name: 'activity-urn', selector: '[data-urn*="urn:li:activity"]' },
        { name: 'feed-shared-update', selector: '.feed-shared-update-v2' },
        { name: 'search-result-container', selector: 'div.search-results-container li' }
      ],
      text: ['[class*="update-components-text"]', '.feed-shared-text', '[class*="commentary"]', '[dir="ltr"]'],
      author: ['[class*="actor__name"]', '[class*="update-components-actor__title"] span', '.feed-shared-actor__name'],
      link: ['a[href*="/feed/update/"]', 'a[href*="/posts/"]', 'a[href*="/pulse/"]'],
      profile: ['a[href*="/in/"]']
    }),
    note: 'Content search, last week, newest first. Needs the profile signed in.'
  }),

  x: Object.freeze({
    id: 'x',
    name: 'X',
    homeUrl: 'https://x.com/home',
    actionHint: 'Reply in the thread, or send a direct message',
    draftLimit: 260,
    pace: { minMs: 3000, maxMs: 7000 },
    maxPostsPerQuery: 15,
    searchUrl: (phrase) => `https://x.com/search?q=${encodeURIComponent(`${phrase} -filter:replies`)}&f=live`,
    sessionExpr: sessionExprFor({
      wallPattern: 'log in|sign in to x|join x|/i/flow/login',
      consentSelectors: ['[data-testid="BottomBar"]', 'div[role="dialog"][aria-modal="true"]'],
      meSelectors: ['[data-testid="SideNav_AccountSwitcher_Button"]', 'a[data-testid="AppTabBar_Profile_Link"]'],
      resultsSelectors: ['article[data-testid="tweet"]', 'div[data-testid="cellInnerDiv"]']
    }),
    postsExpr: postsExprFor({
      containers: [
        { name: 'tweet-article', selector: 'article[data-testid="tweet"]' },
        { name: 'cell-inner', selector: 'div[data-testid="cellInnerDiv"] article' },
        { name: 'any-article', selector: 'article' }
      ],
      text: ['[data-testid="tweetText"]', 'div[lang]'],
      author: ['[data-testid="User-Name"]', 'div[data-testid="User-Name"] a'],
      link: ['a[href*="/status/"]'],
      profile: ['div[data-testid="User-Name"] a[href^="/"]']
    }),
    note: 'Live search, replies filtered out. A first line over 260 characters is truncated by X itself.'
  }),

  facebook: Object.freeze({
    id: 'facebook',
    name: 'Facebook',
    homeUrl: 'https://www.facebook.com/',
    actionHint: 'Comment on the post, or message the author',
    draftLimit: 8000,
    pace: { minMs: 4000, maxMs: 9000 },
    maxPostsPerQuery: 12,
    searchUrl: (phrase) => `https://www.facebook.com/search/posts/?q=${encodeURIComponent(phrase)}`,
    sessionExpr: sessionExprFor({
      wallPattern: 'log in to continue|you must log in|/login',
      consentSelectors: ['[data-testid="cookie-policy-manage-dialog"]', 'div[aria-label*="cookie" i]'],
      meSelectors: ['[aria-label="Your profile"]', 'div[role="navigation"] a[href*="/me"]'],
      resultsSelectors: ['div[role="article"]']
    }),
    postsExpr: postsExprFor({
      containers: [
        { name: 'role-article', selector: 'div[role="article"]' },
        { name: 'feed-unit', selector: 'div[data-pagelet^="FeedUnit"]' },
        { name: 'story-link', selector: 'div[role="main"] a[href*="/posts/"]' }
      ],
      text: ['div[dir="auto"] span', 'div[dir="auto"]'],
      author: ['h3 a', 'h4 a', 'strong a', 'a[role="link"]'],
      link: ['a[href*="/posts/"]', 'a[href*="story_fbid"]', 'a[href*="/permalink/"]'],
      profile: ['a[href*="/profile.php"]', 'h3 a', 'h4 a'],
      // Facebook permalinks carry the post id in the query string, so it has to survive.
      stripQuery: false
    }),
    note: 'Public post search. Facebook shows less to a signed-in account than it used to; a wall here means the profile needs one manual visit.'
  }),

  reddit: Object.freeze({
    id: 'reddit',
    name: 'Reddit',
    homeUrl: 'https://www.reddit.com/',
    actionHint: 'Reply in the thread',
    draftLimit: 10000,
    pace: { minMs: 2000, maxMs: 5000 },
    maxPostsPerQuery: 20,
    searchUrl: (phrase) => `https://www.reddit.com/search/?q=${encodeURIComponent(phrase)}&t=week&sort=new`,
    sessionExpr: sessionExprFor({
      wallPattern: 'blocked|whoa there|/login',
      consentSelectors: ['[data-testid="consent-banner"]', 'faceplate-tracker[noun="cookie"]'],
      meSelectors: ['#expand-user-drawer-button', '[data-testid="user-drawer-button"]'],
      resultsSelectors: ['div[data-testid="post-container"]', 'shreddit-post', 'div.thing']
    }),
    postsExpr: postsExprFor({
      containers: [
        { name: 'post-container', selector: 'div[data-testid="post-container"]' },
        { name: 'shreddit-post', selector: 'shreddit-post' },
        { name: 'classic-thing', selector: 'div.thing[data-type="link"]' }
      ],
      text: ['h1', '[slot="title"]', 'a[data-testid="post-title"]', 'a.title'],
      author: ['a[href^="/user/"]', '[slot="authorName"]'],
      link: ['a[data-click-id="body"]', 'a[slot="full-post-link"]', 'a[data-testid="post-title"]', 'a.comments'],
      profile: ['a[href^="/user/"]']
    }),
    note: 'Search returns titles, so the score leans on the title wording: fast to read, weaker evidence than a body.'
  }),

  youtube: Object.freeze({
    id: 'youtube',
    name: 'YouTube',
    homeUrl: 'https://www.youtube.com/',
    actionHint: 'Comment under the video',
    draftLimit: 10000,
    pace: { minMs: 2500, maxMs: 6000 },
    maxPostsPerQuery: 15,
    searchUrl: (phrase) => `https://www.youtube.com/results?search_query=${encodeURIComponent(phrase)}`,
    sessionExpr: sessionExprFor({
      wallPattern: 'sign in to continue|consent.youtube.com',
      consentSelectors: ['tp-yt-paper-dialog[aria-modal="true"]', 'ytd-consent-bump-v2-lightbox'],
      meSelectors: ['#avatar-btn', 'ytd-topbar-menu-button-renderer #avatar-btn'],
      resultsSelectors: ['ytd-video-renderer', 'ytd-rich-item-renderer']
    }),
    postsExpr: postsExprFor({
      containers: [
        { name: 'video-renderer', selector: 'ytd-video-renderer' },
        { name: 'rich-item', selector: 'ytd-rich-item-renderer' },
        { name: 'compact-renderer', selector: 'ytd-compact-video-renderer' }
      ],
      text: ['#video-title', 'h3 a#video-title', 'yt-formatted-string#video-title'],
      author: ['#channel-name a', 'ytd-channel-name a', 'a.yt-simple-endpoint'],
      link: ['a#video-title', 'a#thumbnail'],
      profile: ['#channel-name a', 'ytd-channel-name a']
    }),
    note: 'Reads video titles, not comments — so the signal is "someone published about this", which is weaker than a reply. Comments would mean opening every result.'
  })
});

/**
 * How long to keep waiting for results, per network.
 *
 * LinkedIn's content search hydrates slowly on a cold profile — the first search of a run can
 * spend twenty seconds showing nothing but the global nav, which reads as `0 candidates` and
 * looks exactly like a changed DOM. Facebook is not much faster. Reddit and YouTube render
 * server-side and are ready almost immediately.
 */
const WAIT_MS = Object.freeze({
  linkedin: 60_000,
  facebook: 45_000,
  x: 30_000,
  youtube: 30_000,
  reddit: 25_000
});

export function waitMsFor(platformId) {
  return WAIT_MS[String(platformId || '').toLowerCase()] || 30_000;
}

/** Ordered list for the panel and the run, so the UI and the worker cannot disagree. */
export function listSocialPlatforms() {
  return SOCIAL_PLATFORM_IDS.map((id) => SOCIAL_PLATFORMS[id]).filter(Boolean);
}

export function getSocialPlatform(id) {
  return SOCIAL_PLATFORMS[String(id || '').trim().toLowerCase()] || null;
}

export function isSocialPlatform(id) {
  return Boolean(getSocialPlatform(id));
}

/** What the panel may show about a network: no selector internals, no expression source. */
export function describeSocialPlatform(id) {
  const platform = getSocialPlatform(id);
  if (!platform) return null;
  return {
    id: platform.id,
    name: platform.name,
    homeUrl: platform.homeUrl,
    actionHint: platform.actionHint,
    draftLimit: platform.draftLimit,
    paceSeconds: [Math.round(platform.pace.minMs / 1000), Math.round(platform.pace.maxMs / 1000)],
    note: platform.note,
    // Stated next to the link: this reads, it never writes.
    writes: false
  };
}


/** Snapshot -> the same vocabulary the marketplace probes use. */
export function classifySocialSession(snapshot) {
  if (!snapshot || snapshot.ok === false) return 'unknown';
  if (snapshot.consent && !snapshot.results) return 'consent_wall';
  if (snapshot.wall && !snapshot.me && !snapshot.results) return 'login_wall';
  if (snapshot.results || snapshot.me) return 'signed_in';
  return 'unknown';
}

/** A jittered delay: a fixed interval is the clearest machine signature there is. */
export function socialPaceMs(pace, { rng = Math.random } = {}) {
  const low = Math.max(0, Number(pace?.minMs) || 0);
  const high = Math.max(low, Number(pace?.maxMs) || low);
  return Math.round(low + (high - low) * rng());
}
