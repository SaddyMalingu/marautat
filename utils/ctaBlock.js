/**
 * The block at the bottom of every blog page.
 *
 * Until 2026-10-29 every page on the site ended with the same three lines:
 *
 *     Ready to Start? / This opportunity is available now. / [Apply Now]
 *
 * on a job, a product, a service and a course alike — and it linked to
 * /ai-jobs/apply/<id> whether or not the offer had a destination configured,
 * which 404s with {"error":"No destination configured for this offer"} when a
 * tenant has not filled one in. The page did the persuading and then handed the
 * reader a generic button.
 *
 * This module makes the block specific: the offer's own name, its figure, who
 * it suits, one line on what happens after the click, and the readiness list
 * that the article was asked to answer. Destination resolution prefers the
 * offer's own URL and falls back to the tracked redirect.
 *
 * Pure string assembly — no IO, so the template can be tested offline.
 */
import { readinessCard } from './conversionPlaybook.js';

const LABEL = {
  job: 'Apply now',
  product: 'Order now',
  service: 'Get a quote',
  brand: 'Get in touch',
  affiliate: 'See the offer',
  course: 'Enrol today',
};

const AFTER = {
  job: 'The application takes about twenty minutes, then a short assessment.',
  product: 'You get a confirmation with the total, then a dispatch note.',
  service: 'You get a written quote against the scope you send.',
  brand: 'You get a reply the same working day.',
  affiliate: 'You go to the provider page with the current price.',
  course: 'You get the schedule and the first session.',
};

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The block that used to close every page. No code path produces these strings
// any more, so a stored page that still carries one was written by the old
// template and must be rebuilt — `restoreFromDB()` uses this to migrate the
// existing corpus on boot instead of leaving 300 pages on the generic button.
const LEGACY_FOOTER = /Ready to Start\?|This (?:opportunity|offer) is available now\./;

/** True when a stored page still carries the pre-2026-10-29 closing block. */
export function isStalePage(html) {
  return LEGACY_FOOTER.test(String(html || ''));
}

// Two more ways a page can be unable to convert, found by counting the live
// corpus on 2026-10-29: 96 pages had no closing block at all (the migration only
// knew about the *old* block, so it never looked at them), and 21 carried a block
// whose only content was "send a message" with nothing to press.
const CTA_CONTAINER = /class="cta(?:\s[^"]*)?"/;
const CTA_BUTTON = /class="cta-btn(?:\s[^"]*)?"/;
const ARTICLE = /<article>/;

export function hasClosingBlock(html) {
  return CTA_CONTAINER.test(String(html || ''));
}

export function hasCtaButton(html) {
  return CTA_BUTTON.test(String(html || ''));
}

/**
 * A stored page that cannot give the reader anything to do.
 *
 * Requires an `<article>` first: a page with no body has nothing to rebuild from
 * and must not be flagged, or every boot would retry it forever.
 *
 * This has to agree with what `ctaBlock()` produces, or the rebuild never
 * converges — a page that is rebuilt into a block this function still calls
 * missing would be rewritten on every single boot. Every branch of ctaBlock()
 * therefore emits at least one `.cta-btn`, including the one for an offer with no
 * destination configured (which links to /ai-jobs instead of nowhere).
 */
export function needsClosingBlock(html) {
  const s = String(html || '');
  if (!ARTICLE.test(s)) return false;
  return !hasClosingBlock(s) || !hasCtaButton(s);
}

// The honest sentence a no-destination offer gets. Live 2026-10-31: 56 of 434
// pages carried it twice, once above the article and once below, because the
// fallback branch returned the full block before checking for the compact
// variant. Fixed in ctaBlock(); this lets the boot restore repair the pages that
// were written while the bug was live.
const FALLBACK_NOTE = /This offer has no link configured yet/g;

/** True when the same "nothing configured" note is printed more than once. */
export function repeatsFallbackNote(html) {
  return (String(html || '').match(FALLBACK_NOTE) || []).length > 1;
}

// A CTA that leaves for the provider without passing through this server: the
// click converts, and nobody on this side can count it. 378 of the 434 live pages
// were in exactly this state on 2026-10-31 — which is why "the blog works" was a
// belief rather than a number.
//
// Rebuilding writes /go/<id> instead: same destination, one recorded hop in front
// of it. Only the button is matched, so an external link in the article body does
// not trigger a rebuild.
const UNMETERED_BUTTON = /class="cta-btn[^"]*"[^>]*href="https?:\/\//i;

export function usesUnmeteredLink(html) {
  return UNMETERED_BUTTON.test(String(html || ''));
}

/**
 * Should the boot restore rebuild this stored page, and why?
 *
 * This is the *whole* decision `restoreFromDB()` makes, in one place, because
 * three callers need the same answer and a second copy would drift: the boot
 * restore (rebuild and persist), `repair_blog_html.js` (list what it would
 * rebuild) and `test_boot_convergence.mjs` (prove the second boot rebuilds
 * nothing). The test cannot import the restore loop — it needs a database — but
 * it can import this, so what it proves is the code that actually runs.
 *
 * `reason` is what the boot log prints after the slug, so an operator reading
 * `[DB] Rebuilt <slug> (no closing block)` knows which rule fired without
 * cross-referencing the audit.
 *
 * @param {{html: string, auditOk: boolean, issues?: string[], mayRebuildFooter?: boolean}} state
 * @returns {{rebuild: boolean, reason: string}}
 */
