/**
 * Per-role referral capture — Turing (2026-10-31)
 *
 * Turing mints a referral link **per job**, not per account:
 *   - the card's dollar badge opens it, or
 *   - the expanded card shows a "referral bonus" link just below "Apply Now".
 *
 * So 78 imported offers can all be published and still earn nothing, which is
 * exactly the state the tenant was in: 2 of 78 linked. This module reads that
 * link for one role at a time.
 *
 * Design constraints, in order of importance:
 *
 *   1. **Never guess.** If the modal does not yield a link that provably belongs
 *      to the tenant's referral programme, capture nothing and say so. A wrong
 *      link pays the tenant for the wrong job, and the candidate lands somewhere
 *      that does not match the page they just read.
 *   2. **Never navigate away silently.** The card is a JS click target, so a click
 *      can leave the listing. Every expression returns the page URL it ran on, and
 *      the caller re-checks it instead of assuming.
 *   3. **Pure where possible.** Parsing and planning are plain functions, so a
 *      Turing redesign fails a test rather than writing bad rows to production.
 *
 * The clicking itself lives in scripts/browser_actor_referrals.mjs, behind its own
 * flag, because it is a UI action on a logged-in account rather than a read.
 */
import { TURING_PLATFORM, roleKey } from './turing.js';
import { isReferralUrlForHost, slugifyTitle } from '../referrals.js';

/** Referral links live on the same host as the listing (`work.turing.com`). */
export const TURING_REFERRAL_HOST = 'turing.com';

/**
 * Paced on purpose: expanding a card and opening a modal twice a second looks like
 * a scraper to a marketplace the tenant's own account depends on.
 */
export const REFERRAL_PACE_MS = 1_400;

/** How long to wait for the modal to render before calling it unreadable. */
export const REFERRAL_MODAL_TIMEOUT_MS = 6_000;

const LIST = JSON.stringify(TURING_PLATFORM.listSelector);


/**
 * Open the referral view for one card.
 *
 * Two documented routes, tried in order of confidence:
 *   a) the "referral bonus" link/button revealed inside the card
 *   b) the dollar badge in the card meta, which the tenant confirmed also opens it
 *
 * Returns what it clicked, so a failure names the affordance instead of leaving
 * the caller guessing whether the page changed.
 */
export function turingOpenReferralExpr(index) {
  const i = Number(index);
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const container = document.querySelector(${LIST});
  if (!container) return JSON.stringify({ ok: false, reason: 'listing_not_found', url: String(location.href) });
  const cards = Array.from(container.querySelectorAll(':scope > *'));
  const card = cards[${i}];
  if (!card) return JSON.stringify({ ok: false, reason: 'card_not_found', url: String(location.href) });

  const clickable = Array.from(card.querySelectorAll('button, a, [role="button"]'));
  const bonus = clickable.find((el) => /referral\\s*bonus|refer\\s*(&|and)\\s*earn/i.test(clean(el.innerText)));
  if (bonus) {
    bonus.scrollIntoView({ block: 'center' });
    bonus.click();
    return JSON.stringify({ ok: true, clicked: true, by: 'referral_link', text: clean(bonus.innerText).slice(0, 80), url: String(location.href) });
  }

  // Nothing visible yet: expand the card by opening its details affordance.
  const details = clickable.find((el) => /view|detail|expand|show more|read more/i.test(clean(el.innerText)));
  if (details) {
    details.scrollIntoView({ block: 'center' });
    details.click();
    return JSON.stringify({ ok: true, clicked: true, by: 'details', text: clean(details.innerText).slice(0, 80), url: String(location.href) });
  }

  // Last resort, and the route the tenant named first: the rate badge.
  const meta = card.querySelector('div.mb-3');
  const amount = meta ? Array.from(meta.querySelectorAll('button, a, span, div'))
    .find((el) => /^\\s*\\$|\\/\\s*(hr|hour)/i.test(clean(el.innerText))) : null;
  if (amount) {
    amount.scrollIntoView({ block: 'center' });
    amount.click();
    return JSON.stringify({ ok: true, clicked: true, by: 'amount', text: clean(amount.innerText).slice(0, 80), url: String(location.href) });
  }

  return JSON.stringify({ ok: false, reason: 'no_referral_affordance', url: String(location.href) });
})()`;
}

/**
 * Collect every URL-looking value inside the open modal.
 *
 * Scoped to the dialog when one exists: scanning the whole document would also
 * pick up the nav's own "Refer & Earn" dashboard link, which is not the per-job
 * link and would be the single most damaging false positive here.
 */
export const TURING_MODAL_CANDIDATES_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]'));
  const scope = dialogs.length ? dialogs[dialogs.length - 1] : null;
  const root = scope || document.body;
  const found = new Set();

  for (const input of root.querySelectorAll('input, textarea')) found.add(clean(input.value));
  for (const el of root.querySelectorAll('[data-clipboard-text], [data-href], [data-url]')) {
    found.add(clean(el.getAttribute('data-clipboard-text') || el.getAttribute('data-href') || el.getAttribute('data-url')));
  }
  for (const a of root.querySelectorAll('a[href]')) found.add(String(a.href || ''));
  const text = clean(root.innerText);
  for (const match of text.match(/https?:\\/\\/[^\\s"']+/g) || []) found.add(match);

  const candidates = Array.from(found).filter((value) => /^https?:\\/\\//i.test(value));
  return JSON.stringify({
    ok: true,
    inDialog: Boolean(scope),
    url: String(location.href),
    candidates: candidates.slice(0, 40),
    text: text.slice(0, 400)
  });
})()`;

