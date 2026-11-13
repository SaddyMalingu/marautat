/**
 * Micro1 adapter (2026-11-02) — verified against the tenant's live referral dashboard.
 *
 * Evidence, captured through the Browser Actor on profile P-4 as malingu-ventures:
 *
 *   page        https://refer.micro1.ai/opportunities/   title "Referral dashboard | micro1"
 *   grid        div.grid.grid-cols-1.lg:grid-cols-3   -> 12 cards
 *   card        div.p-1.rounded-md.flex.flex-col      (no anchors at all)
 *     text      "Posted Yesterday New High demand <Title> micro1 <N> Openings
 *                Required skills ... Pay: $<a> - $<b>/hour Refer and earn $<bonus>"
 *     control   <button>Refer and earn $1,500</button>
 *   click       does NOT navigate and does NOT open a dialog. It copies a share link,
 *               which appears in a URL input:
 *                 https://jobs.micro1.ai/post/<jobUuid>?referralCode=<accountCode>
 *                   &utm_source=referral&utm_medium=share&utm_campaign=job_referral
 *
 * Three consequences that shape this file — each one the opposite of Turing:
 *
 *   1. **The referral code is ACCOUNT-level, the job id is per-role.** The same code
 *      appears on all five links the tenant already owns. So a link is post + account
 *      code, and two different codes for one role would mean one of them pays somebody
 *      else — which `planCodeIntegrity` already flags as `foreign_code` for query codes.
 *   2. **There is a real job page**, unlike Turing's cards-without-href:
 *      `jobs.micro1.ai/post/<uuid>`. That is the honest `destination_url`, and it is
 *      where the job body lives.
 *   3. **The job body is client-rendered.** The SSR HTML is 48 KB with 57 characters of
 *      text and no JSON-LD, so the description needs the browser. That is why the
 *      content extractor below is a page expression rather than a fetch.
 *
 * Pure where it can be: URL parsing, link selection and the offer draft are plain
 * functions, so a Micro1 redesign fails a test instead of writing a wrong link.
 */

import { slugifyTitle } from '../referrals.js';
import { offerSlugFor } from '../offersImport.js';

/** Where referral links land. The listing is a different host on purpose. */
export const MICRO1_JOB_HOST = 'jobs.micro1.ai';


/** The tenant's referral dashboard. */
export const MICRO1_PLATFORM = Object.freeze({
  slug: 'micro1',
  name: 'Micro1',
  listUrl: 'https://refer.micro1.ai/opportunities',
  accountUrl: 'https://refer.micro1.ai/opportunities',
  jobUrlBase: 'https://jobs.micro1.ai/post',
  source: 'micro1',
  auth: 'tenant_account',
  /**
   * The grid has no stable id and its Tailwind classes are generated, so the adapter
   * finds it by *shape*: a `div.grid` with 3+ children, one of which is `grid-cols-3`.
   * A class-based selector would break on the next deploy and take the adapter with it.
   */
  /**
   * The grid holding the cards.
   *
   * 2026-11-13: the live page now marks every card `data-testid="job-card"` (24 of them in the
   * saved copy), which is an explicit test hook and therefore strictly better than a shape guess.
   * The old shape probe — a `div.grid` with 3+ children, one of which is `grid-cols-3` — stays as
   * the fallback, because the older build in the second saved copy has no `data-testid` at all.
   */
  gridProbe: "(() => { const card = document.querySelector('[data-testid=\"job-card\"]'); return (card && card.parentElement) || Array.from(document.querySelectorAll('div.grid')).find((el) => /grid-cols-3/.test(typeof el.className === 'string' ? el.className : '') && el.children.length >= 3); })()",
  /** The control that yields the share link, matched by its label rather than a class. */
  referButtonPattern: 'refer and earn',
  wait: { selector: '.animate-pulse', mode: 'absent', maxMs: 20000 }
});

/**
 * The job id inside a Micro1 share link, or null.
 * `.../post/13caa411-9f96-46b1-a762-9b9bd0604cfb?referralCode=...` -> the uuid.
 */
export function micro1JobIdFromUrl(url) {
  const text = String(url || '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    const match = parsed.pathname.match(/\/post\/([0-9a-f-]{16,})/i);
    return match ? match[1] : null;
  } catch {
    const match = text.match(/\/post\/([0-9a-f-]{16,})/i);
    return match ? match[1] : null;
  }
}

