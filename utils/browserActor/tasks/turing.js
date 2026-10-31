/**
 * Turing adapter (2026-10-31) — verified against a live logged-in session.
 *
 * Evidence, captured through the Browser Actor on profile P-4 as the tenant:
 *   url          https://work.turing.com/jobs
 *   title        "Work remotely with Turing to advance AI"
 *   totals       "All 231", "Priority 12", "Newest 29"
 *   container    div.grid.gap-6.grid-cols-1  (12 cards rendered, "Load more roles")
 *   card         div.h-full.min-h-0
 *     meta       div.mb-3.flex -> ["Priority", "$750"]   (rate badge + priority flag)
 *     title      h3.mb-1.5.min-h-[3rem]
 *     summary    p.min-h-[2.5rem].text-sm
 *     links      none — the card is a JS click target, so there is no per-role href
 *
 * Two consequences that shape this file:
 *   1. Identity must be derived from the title, because the page exposes no id.
 *   2. There is no deep link to a role, so `url` points at the listing and the
 *      caller must not pretend otherwise.
 *
 * The listing also renders skeletons (`.animate-pulse`) before the cards appear, so
 * every read waits for them to clear. See scripts/browser_actor_inspect.mjs.
 */

export const TURING_PLATFORM = Object.freeze({
  slug: 'turing',
  name: 'Turing',
  listUrl: 'https://work.turing.com/jobs',
  source: 'turing',
  listSelector: 'div.grid.gap-6.grid-cols-1',
  cardSelector: 'div.h-full.min-h-0',
  wait: { selector: '.animate-pulse', mode: 'absent', maxMs: 20000 },
  auth: 'tenant_account',
  /**
   * How a per-role referral link is revealed (confirmed by the tenant, 2026-10-31):
   *   a) click the dollar amount on the card, or
   *   b) expand the card and click the "referral bonus" link just below "Apply Now".
   *
   * There is no tenant-level Turing link — which is exactly why `referrals.js`
   * resolves links per role and never per platform. Automating this needs two real
   * interactions (expand, then click), so it is deliberately not built yet: it is a
   * UI action on a logged-in account, not a read.
   */
  referralDiscovery: {
    viaCardAmount: true,
    viaExpandThen: 'referral bonus link below "Apply Now"',
    automated: false
  }
});

/**
 * Runs inside the page. Reads only what is on screen: no clicking, no scrolling,
 * no "Load more" — a first page of cards is enough to prove the path, and paging is
 * a deliberate decision, not an accident.
 */
export const TURING_COLLECT_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const container = document.querySelector(${JSON.stringify(TURING_PLATFORM.listSelector)});
  if (!container) {
    return JSON.stringify({ ok: false, reason: 'listing_not_found', items: [], totals: null });
  }

  // Category chips read "All 231", "Priority 12", "Newest 29".
  const totals = {};
  for (const btn of document.querySelectorAll('button')) {
    const text = clean(btn.innerText);
    const m = text.match(/^(All|Priority|Newest)\\s+(\\d[\\d,]*)$/i);
    if (m) totals[m[1].toLowerCase()] = Number(m[2].replace(/,/g, ''));
  }

  const items = Array.from(container.children).map((card) => {
    const meta = card.querySelector('div.mb-3');
    const title = card.querySelector('h3');
    const summary = card.querySelector('p');
    return {
      metaText: clean(meta ? meta.innerText : '').slice(0, 120),
      titleText: clean(title ? title.innerText : '').slice(0, 200),
      summaryText: clean(summary ? summary.innerText : '').slice(0, 400),
      cardText: clean(card.innerText).slice(0, 500)
    };
  }).filter((item) => item.titleText);

  return JSON.stringify({
    ok: true,
    url: String(location.href),
    count: items.length,
    totals,
    items
  });
})()`;


/** Stable slug so re-reading the same role twice does not create two rows. */
export function roleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Turn one scraped card into the shape the opportunities table already uses.
 * Pure, so a test can feed it the exact strings the live page produced: a selector
 * change that breaks parsing then fails a test instead of a tenant.
 */
export function normalizeTuringItem(item = {}) {
  const title = String(item.titleText || '').trim();
  if (!title) return null;

  const meta = String(item.metaText || '');
  // "Priority $750" | "Priority $100" | "$100-150/hr"
  const rateMatch = meta.match(/\$\s?\d[\d,]*(?:\s?-\s?\$?\s?\d[\d,]*)?(?:\s?\/\s*(?:hr|hour))?/i);
  const rate = rateMatch ? rateMatch[0].replace(/\s+/g, '') : null;
  const priority = /\bpriority\b/i.test(meta);

  const summary = String(item.summaryText || '').trim();
  return {
    externalId: `turing:${roleKey(title)}`,
    source: TURING_PLATFORM.source,
    title,
    rate,
    priority,
    summary: summary || null,
    // The listing exposes no per-role href, so point at the page holding the role.
    url: TURING_PLATFORM.listUrl,
    category: null
  };
}

/** Normalize a whole collection payload, deduping by title and dropping junk. */
export function normalizeTuringCollection(payload = {}) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const seen = new Set();
  const unique = items
    .map(normalizeTuringItem)
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item.externalId)) return false;
      seen.add(item.externalId);
      return true;
    });
  return {
    ok: payload.ok !== false,
    source: TURING_PLATFORM.source,
    url: payload.url || TURING_PLATFORM.listUrl,
    totals: payload.totals || null,
    count: unique.length,
    items: unique
  };
}

/**
 * The tenant's own referral link — the thing that actually earns.
 *
 * The model is refer-and-earn, so an offer without the tenant's link is a page
 * that helps a marketplace for free. Turing exposes it at /dashboard/job_referral
 * ("Refer & Earn" in the nav); Micro1 at "Your referral link".
 */
export const TURING_REFERRAL_URL = 'https://work.turing.com/dashboard/job_referral';

/** Collect every URL-looking value on the referral page; pick the best one in JS. */
export const TURING_REFERRAL_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const found = new Set();
  for (const input of document.querySelectorAll('input, textarea')) {
    const value = clean(input.value);
    if (/^https?:\\/\\//i.test(value)) found.add(value);
  }
  for (const a of document.querySelectorAll('a[href]')) {
    const href = String(a.href || '');
    if (/^https?:\\/\\//i.test(href)) found.add(href);
  }
  const text = clean(document.body ? document.body.innerText : '');
  for (const match of text.match(/https?:\\/\\/[^\\s"']+/g) || []) found.add(match);
  return JSON.stringify({
    ok: true,
    url: String(location.href),
    title: clean(document.title),
    candidates: Array.from(found).slice(0, 40)
  });
})()`;

