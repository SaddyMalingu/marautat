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

const type = (offer) => {
  const t = String((offer && offer.offer_type) || 'job').toLowerCase();
  return LABEL[t] ? t : 'job';
};

/** Where the button goes: the offer's own URL if it has one, else the tracker. */
export function ctaTarget(offer) {
  const direct = offer && (offer.destination_url || offer.referral_url || offer.application_url);
  if (direct && /^https?:\/\//i.test(String(direct))) return String(direct);
  if (offer && offer.id) return '/ai-jobs/apply/' + offer.id;
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
    // No destination and no offer id: a button here is a dead end. Offer the
    // one thing that still works — a way to reach the business.
    return '<div class="cta"><h2>' + heading + '</h2>' +
      '<p>' + esc('This offer has no link configured yet, so send a message and the business will reply with the details.') + '</p>' +
      (facts ? '<p><strong>' + esc(facts) + '</strong></p>' : '') + '</div>';
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