/** The clean, un-referred job page for an id — what `destination_url` holds. */
export function micro1JobUrl(jobId) {
  const id = String(jobId || '').trim();
  return id ? `${MICRO1_PLATFORM.jobUrlBase}/${id}` : null;
}

/**
 * Candidate share links -> the one that provably pays this account.
 *
 * Stricter than Turing's picker, deliberately: a Micro1 post URL without a
 * `referralCode` opens the right job and pays nobody. "It's a link to the job" is not
 * the property that earns — carrying the tenant's code is.
 */
export function pickMicro1ReferralUrl(candidates = [], { host = MICRO1_JOB_HOST } = {}) {
  const target = String(host || '').toLowerCase();
  const scored = [];

  for (const value of (Array.isArray(candidates) ? candidates : []).map((v) => String(v || '').trim())) {
    if (!/^https?:\/\//i.test(value)) continue;
    let parsed;
    try { parsed = new URL(value); } catch { continue; }
    const hostname = parsed.hostname.toLowerCase();
    if (!(hostname === target || hostname.endsWith(`.${target}`))) continue;
    if (!micro1JobIdFromUrl(value)) continue;
    // The account code, not a campaign parameter, is what credits the tenant.
    const code = parsed.searchParams.get('referralCode') || parsed.searchParams.get('referral_code');
    if (!code) continue;
    scored.push({ value, score: 40 + (/utm_source=referral/i.test(value) ? 10 : 0) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.value || null;
}

/**
 * How many cards the listing currently shows — and whether it is still a skeleton.
 *
 * The first version reported a count the moment a `div.grid` with 3+ children existed,
 * which the *skeleton* grid satisfies: the run then read six placeholder cards and
 * captured nothing. A count is not readiness; a titled card is.
 */
export const MICRO1_LIST_COUNT_EXPR = `(() => {
  const grid = ${MICRO1_PLATFORM.gridProbe};
  const cards = grid ? Array.from(grid.children) : [];
  return JSON.stringify({
    ok: Boolean(grid),
    count: cards.length,
    // Skeletons are the site's own loading state (same tell as Turing's listing).
    pulse: document.querySelectorAll('.animate-pulse').length,
    // The listing's cards have an h2 title; skeletons do not.
    titled: cards.filter((card) => card.querySelector('h2')).length,
    url: String(location.href)
  });
})()`;


/**
 * Read every visible card.
 *
 * Structured on purpose: the card has an `h2` for the title and discrete nodes for
 * openings, skills and pay (verified in tmp_m1anatomy.json), so nothing here parses
 * prose. The full text is kept alongside as evidence when a field is missing.
 */
export const MICRO1_LIST_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const grid = ${MICRO1_PLATFORM.gridProbe};
  if (!grid) return JSON.stringify({ ok: false, reason: 'grid_not_found', url: String(location.href), items: [] });

  const items = Array.from(grid.children).map((card, index) => {
    const text = clean(card.innerText);
    const title = clean(card.querySelector('h2') ? card.querySelector('h2').innerText : '');
    const badges = Array.from(card.querySelectorAll('span, div'))
      .filter((el) => el.children.length === 0)
      .map((el) => clean(el.innerText))
      .filter((v) => /^(new|high demand|urgent|featured|posted|\\d+ openings?)$/i.test(v));

    const referButton = Array.from(card.querySelectorAll('button'))
      .map((b) => clean(b.innerText))
      .find((t) => /refer and earn/i.test(t)) || null;

    const skills = Array.from(card.querySelectorAll('div.flex.flex-wrap > div'))
      .map((el) => clean(el.innerText))
      .filter((v) => v && !/^\\+\\d+$/.test(v));

    const payText = (text.match(/pay:\\s*\\$[^]*?(?=\\s*refer and earn|$)/i) || [])[0] || null;

    return {
      index,
      title: title || null,
      text: text.slice(0, 500),
      openingsText: (text.match(/\\d+\\s+openings?/i) || [])[0] || null,
      payText: payText ? clean(payText) : null,
      referButton,
      skills,
      badges: Array.from(new Set(badges)).slice(0, 6)
    };
  });

  return JSON.stringify({ ok: true, count: items.length, url: String(location.href), items });
})()`;

/** `$250,000 - $450,000/year` -> {min, max, unit}. Hourly stays hourly. */
export function parseMicro1Pay(text) {
  const match = String(text || '').match(/\$\s*([\d,]+)\s*(?:-\s*\$?\s*([\d,]+))?\s*(?:\/\s*(hour|hr|year|yr|month|mo))?/i);
  if (!match) return { min: null, max: null, unit: null };
  const num = (v) => (v ? Number(String(v).replace(/,/g, '')) : null);
  return {
    min: num(match[1]),
    max: num(match[2]) ?? num(match[1]),
    unit: match[3] ? match[3].toLowerCase().replace('hr', 'hour').replace('yr', 'year').replace('mo', 'month') : null
  };
}

/** `Refer and earn $1,500` -> 1500. */
export function parseMicro1ReferralBonus(text) {
  const match = String(text || '').match(/refer\s*(?:and|&)\s*earn\s*\$\s*([\d,]+)/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

/** `10 Openings` -> 10. */
export function parseMicro1Openings(text) {
  const match = String(text || '').match(/(\d+)\s+openings?/i);
  return match ? Number(match[1]) : null;
}

/**
 * Which cards this run should actually click.
 *
 * Exists because of a hard external constraint: MoreLogin caps **starts per day**, and
 * burning a start to re-capture twelve roles that are already imported is a waste the
 * plan does not forgive. `onlyMissing` therefore skips cards whose offer already exists —
 * matched the same way the importer matches (tenant-scoped slug, then title) so the two
 * can never disagree about what "already imported" means.
 *
 * Pure: takes the listing rows and the tenant's existing offers.
 */
/**
 * Move the listing to its next page of cards (2026-11-03).
 *
 * The grid renders twelve cards; a run worth a MoreLogin start wants seventy. Three strategies,
 * in order of how explicit they are, and every one reports what it did so the caller can tell
 * "there is no next page" from "the click failed":
 *
 *   1. a real pager button (`Next`, `›`, `aria-label="next page"`);
 *   2. a "load more" control, which appends instead of navigating;
 *   3. the bottom of the document, for a grid that grows on scroll.
 */
export const MICRO1_ADVANCE_EXPR = `(() => {
  const text = (el) => (el && el.textContent ? el.textContent : '').trim().toLowerCase();
  const label = (el) => (el && el.getAttribute ? (el.getAttribute('aria-label') || '') : '').toLowerCase();
  const isDisabled = (el) => Boolean(el && el.disabled) || (el && el.getAttribute && el.getAttribute('aria-disabled') === 'true');
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));

  const pager = controls.find((el) => !isDisabled(el) && (
    /^(next|next page|›|»|→)$/.test(text(el)) || /next/.test(label(el))
  ));
  if (pager) { pager.click(); return { clicked: true, how: 'next' }; }

  const more = controls.find((el) => !isDisabled(el) && /(load|show)\\s+more/.test(text(el)));
  if (more) { more.click(); return { clicked: true, how: 'load_more' }; }

  const before = document.querySelectorAll('div.grid > div').length;
  window.scrollTo(0, document.body.scrollHeight);
  return { clicked: false, scrolled: before > 0, before };
})()`;

/**
 * Accumulate cards across pages without duplicates.
 *
 * A card carries no id until it is clicked — the share link is what reveals the job uuid — so the
 * only stable key at listing time is the title. Two pages merge on the slugified title, and a card
 * that appears on both is kept once: capturing it twice would spend two clicks on one role and
 * attach the same link to two offers.
 */
export function mergeMicro1Pages(existing = [], fresh = []) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map((item) => slugifyTitle(item?.title || '')).filter(Boolean));
  let added = 0;
  for (const item of Array.isArray(fresh) ? fresh : []) {
    const key = slugifyTitle(item?.title || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    added += 1;
  }
  return { items: out, added };
}

export function planMicro1Window(items = [], {
  existingOffers = [],
  tenantSlug = '',
  sourceSlug = MICRO1_PLATFORM.source,
  skip = 0,
  limit = 12,
  onlyMissing = false
} = {}) {
  const offers = (Array.isArray(existingOffers) ? existingOffers : []).filter(Boolean);
  const takenSlugs = new Set(offers.map((offer) => String(offer.slug || '').toLowerCase()).filter(Boolean));
  const takenTitles = new Set(offers.map((offer) => slugifyTitle(offer.title)).filter(Boolean));

  const rows = (Array.isArray(items) ? items : []).filter(Boolean).map((item) => {
    const slug = offerSlugFor({ tenantSlug, sourceSlug, title: item.title });
    const alreadyImported = takenSlugs.has(slug) || takenTitles.has(slugifyTitle(item.title));
    return { ...item, alreadyImported };
  });

  const pending = onlyMissing ? rows.filter((row) => !row.alreadyImported) : rows;
  return {
    considered: rows.length,
    alreadyImported: rows.filter((row) => row.alreadyImported).length,
    window: pending.slice(Math.max(0, skip), Math.max(0, skip) + Math.max(0, limit))
  };
}

/**
 * The offer row the portal would create, as a draft.
 *
 * `destination_url` is the *clean* job page: a reader who is not the referred candidate
 * should not be handed the tenant's code. `referral_url` is the code-carrying link and
 * is the only one that earns.
 */
export function toMicro1OfferDraft(role = {}, { tenantSlug = null, referralUrl = null } = {}) {
  if (!role || !role.title) return null;
  if (!tenantSlug) throw new Error('toMicro1OfferDraft needs a tenant slug — offers are tenant-scoped');

  return {
    title: role.title,
    offer_type: 'job',
    status: 'draft',
    description: role.description || role.summary || null,
    // A yearly salary is not a per-offer price; hourly/daily rates are.
    compensation_max: role.pay && role.pay.unit !== 'year' ? (role.pay.max ?? null) : null,
    compensation_currency: 'USD',
    destination_url: micro1JobUrl(role.jobId),
    referral_url: referralUrl || null,
    cta_label: 'Apply through this link',
    source_slug: MICRO1_PLATFORM.source,
    external_id: role.jobId ? `micro1:${role.jobId}` : null,
    tenant_slug: tenantSlug,
    priority: role.priority === true
  };
}

/**
 * Close whatever the previous click opened.
 *
 * The share control is a popover rendered *inside the grid*, so leaving it open shifts
 * the card positions and the next click lands on the wrong role. Verified live: card 1
 * and card 2 then produced dialog buttons ("Close / Copy") instead of a refer button, and
 * one link was attributed to the wrong job.
 */
export const MICRO1_CLOSE_DIALOGS_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  let closed = 0;
  const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter((el) => /^(close|dismiss|\\u00d7|x)$/i.test(clean(el.innerText)) || /close/i.test(el.getAttribute('aria-label') || ''));
  for (const el of candidates.slice(0, 3)) {
    try { el.click(); closed += 1; } catch {}
  }
  // Escape closes most popovers even when the close control is an icon with no label.
  if (!closed) {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } catch {}
  }
  return JSON.stringify({ ok: true, closed });
})()`;