/**
 * Choose the referral link out of everything on the page.
 * Pure, so a page redesign fails a test instead of silently pointing a tenant's
 * CTA at a generic homepage.
 */
export function pickReferralUrl(candidates = [], { host = 'turing.com' } = {}) {
  const urls = (Array.isArray(candidates) ? candidates : [])
    .map((value) => String(value || '').trim())
    .filter((value) => /^https?:\/\//i.test(value))
    .filter((value) => {
      try {
        return new URL(value).hostname.toLowerCase().endsWith(host);
      } catch {
        return false;
      }
    });

  const scored = urls.map((value) => {
    let score = 0;
    if (/[?&]ref=/i.test(value)) score += 40;
    if (/\/r\//i.test(value)) score += 30;
    if (/referr|invite|affiliate/i.test(value)) score += 25;
    // A dashboard/jobs/settings URL is never a referral link.
    if (/\/dashboard|\/jobs|\/login|\/settings|\/welcome/i.test(value)) score -= 50;
    return { value, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score <= 0) return null;
  return best.value;
}

/**
 * Turn a marketplace role into an offer the portal's own form would submit.
 *
 * `offer_type: 'job'` is deliberate: `utils/contentJourney.js` and
 * `utils/blogWriter.js` already treat `job` as career copy aimed at the
 * candidate — and the reader here *is* a candidate, the person the tenant refers.
 *
 * `status` is `draft`, never `published`: the agent proposes, the tenant decides.
 *
 * `tenantSlug` is REQUIRED and never defaulted. Every row here belongs to exactly
 * one tenant (the live session is Malingu Ventures'), and an offer that loses its
 * tenant either disappears from that tenant's portal or, worse, surfaces in
 * another tenant's. Refusing is the only safe behaviour.
 */
export function toOfferDraft(item = {}, { referralUrl = null, tenantSlug = null } = {}) {
  const role = item && item.title ? item : null;
  if (!role) return null;
  if (!tenantSlug) {
    throw new Error('toOfferDraft needs a tenant slug — offers are tenant-scoped');
  }

  const amount = String(role.rate || '').match(/\d[\d,]*/);
  const compensation = amount ? Number(amount[0].replace(/,/g, '')) : null;

  return {
    title: role.title,
    slug: role.externalId ? String(role.externalId).replace(/^[a-z0-9]+:/i, '') : roleKey(role.title),
    offer_type: 'job',
    status: 'draft',
    description: role.summary || null,
    compensation_max: Number.isFinite(compensation) ? compensation : null,
    compensation_currency: 'USD',
    destination_url: TURING_PLATFORM.listUrl,
    // The tenant's own link is what earns; without it the page is charity.
    referral_url: referralUrl || null,
    cta_label: 'Apply through this link',
    source_slug: TURING_PLATFORM.source,
    external_id: role.externalId || null,
    tenant_slug: tenantSlug,
    priority: role.priority === true
  };
}