/** Close whatever the click opened, so the next card starts from a clean listing. */
export const TURING_CLOSE_MODAL_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]'));
  if (!dialogs.length) return JSON.stringify({ ok: true, closed: false, reason: 'no_dialog' });
  const scope = dialogs[dialogs.length - 1];
  const closer = Array.from(scope.querySelectorAll('button, [role="button"]'))
    .find((el) => /^(close|dismiss|cancel|got it|x)$/i.test(clean(el.innerText)) || /close/i.test(el.getAttribute('aria-label') || ''));
  if (closer) {
    closer.click();
    return JSON.stringify({ ok: true, closed: true, by: 'button', text: clean(closer.innerText).slice(0, 40) });
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  return JSON.stringify({ ok: true, closed: true, by: 'escape' });
})()`;

/**
 * Pick the referral link for ONE role.
 *
 * This is deliberately NOT `pickReferralUrl` from turing.js. That picker answers
 * "where is the tenant's Refer & Earn page?" and therefore *penalises* `/jobs`
 * URLs — which is precisely where a per-job link lives
 * (`work.turing.com/jobs?ref=6f0c`). Reusing it captured nothing, silently.
 *
 * The role-level rule is the token, not the path: a link must carry a referral
 * token to be considered at all:
 *
 *     ?ref=  ?referral=  ?code=  ?invite=  /r/  referr  invite  affiliate
 *
 * Dashboard, login and settings pages are rejected even when they contain the word
 * "referral" (`/dashboard/job_referral` is the tenant's dashboard, not a job link).
 * An optional `title` boosts a URL whose path already names the role, which is the
 * strongest available signal that the link belongs to this job.
 */
export function pickRoleReferralUrl(candidates = [], { host = TURING_REFERRAL_HOST, title = '' } = {}) {
  const roleSlug = title ? roleKey(title) : '';
  const urls = (Array.isArray(candidates) ? candidates : [])
    .map((value) => String(value || '').trim())
    .filter((value) => /^https?:\/\//i.test(value))
    .filter((value) => isReferralUrlForHost(value, host));

  const scored = urls.map((value) => {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return { value, score: -100 };
    }
    const path = `${parsed.pathname}${parsed.search}`;
    let score = 0;

    if (/[?&]ref=/i.test(path)) score += 50;
    if (/[?&](referral|code|invite)=/i.test(path)) score += 40;
    if (/\/r\//i.test(parsed.pathname)) score += 30;
    if (/referr|invite|affiliate/i.test(path)) score += 25;
    if (roleSlug && parsed.pathname.toLowerCase().includes(roleSlug.slice(0, 24))) score += 30;

    // Never a per-job link, whatever else it contains.
    if (/\/(dashboard|login|signup|welcome|settings|account)/i.test(parsed.pathname)) score -= 80;
    if (parsed.pathname === '/' || parsed.pathname === '') score -= 40;

    return { value, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  return best && best.score > 0 ? best.value : null;
}

/**
 * Turn one modal reading into a capture record.
 *
 * `externalId` is derived with the SAME `roleKey` the importer used, so a captured
 * link can only ever land on the offer that created it. Deriving it twice in two
 * places is how a link ends up on the wrong role.
 *
 * A modal with URLs but no confident pick is reported as `no_confident_pick` and
 * carries its candidates: that is a human decision, not an agent's.
 */
export function normalizeReferralCapture({
  index = null,
  title = '',
  candidates = [],
  clickedBy = null,
  pageUrl = null,
  host = TURING_REFERRAL_HOST
} = {}) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const clean = String(title || '').trim();
  const referralUrl = pickRoleReferralUrl(list, { host, title: clean });

  return {
    index,
    title: clean,
    externalId: clean ? `turing:${roleKey(clean)}` : null,
    clickedBy: clickedBy || null,
    pageUrl: pageUrl || null,
    referralUrl: referralUrl || null,
    // Kept so a human can see what the picker rejected, instead of trusting a blank.
    candidates: list.slice(0, 10),
    reason: referralUrl ? 'picked' : list.length ? 'no_confident_pick' : 'no_candidates'
  };
}

/**
 * Decide what to write for a batch of captures. Pure: no DB, no network.
 *
 * The rules matter more than the code:
 *   - an offer that already has a link is NEVER overwritten — the tenant pasted it
 *     deliberately, and this agent is not entitled to replace that decision
 *   - a link that is not on the marketplace's host is refused
 *   - the same link may not be attached to two offers; one of them is wrong
 */
export function planReferralBackfill({ offers = [], captures = [], host = TURING_REFERRAL_HOST } = {}) {
  const rows = (Array.isArray(offers) ? offers : []).filter(Boolean);
  const byExternal = new Map();
  const byTitle = new Map();
  for (const offer of rows) {
    const external = String(offer.external_id || '').trim();
    if (external && !byExternal.has(external)) byExternal.set(external, offer);
    const key = slugifyTitle(offer.title || offer.slug || '');
    if (key && !byTitle.has(key)) byTitle.set(key, offer);
  }

  const updates = [];
  const skipped = [];
  const conflicts = [];
  const usedLinks = new Map();
  const assigned = new Map();

  for (const capture of Array.isArray(captures) ? captures : []) {
    const label = String(capture?.title || capture?.externalId || '').trim() || '(unnamed)';
    const link = String(capture?.referralUrl || '').trim();

    if (!link) {
      skipped.push({ title: label, reason: capture?.reason || 'no_link_captured' });
      continue;
    }
    if (!isReferralUrlForHost(link, host)) {
      skipped.push({ title: label, reason: 'wrong_host' });
      continue;
    }

    const wantedExternal = String(capture?.externalId || '').trim();
    const offer = (wantedExternal ? byExternal.get(wantedExternal) : null) ||
      byTitle.get(slugifyTitle(label)) ||
      null;

    if (!offer) {
      skipped.push({ title: label, reason: 'offer_not_found' });
      continue;
    }

    const existing = String(offer.referral_url || '').trim();
    const offerKey = offer.id || offer.external_id || offer.title || label;
    if (assigned.has(offerKey)) {
      // Two captures resolved to one offer: a UI slip, not data. Never queue twice.
      conflicts.push({ id: offer.id || null, title: offer.title || label, existing: assigned.get(offerKey), captured: link, reason: 'offer_already_assigned' });
      continue;
    }
    if (existing && existing === link) {
      skipped.push({ title: label, reason: 'already_linked' });
      continue;
    }
    if (existing) {
      conflicts.push({ id: offer.id || null, title: offer.title || label, existing, captured: link, reason: 'already_has_a_different_link' });
      continue;
    }
    if (usedLinks.has(link)) {
      conflicts.push({ id: offer.id || null, title: offer.title || label, existing: usedLinks.get(link), captured: link, reason: 'duplicate_link' });
      continue;
    }

    usedLinks.set(link, offer.title || label);
    assigned.set(offerKey, link);
    updates.push({
      id: offer.id || null,
      external_id: offer.external_id || null,
      title: offer.title || label,
      referral_url: link
    });
  }

  return { updates, skipped, conflicts };
}

/** One line a human can act on, for logs and for the capture file. */
export function referralCaptureHeadline({ updates = [], skipped = [], conflicts = [] } = {}) {
  const parts = [`${updates.length} link${updates.length === 1 ? '' : 's'} ready`];
  if (conflicts.length) parts.push(`${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}`);
  if (skipped.length) parts.push(`${skipped.length} not captured`);
  return parts.join(', ');
}



/**
 * Read one card without touching it: title, whether a referral affordance is
 * visible, and what it is called. Read-only, so it is safe to call on every card
 * before deciding to click anything.
 */
export function turingCardProbeExpr(index) {
  const i = Number(index);
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const container = document.querySelector(${LIST});
  if (!container) return JSON.stringify({ ok: false, reason: 'listing_not_found', url: String(location.href) });
  const cards = Array.from(container.querySelectorAll(':scope > *'));
  const card = cards[${i}];
  if (!card) return JSON.stringify({ ok: false, reason: 'card_not_found', count: cards.length, url: String(location.href) });
  const title = clean((card.querySelector('h3') || {}).innerText).slice(0, 200);
  const text = clean(card.innerText);
  const buttons = Array.from(card.querySelectorAll('button, a'))
    .map((el) => clean(el.innerText)).filter(Boolean).slice(0, 12);
  return JSON.stringify({
    ok: true,
    index: ${i},
    url: String(location.href),
    title,
    count: cards.length,
    hasBonus: /referral\\s*bonus|refer\\s*(&|and)\\s*earn/i.test(text),
    buttons
  });
})()`;
}