/**
 * Click "Refer and earn $X" on the card whose title is `title`.
 *
 * **By title, not by index.** An index was wrong the moment a popover opened inside the
 * grid: the positions moved and the run captured one role's link onto another role. The
 * title is the only stable handle the card offers.
 */
export function micro1OpenReferralExpr(title) {
  const wanted = String(title ?? '');
  const asIndex = Number.isFinite(Number(wanted)) && String(Number(wanted)) === wanted.trim();
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const grid = ${MICRO1_PLATFORM.gridProbe};
  if (!grid) return JSON.stringify({ ok: false, reason: 'grid_not_found', url: String(location.href) });

  const cards = Array.from(grid.children);
  const titleOf = (card) => {
    const h2 = card.querySelector('h2');
    return clean(h2 ? h2.innerText : '');
  };
  const wanted = ${JSON.stringify(wanted)};
  const wantedIndex = ${asIndex ? Number(wanted) : 'null'};

  const card = wantedIndex !== null
    ? cards[wantedIndex] || null
    : cards.find((c) => titleOf(c) === wanted)
      || cards.find((c) => titleOf(c).toLowerCase() === wanted.toLowerCase())
      || cards.find((c) => titleOf(c).toLowerCase().includes(wanted.toLowerCase()))
      || null;

  if (!card) {
    return JSON.stringify({
      ok: false,
      reason: 'card_not_found',
      titles: cards.map(titleOf).filter(Boolean).slice(0, 12),
      url: String(location.href)
    });
  }

  const buttons = Array.from(card.querySelectorAll('button, [role="button"]'));
  const target = buttons.find((b) => /${MICRO1_PLATFORM.referButtonPattern}/i.test(clean(b.innerText)))
    || buttons.find((b) => /refer/i.test(clean(b.innerText)));
  if (!target) {
    return JSON.stringify({
      ok: false,
      reason: 'no_refer_button',
      title: titleOf(card),
      buttons: buttons.map((b) => clean(b.innerText)).filter(Boolean).slice(0, 8),
      url: String(location.href)
    });
  }
  target.scrollIntoView({ block: 'center' });
  target.click();
  return JSON.stringify({
    ok: true,
    clicked: clean(target.innerText).slice(0, 60),
    title: titleOf(card),
    index: cards.indexOf(card),
    url: String(location.href)
  });
})()`;
}


/**
 * After the click: find the share link.
 *
 * Filtered, not merely collected — only a `jobs.micro1.ai/post/<id>` URL carrying a
 * `referralCode` counts. A bare post URL sends the candidate to the right job and pays
 * nobody, which is the exact failure this subsystem exists to prevent.
 */
export const MICRO1_READ_REFERRAL_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const found = new Set();

  for (const el of document.querySelectorAll('input, textarea, code')) {
    found.add(clean(el.value || el.textContent));
  }
  for (const el of document.querySelectorAll('[data-clipboard-text], [data-href], [data-url]')) {
    found.add(clean(el.getAttribute('data-clipboard-text') || el.getAttribute('data-href') || el.getAttribute('data-url')));
  }
  const text = clean(document.body ? document.body.innerText : '');
  for (const match of text.match(/https?:\\/\\/[^\\s"']+/g) || []) found.add(match);

  const candidates = Array.from(found).filter((v) => /^https?:\\/\\//i.test(v) && /micro1\\.ai/i.test(v));
  return JSON.stringify({ ok: true, candidates: candidates.slice(0, 20) });
})()`;