export function pageNeedsRebuild(state) {
  const s = String((state && state.html) || '');
  const auditOk = !!(state && state.auditOk);
  // Defaults to on: the kill switch is an operator escape hatch set to the
  // literal string 'off', not an opt-in.
  const mayRebuildFooter = !(state && state.mayRebuildFooter === false);
  const issues = (state && state.issues) || [];

  // A page that fails the readability audit is rebuilt whatever the switch says;
  // the switch only protects pages that pass it.
  if (!auditOk) {
    return { rebuild: true, reason: issues.length ? issues.join(', ') : 'failed the audit' };
  }
  if (!mayRebuildFooter) return { rebuild: false, reason: 'footer rebuild disabled' };
  if (isStalePage(s)) return { rebuild: true, reason: 'old closing block' };
  if (needsClosingBlock(s)) return { rebuild: true, reason: 'no closing block' };
  if (repeatsFallbackNote(s)) return { rebuild: true, reason: 'repeated fallback note' };
  if (usesUnmeteredLink(s)) return { rebuild: true, reason: 'unmetered provider link' };
  return { rebuild: false, reason: 'current' };
}

const type = (offer) => {
  const t = String((offer && offer.offer_type) || 'job').toLowerCase();
  return LABEL[t] ? t : 'job';
};

/**
 * Where the button goes.
 *
 * Any offer with an id goes through this server first, at /go/<id>: the click is
 * recorded against the page that earned it, then the reader is 302'd to the
 * offer's own URL **unchanged** — same URL, same affiliate parameters — so
 * attribution is identical to linking the provider directly, and the only
 * difference is that the click stops being invisible.
 *
 * On 2026-10-31, 378 of 434 live pages linked the provider directly and this
 * server counted none of them. That is what this ordering fixes: the tracked path
 * is preferred, not the fallback.
 *
 * An offer with no id cannot be counted, so it keeps the raw URL.
 */
export function ctaTarget(offer) {
  if (offer && offer.id) return '/go/' + offer.id;
  const direct = offer && (offer.destination_url || offer.referral_url || offer.application_url);
  if (direct && /^https?:\/\//i.test(String(direct))) return String(direct);
  return '';
}

/** "Apply for ML Engineer" / "Order the KES 1,500 Studio Session" / … */
export function ctaHeading(offer) {
  const t = type(offer);
  const title = offer && offer.title ? String(offer.title).trim() : '';
  if (!title) {
    return t === 'job' ? 'Apply for this role' : t === 'product' ? 'Order this item'
      : t === 'course' ? 'Enrol on this course' : t === 'affiliate' ? 'See this offer'
      : t === 'brand' ? 'Talk to us' : 'Get this priced';
  }
  switch (t) {
    case 'job': return 'Apply for ' + title;
    case 'product': return 'Order ' + title;
    case 'service': return 'Get ' + title + ' priced';
    case 'course': return 'Enrol on ' + title;
    case 'affiliate': return 'See the ' + title + ' offer';
    default: return 'Talk to ' + title;
  }
}

/** The figure and the place, when the offer has them. Never invented. */
export function ctaFacts(offer) {
  const bits = [];
  const n = offer && offer.compensation_max;
  const num = n == null || n === '' ? NaN : Number(n);
  if (isFinite(num)) {
    const cur = (offer.compensation_currency || 'KES') + ' ';
    bits.push(type(offer) === 'job' ? cur + num.toLocaleString('en-KE') + ' per hour' : cur + num.toLocaleString('en-KE'));
  }
  const place = offer && offer.location_text ? String(offer.location_text).trim() : '';
  if (place) bits.push(place);
  return bits.join(' · ');
}

export function ctaLabel(offer) {
  return (offer && offer.cta_label ? String(offer.cta_label) : '') || LABEL[type(offer)];
}

/**
 * The full closing block: heading, one line of substance, the readiness list,
 * and the button. `variant: 'top'` is the compact version that sits above the
 * article, so a reader who never scrolls still has a way out that converts.
 */
export function ctaBlock(offer, opts) {
  const options = opts || {};
  const t = type(offer);
  const href = ctaTarget(offer);
  const facts = ctaFacts(offer);
  const heading = esc(options.heading || ctaHeading(offer));
  const after = esc(options.after || AFTER[t]);

  if (!href) {
    // No destination and no offer id. The sentence is honest, but a page with
    // nothing to press is still a dead end — 21 live pages were in exactly this
    // state on 2026-10-29. Give the reader somewhere to go that is not a lie.
    const alt = '<a class="cta-btn cta-btn--alt" href="/ai-jobs">Browse other opportunities</a>';
    // The compact variant has to stay compact here too. Returning the full block
    // early put an <h2> and the same sentence above the article *and* below it —
    // visible on live pages the first time the no-destination branch was used.
    if (options.variant === 'top') {
      return '<div class="cta cta-top"><p><strong>' + heading + '</strong>' +
        (facts ? ' — ' + esc(facts) : '') + '</p>' + alt + '</div>';
    }
    return '<div class="cta"><h2>' + heading + '</h2>' +
      '<p>' + esc('This offer has no link configured yet, so send a message and the business will reply with the details.') + '</p>' +
      (facts ? '<p><strong>' + esc(facts) + '</strong></p>' : '') +
      alt + '</div>';
  }

  const button = '<a class="cta-btn" href="' + esc(href) + '"' +
    (href.startsWith('http') ? ' rel="noopener"' : '') + '>' + esc(ctaLabel(offer)) + '</a>';

  if (options.variant === 'top') {
    return '<div class="cta cta-top"><p><strong>' + heading + '</strong>' +
      (facts ? ' — ' + esc(facts) : '') + '</p>' + button + '</div>';
  }

  return '<div class="cta"><h2>' + heading + '</h2>' +
    (facts ? '<p class="cta-facts">' + esc(facts) + '</p>' : '') +
    '<p>' + after + '</p>' +
    readinessCard(offer) +
    button + '</div>';
}