/**
 * Read the job body off `jobs.micro1.ai/post/<id>`.
 *
 * The page is client-rendered (48 KB of HTML, 57 characters of text, no JSON-LD), so
 * this runs after the SPA has painted. Rather than pin a generated class name it scores
 * candidate blocks by text length and takes the longest readable one that is not site
 * chrome: a redesign changes the classes, not the fact that the job is the biggest thing
 * on the page.
 */
export const MICRO1_DETAIL_CONTENT_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v)
    .replace(/\\u00a0/g, ' ')
    .replace(/[ \\t]+/g, ' ')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
  const chrome = /^(accept all|sign in|log in|cookie|privacy policy|terms of service|all rights reserved|apply now|share|refer and earn)/i;

  const blocks = [];
  for (const el of document.querySelectorAll('main div, article, section div, div[class*="prose"], div[class*="description"], div[class*="content"]')) {
    const text = clean(el.innerText);
    if (text.length < 300) continue;
    if (chrome.test(text)) continue;
    // Skip layout wrappers whose text is just their first child repeated, or every
    // paragraph would appear twice at increasing sizes.
    const first = clean(el.firstElementChild ? el.firstElementChild.innerText : '');
    const duplicated = first.length > 0 && first.length > text.length * 0.9;
    if (duplicated) continue;
    blocks.push(text);
  }

  blocks.sort((a, b) => b.length - a.length);
  const best = blocks[0] || null;

  return JSON.stringify({
    ok: Boolean(best),
    url: String(location.href),
    title: clean(document.title),
    chars: best ? best.length : 0,
    content: best ? best.slice(0, 20000) : null
  });
})()`;

/**
 * A listing row -> a role.
 *
 * `jobId` arrives later, with the share link: the card carries no id of its own, which
 * is why an import can only be completed after the referral click.
 */
export function normalizeMicro1Item(raw = {}) {
  const text = String(raw.text || '').replace(/\s+/g, ' ').trim();
  const title = String(raw.title || '').trim();
  if (!title && !text) return null;

  const pay = parseMicro1Pay(raw.payText || text);
  return {
    index: Number.isFinite(Number(raw.index)) ? Number(raw.index) : null,
    title: title || null,
    jobId: raw.jobId || null,
    externalId: raw.jobId ? `micro1:${raw.jobId}` : null,
    summary: text ? text.slice(0, 400) : null,
    text,
    openings: parseMicro1Openings(raw.openingsText || text),
    pay,
    rate: pay.max ? `$${pay.max}${pay.unit ? `/${pay.unit}` : ''}` : null,
    skills: Array.isArray(raw.skills) ? raw.skills.filter(Boolean).slice(0, 12) : [],
    referralBonus: parseMicro1ReferralBonus(raw.referButton || text),
    priority: /high demand/i.test(`${raw.badges || ''} ${text}`),
    // The listing is the only URL we have until a share link is read.
    url: null
  };
}

