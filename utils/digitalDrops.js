/**
 * Digital Drops — the rules for selling a digital product without a human.
 *
 * Why this module exists (2026-11-10). The repo can already write an SEO page for
 * an offer of type `course` or `product` (`utils/conversionPlaybook.js`,
 * `utils/ctaBlock.js`), take an M-Pesa prompt (`initiateStkPush`) and message the
 * buyer on WhatsApp (`utils/messenger.js`). What it could not do is hand over the
 * thing that was bought: every CTA pointed at a human, a form, or another site.
 *
 * So a "digital product" sale stopped at the payment. This module is the missing
 * half: a priced catalogue, an order state machine, a signed entitlement token,
 * the delivery message, and the revenue arithmetic that says whether the stream
 * is worth keeping.
 *
 * Design rules, all of them forced by what this repo already survived:
 *
 *   1. The amount is computed here, never read from the request body. A public
 *      checkout that trusts `amount` is someone else's price list.
 *   2. Payment -> delivery is idempotent. M-Pesa retries callbacks, and buyers
 *      double-tap. `orderTransition()` returns null for a repeated event so the
 *      caller can say "already done" instead of sending a second download link.
 *   3. The access link is signed, expiring and cohort-free: it names one order and
 *      one product, so a forwarded WhatsApp message cannot unlock the catalogue.
 *   4. No model calls and no IO. Every function here is testable with `node`.
 *
 * The matching table definitions are in `migrations/2026-11-10_digital_drops.sql`
 * and the routes are in `routes/drops.js`.
 */
import crypto from 'crypto';
import { normalizeMsisdn, isValidPayerPhone } from './scanPay.js';

export const TABLES = {
  products: 'digital_products',
  orders: 'digital_orders',
  entitlements: 'digital_entitlements',
  events: 'digital_events',
  serviceRequests: 'service_requests',
  // 2026-11-12: the free rung. Kept in their own tables because a magnet has no
  // price and a lead has no order, and mixing them into digital_products would have
  // meant relaxing the price check that stops a free row being sold.
  magnets: 'digital_lead_magnets',
  leads: 'digital_leads',
};

export const MIGRATION_FILE = 'migrations/2026-11-10_digital_drops.sql';
export const ASSET_DIR = 'drops_assets';

/** What can be sold as a file today. Everything else needs a live cohort. */
export const PRODUCT_KINDS = ['course', 'kit', 'playbook', 'bundle', 'report'];

export const ORDER_STATES = ['pending', 'prompted', 'paid', 'delivered', 'failed', 'expired'];
export const PAID_STATES = ['paid', 'delivered'];
export const TERMINAL_STATES = ['delivered', 'failed', 'expired'];

/** 365 days is long enough that nobody feels rushed and short enough to matter. */
export const DEFAULT_ACCESS_DAYS = 365;

/**
 * Safaricom's published Daraja charge for a Paybill collection, as the repo has
 * described it since the Kassangas build. Kept as a named constant because the
 * revenue report must not silently claim gross as take-home.
 */
export const MPESA_FEE_RATE = 0.0099;

export const MIN_PRICE_KES = 10;
export const MAX_PRICE_KES = 300000;
export const MIN_PRICE_USD = 5;
export const MAX_PRICE_USD = 5000;

/**
 * Two payment lanes, one catalogue (2026-11-11).
 *
 * The M-Pesa lane is Kenyan and collects shillings. The card lane collects USD
 * through a hosted checkout (a merchant of record such as Paddle, or Gumroad as a
 * stop-gap) and settles wherever that provider pays out. A product declares which
 * lanes it is sold on; the buyer's country decides which one is offered first.
 */
export const PAYMENT_LANES = ['mpesa', 'card'];
export const LANE_MODES = ['mpesa', 'card', 'both'];
export const LANE_CURRENCY = { mpesa: 'KES', card: 'USD' };
export const DEFAULT_COUNTRY_LANE = { KE: 'mpesa' };


/** Two prompts to the same phone inside 90 s is a double tap, not demand. */
export const CHECKOUT_REPLAY_MS = 90_000;

/** Daraja caps AccountReference at 12 characters; "DRP-XXXXXX" is 10. */
export const ORDER_REF_PREFIX = 'DRP';
export const ORDER_REF_LENGTH = 10;

export const MAX_ACCESS_DOWNLOADS = 40;

const SLUG_MAX = 60;

/** A URL-safe, lowercase, stable slug. Two titles must not collide by accident. */
export function normalizeSlug(input) {
  return String(input == null ? '' : input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
}

/** `DRP-4F2K9Q` — short enough for M-Pesa, random enough to not be guessable in bulk. */
export function newOrderRef() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return ORDER_REF_PREFIX + '-' + out;
}

export function isOrderRef(value) {
  return new RegExp('^' + ORDER_REF_PREFIX + '-[2-9A-HJ-NP-Z]{6}$').test(String(value || ''));
}

/** The secret a buyer holds after checkout so the page can poll their own order. */
export function newLookupSecret() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashLookup(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}

export function lookupMatches(secret, expectedHash) {
  const a = Buffer.from(hashLookup(secret), 'utf8');
  const b = Buffer.from(String(expectedHash || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/**
 * The key the entitlement token is signed with. `DROPS_TOKEN_SECRET` is the
 * intended variable; the fallbacks exist because a deploy that forgets it should
 * still sell rather than 500, and both fallbacks are already secret in Render.
 * An empty string means "cannot sign", and the routes refuse to issue links.
 */
export function dropsSecret(env = process.env) {
  const secret = env.DROPS_TOKEN_SECRET || env.TENANT_SESSION_SECRET || env.ADMIN_PASS || '';
  return String(secret || '').trim();
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** A signed, expiring pointer to one order. Not a session, not a password. */
export function signEntitlement(payload, secret) {
  if (!secret) throw new Error('drops signing secret is not configured');
  const body = {
    o: String(payload.orderId || ''),
    r: String(payload.orderRef || ''),
    p: String(payload.productSlug || ''),
    e: String(payload.expiresAt || ''),
  };
  if (!body.o || !body.p || !body.e) throw new Error('entitlement payload is incomplete');
  const data = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return data + '.' + sig;
}

export function verifyEntitlement(token, secret, now = new Date()) {
  const raw = String(token || '');
  if (!secret) return { ok: false, reason: 'unconfigured' };
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return { ok: false, reason: 'malformed' };
  const data = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || !payload.o || !payload.p || !payload.e) return { ok: false, reason: 'incomplete' };
  const expiry = new Date(payload.e);
  if (isNaN(expiry.getTime())) return { ok: false, reason: 'incomplete' };
  if (expiry.getTime() <= now.getTime()) return { ok: false, reason: 'expired', payload };
  return { ok: true, payload };
}

/** Add the access window to the moment the money landed. */
export function accessExpiry(paidAt, days = DEFAULT_ACCESS_DAYS) {
  const base = paidAt ? new Date(paidAt) : new Date();
  const start = isNaN(base.getTime()) ? new Date() : base;
  return new Date(start.getTime() + Number(days || DEFAULT_ACCESS_DAYS) * 86400000).toISOString();
}

/** The paywall's own answer to "is this still open", independent of the token. */
export function accessState(expiresAt, now = new Date()) {
  const expiry = new Date(expiresAt);
  if (isNaN(expiry.getTime())) return 'unknown';
  return expiry.getTime() > now.getTime() ? 'active' : 'expired';
}


/**
 * Validate a catalogue row before it can be sold. Returns `{ ok, errors, value }`
 * and never throws: the seed script and the route both need the errors, not a stack.
 */
// ---- the funnel (2026-11-12) -----------------------------------------------
//
// A catalogue is a price list. A funnel is an order to read it in. A buyer who
// lands on the KES 12,000 track with no cheaper proof does not buy, and a buyer who
// finishes the KES 1,500 kit and sees nothing next stops being a customer.
//
// So every published row names a rung. A rung is not a price band — it is the job
// the buyer is doing at that moment. `next_slug` is the rung this one hands over;
// when it is absent the ladder resolves one by step order, so a catalogue is always
// navigable without a hand-drawn graph.

export const FUNNEL_STEPS = [
  { key: 'lead', label: 'Free', order: 0, promise: 'A finished artefact for one task. No payment, no call.' },
  { key: 'entry', label: 'Entry', order: 1, promise: 'The cheapest paid proof that this shop delivers what it says.' },
  { key: 'core', label: 'Core', order: 2, promise: 'The implementation pack the buyer actually came for.' },
  { key: 'premium', label: 'Premium', order: 3, promise: 'The whole track, for a team or a career change.' },
  { key: 'continuity', label: 'Keep it running', order: 4, promise: 'Ongoing operation: monitoring, changes, reporting.' },
  { key: 'service', label: 'Done with you', order: 5, promise: 'The funnel-build engagement: it gets built for you.' },
];

export const FUNNEL_STEP_KEYS = FUNNEL_STEPS.map((s) => s.key);

/** -1 for an unknown step, so a caller can tell "free" from "not recognised". */
export function funnelStepIndex(step) {
  const key = String(step || '').toLowerCase();
  const hit = FUNNEL_STEPS.find((s) => s.key === key);
  return hit ? hit.order : -1;
}

/**
 * Which rung a row sits on. Defaults to `core` because that is what every row
 * written before 2026-11-12 was: a priced pack with no assigned rung. An unknown
 * value also lands on `core` rather than dropping the product out of the ladder.
 */
export function funnelStepOf(product) {
  const key = String((product && product.funnel_step) || '').toLowerCase();
  return FUNNEL_STEP_KEYS.includes(key) ? key : 'core';
}

/** Published rows, cheapest rung first, then the operator's rank, then price. */
export function sortLadder(products) {
  return (Array.isArray(products) ? products.slice() : [])
    .filter(isPublished)
    .sort((a, b) => {
      const sa = funnelStepIndex(funnelStepOf(a));
      const sb = funnelStepIndex(funnelStepOf(b));
      if (sa !== sb) return sa - sb;
      const ra = Number(a.rank == null ? 100 : a.rank);
      const rb = Number(b.rank == null ? 100 : b.rank);
      if (ra !== rb) return ra - rb;
      return Number(a.price_kes || 0) - Number(b.price_kes || 0);
    });
}

/** What a row costs, in the currency the ladder is ordered by. */
function ladderPrice(product) {
  if (!product) return 0;
  const kes = Number(product.price_kes);
  if (isFinite(kes) && kes > 0) return kes;
  const usd = Number(product.price_usd);
  return isFinite(usd) && usd > 0 ? usd : 0;
}

/**
 * The next rung this product hands the buyer.
 *
 * `next_slug` wins when it is a step up. Otherwise the cheapest product that is a
 * step up is used. A product never offers itself, anything cheaper, or anything on a
 * lower rung: that is not an upsell, it is a loop, and a loop is how a funnel turns
 * a buyer into a browser.
 */
export function nextOfferFor(product, products) {
  if (!product) return null;
  const rows = (Array.isArray(products) ? products : []).filter(isPublished);
  const self = String(product.slug || '');
  const explicit = product.next_slug ? normalizeSlug(product.next_slug) : '';
  if (explicit) {
    const hit = rows.find((p) => String(p.slug) === explicit && String(p.slug) !== self);
    if (hit && isForwardStep(product, hit)) return hit;
  }
  const higher = rows
    .filter((p) => String(p.slug) !== self && isForwardStep(product, p))
    .sort((a, b) => {
      const sa = funnelStepIndex(funnelStepOf(a));
      const sb = funnelStepIndex(funnelStepOf(b));
      if (sa !== sb) return sa - sb;
      return ladderPrice(a) - ladderPrice(b);
    });
  return higher[0] || null;
}

/** Every rung, with the products on it. Empty rungs stay visible so a gap shows. */
export function funnelLadder(products) {
  const rows = sortLadder(products);
  return FUNNEL_STEPS.map((step) => ({
    step: step.key,
    label: step.label,
    order: step.order,
    promise: step.promise,
    products: rows.filter((p) => funnelStepOf(p) === step.key),
  }));
}

/**
 * Does `a -> b` move forward? A step up means more commitment: never the same
 * product, never a lower rung, and never a cheaper price. That single ordering is
 * what makes a cycle impossible without a separate cycle check, and it is why the
 * pipeline can refuse a catalogue rather than quietly repairing it.
 */
export function isForwardStep(from, to) {
  if (!from || !to) return false;
  if (String(from.slug) === String(to.slug)) return false;
  if (funnelStepIndex(funnelStepOf(to)) < funnelStepIndex(funnelStepOf(from))) return false;
  return ladderPrice(to) > ladderPrice(from);
}

/**
 * Where a buyer should go next, including the service rung, which is a page rather
 * than a catalogue row. `{ kind: 'product' | 'service' | null }` so the UI never has
 * to infer intent from a null.
 */
export function nextActionFor(product, products, opts = {}) {
  const offer = nextOfferFor(product, products);
  if (offer) return { kind: 'product', product: offer, slug: offer.slug, title: offer.title };
  if (funnelStepIndex(funnelStepOf(product)) >= funnelStepIndex('premium')) {
    return { kind: 'service', url: opts.serviceUrl || '/build', title: 'Have it built for you' };
  }
  return { kind: null };
}

export const LEAD_SOURCES = ['storefront', 'blog', 'whatsapp', 'direct', 'outreach', 'unknown'];

/**
 * The free rung. A lead is an email *or* a WhatsApp number — never both required,
 * because a buyer on a phone will type one and resent the other.
 */
export function validateLead(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = [];
  const magnetSlug = normalizeSlug(src.magnet_slug || src.magnet || src.slug || '');
  const emailRaw = String(src.email || '').trim();
  const phoneRaw = String(src.phone || src.whatsapp || '').trim();
  const source = String(src.source || '').toLowerCase();
  const name = String(src.name || '').trim().slice(0, 120);

  if (!magnetSlug) errors.push('Which free pack do you want? The request did not name one.');
  if (!emailRaw && !phoneRaw) errors.push('An email address or a WhatsApp number is required — the pack is sent to one of them.');

  let email = '';
  if (emailRaw) {
    const checked = validateEmail({ email: emailRaw });
    if (!checked.ok) errors.push(checked.error);
    else email = checked.email;
  }

  let phone = '';
  if (phoneRaw) {
    const normalized = normalizeMsisdn(phoneRaw);
    if (!/^254\d{9}$/.test(normalized)) errors.push('Use a Kenyan mobile number, for example 07XX XXX XXX.');
    else phone = normalized;
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      magnet_slug: magnetSlug,
      email: email || null,
      phone: phone || null,
      name,
      source: LEAD_SOURCES.includes(source) ? source : 'unknown',
      consent: src.consent === true,
    },
  };
}

/**
 * A lead magnet is not a product: no price, no order, no entitlement. It must still
 * carry a real file and enough substance to be worth an address, so the same
 * three-outcomes/three-modules rule applies.
 */
export function validateLeadMagnet(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const slug = normalizeSlug(src.slug || src.title || '');
  const title = String(src.title || '').trim();
  const outcomes = Array.isArray(src.outcomes) ? src.outcomes.map((x) => String(x).trim()).filter(Boolean) : [];
  const modules = Array.isArray(src.modules) ? src.modules : [];

  if (!slug) errors.push('slug is required (or a title that can become one)');
  if (title.length < 4) errors.push('title must be at least 4 characters');
  if (modules.length < 3) errors.push('at least three modules are required');
  if (outcomes.length < 3) errors.push('at least three outcomes are required');
  if (!String(src.asset_file || '').trim()) errors.push('asset_file is required: a magnet with no file is a broken promise');

  return {
    ok: errors.length === 0,
    errors,
    value: {
      slug,
      title,
      summary: String(src.summary || '').trim(),
      promise: String(src.promise || '').trim(),
      outcomes,
      modules,
      asset_file: String(src.asset_file || ''),
      status: ['draft', 'published', 'retired'].includes(src.status) ? src.status : 'draft',
      rank: Number.isFinite(Number(src.rank)) ? Number(src.rank) : 100,
      next_slug: src.next_slug ? normalizeSlug(src.next_slug) : null,
    },
  };
}

/**
 * The token inside a free download link.
 *
 * Deliberately a different payload shape (`m` magnet, `l` lead, `e` expiry) from a
 * paid entitlement (`o` order, `r` ref, `p` product, `e` expiry), and the verifier
 * rejects a token carrying the other shape. Without that check a forwarded access
 * link would be a working key to the free shelf, and a lead token would read like a
 * purchase.
 */
export function signLeadToken(payload, secret) {
  if (!secret) throw new Error('drops signing secret is not configured');
  const body = {
    m: String(payload.magnetSlug || ''),
    l: String(payload.leadId || ''),
    e: String(payload.expiresAt || ''),
  };
  if (!body.m || !body.l || !body.e) throw new Error('lead payload is incomplete');
  const data = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return data + '.' + sig;
}

export function verifyLeadToken(token, secret, now = new Date()) {
  const raw = String(token || '');
  if (!secret) return { ok: false, reason: 'unconfigured' };
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return { ok: false, reason: 'malformed' };
  const data = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload && payload.o) return { ok: false, reason: 'wrong-type' };
  if (!payload || !payload.m || !payload.l || !payload.e) return { ok: false, reason: 'incomplete' };
  const expiry = new Date(payload.e);
  if (isNaN(expiry.getTime())) return { ok: false, reason: 'incomplete' };
  if (expiry.getTime() <= now.getTime()) return { ok: false, reason: 'expired', payload };
  return { ok: true, payload };
}

/** How long a free download link stays open. Long enough to open it tomorrow. */
export const LEAD_LINK_DAYS = 14;

/**
 * The message a free pack arrives in. One function for both channels, because a
 * visitor who gave a phone and one who gave an address were made the same promise.
 */
export function magnetDelivery({ magnet, downloadUrl, expiresAt }) {
  const title = (magnet && magnet.title) || 'your free pack';
  const promise = (magnet && magnet.promise) || '';
  const until = expiresAt ? String(expiresAt).slice(0, 10) : null;
  const safe = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const text = [
    title + ' is ready.',
    promise ? promise : null,
    '',
    'Open it: ' + downloadUrl,
    until ? 'This link stays open until ' + until + '.' : null,
    '',
    'It is a single page you can read on a phone, and it is yours to keep.',
    '',
    '— Alphadome',
  ].filter((line) => line !== null).join('\n');
  const whatsapp = [
    '*' + title + '* is ready.',
    '',
    'Open it: ' + downloadUrl,
    until ? 'Link open until ' + until + '.' : null,
  ].filter((line) => line !== null).join('\n');
  return {
    subject: 'Your free pack: ' + title,
    text,
    whatsapp,
    html: '<p><strong>' + safe(title) + '</strong> is ready.</p>' +
      (promise ? '<p>' + safe(promise) + '</p>' : '') +
      '<p><a href="' + safe(downloadUrl) + '">Open your free pack</a></p>' +
      (until ? '<p>This link stays open until ' + safe(until) + '.</p>' : '') +
      '<p>It is a single page you can read on a phone, and it is yours to keep.</p>' +
      '<p>— Alphadome</p>',
  };
}

/**
 * The funnel, measured rung by rung.
 *
 * Denominators are stated, not implied: `leads` counts captures on that rung's
 * magnets, `views` counts product view events, `checkouts` counts checkout events,
 * `paid` counts paid orders. A rate is only returned when its denominator is
 * non-zero, and gross is kept in one currency — summing KES and USD would produce a
 * number that is not money.
 */
export function funnelReport({ products = [], magnets = [], orders = [], leads = [], events = [], currency = 'KES' } = {}) {
  const rows = (Array.isArray(products) ? products : []).filter(isPublished);
  const magnetRows = Array.isArray(magnets) ? magnets : [];
  const orderRows = Array.isArray(orders) ? orders : [];
  const leadRows = Array.isArray(leads) ? leads : [];
  const eventRows = Array.isArray(events) ? events : [];
  const money = String(currency || 'KES').toUpperCase();
  const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

  const steps = FUNNEL_STEPS.map((step) => {
    const onRung = rows.filter((p) => funnelStepOf(p) === step.key);
    const slugs = new Set(onRung.map((p) => String(p.slug)));
    const rungMagnets = magnetRows.filter((m) => String(m.status || 'published') === 'published');
    const magnetSlugs = new Set(rungMagnets.map((m) => String(m.slug)));
    const rungLeads = step.key === 'lead' ? leadRows.filter((l) => magnetSlugs.has(String(l.magnet_slug))) : [];
    const rungEvents = eventRows.filter((e) => slugs.has(String(e.product_slug)));
    const views = rungEvents.filter((e) => String(e.event) === 'view').length;
    const checkouts = rungEvents.filter((e) => /^checkout/.test(String(e.event))).length;
    const rungOrders = orderRows.filter((o) => slugs.has(String(o.product_slug)) && PAID_STATES.includes(String(o.status)));
    const inCurrency = rungOrders.filter((o) => String(o.currency || money).toUpperCase() === money);
    const gross = inCurrency.reduce((sum, o) => sum + Number(o.amount || 0), 0);
    return {
      step: step.key,
      label: step.label,
      order: step.order,
      promise: step.promise,
      products: onRung.map((p) => String(p.slug)),
      magnets: step.key === 'lead' ? [...magnetSlugs] : [],
      views,
      leads: rungLeads.length,
      checkouts,
      paid: rungOrders.length,
      gross: Math.round(gross * 100) / 100,
      lead_to_paid: rate(rungOrders.length, rungLeads.length),
      view_to_paid: rate(rungOrders.length, views),
      checkout_to_paid: rate(rungOrders.length, checkouts),
    };
  });

  const attributed = new Set(steps.flatMap((s) => s.products));
  const paidRows = orderRows.filter((o) => PAID_STATES.includes(String(o.status)));
  const unattributed = paidRows.filter((o) => !attributed.has(String(o.product_slug)));
  const sum = (key) => steps.reduce((n, s) => n + Number(s[key] || 0), 0);

  return {
    currency: money,
    steps,
    totals: {
      views: sum('views'),
      leads: sum('leads'),
      checkouts: sum('checkouts'),
      paid: sum('paid'),
      gross: Math.round(sum('gross') * 100) / 100,
      lead_to_paid: rate(sum('paid'), sum('leads')),
    },
    unattributed: {
      paid: unattributed.length,
      note: unattributed.length
        ? 'Paid orders whose product is no longer published. They are not counted on any rung.'
        : '',
    },
    other_currency_orders: paidRows.filter((o) => String(o.currency || money).toUpperCase() !== money).length,
  };
}

export function validateProduct(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const slug = normalizeSlug(src.slug || src.title || '');
  const title = String(src.title || '').trim();
  const kind = String(src.kind || 'kit').toLowerCase();
  const priceKes = Number(src.price_kes);
  const priceUsd = src.price_usd == null || src.price_usd === '' ? null : Number(src.price_usd);
  const outcomes = Array.isArray(src.outcomes) ? src.outcomes.map((x) => String(x).trim()).filter(Boolean) : [];
  const modules = Array.isArray(src.modules) ? src.modules : [];

  if (!slug) errors.push('slug is required (or a title that can become one)');
  if (title.length < 4) errors.push('title must be at least 4 characters');
  if (!PRODUCT_KINDS.includes(kind)) errors.push('kind must be one of ' + PRODUCT_KINDS.join(', '));
  if (!isFinite(priceKes) || priceKes < MIN_PRICE_KES || priceKes > MAX_PRICE_KES) {
    errors.push('price_kes must be a number between ' + MIN_PRICE_KES + ' and ' + MAX_PRICE_KES);
  }
  if (priceUsd != null && (!isFinite(priceUsd) || priceUsd <= 0)) errors.push('price_usd must be positive when set');
  if (String(src.payment_lane || '').toLowerCase() === 'card' && !(Number(src.price_usd) > 0)) {
    errors.push('a card-only product needs a price_usd');
  }
  if (outcomes.length < 3) errors.push('at least three outcomes are required');
  if (modules.length < 3) errors.push('at least three modules are required');
  if (src.next_slug && normalizeSlug(src.next_slug) === slug) {
    errors.push('next_slug cannot point at itself — that is a loop, not an upsell');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      slug,
      title,
      kind,
      status: ['draft', 'published', 'retired'].includes(src.status) ? src.status : 'draft',
      summary: String(src.summary || '').trim(),
      outcomes,
      modules,
      price_kes: isFinite(priceKes) ? priceKes : null,
      price_usd: priceUsd,
      compare_at_kes: Number(src.compare_at_kes) > 0 ? Number(src.compare_at_kes) : null,
      bump_slug: src.bump_slug ? normalizeSlug(src.bump_slug) : null,
      asset_file: src.asset_file ? String(src.asset_file) : null,
      delivery_note: String(src.delivery_note || '').trim(),
      rank: Number.isFinite(Number(src.rank)) ? Number(src.rank) : 100,
      payment_lane: LANE_MODES.includes(String(src.payment_lane || '').toLowerCase())
        ? String(src.payment_lane).toLowerCase()
        : 'both',
      funnel_step: FUNNEL_STEP_KEYS.includes(String(src.funnel_step || '').toLowerCase())
        ? String(src.funnel_step).toLowerCase()
        : 'core',
      next_slug: src.next_slug ? normalizeSlug(src.next_slug) : null,
    },
  };
}

export function isPublished(product) {
  return Boolean(product) && String(product.status || '') === 'published';
}

/** The only fields a public page or API needs. Everything else stays server-side. */
export function publicProduct(product) {
  if (!product) return null;
  const laneMode = String(product.payment_lane || 'both');
  return {
    slug: product.slug,
    title: product.title,
    kind: product.kind,
    summary: product.summary || '',
    outcomes: Array.isArray(product.outcomes) ? product.outcomes : [],
    modules: Array.isArray(product.modules) ? product.modules : [],
    price_kes: Number(product.price_kes || 0),
    price_usd: product.price_usd == null ? null : Number(product.price_usd),
    compare_at_kes: product.compare_at_kes == null ? null : Number(product.compare_at_kes),
    bump_slug: product.bump_slug || null,
    delivery_note: product.delivery_note || '',
    has_file: Boolean(product.asset_file),
    payment_lane: laneMode,
    lanes: lanesFor(product),
    funnel_step: funnelStepOf(product),
    funnel_order: funnelStepIndex(funnelStepOf(product)),
    next_slug: product.next_slug || null,
  };
}

/** Which lanes a product is sold on. A USD price is required to sell by card. */
export function lanesFor(product) {
  if (!product) return [];
  const mode = String(product.payment_lane || 'both');
  const out = [];
  if (mode === 'mpesa' || mode === 'both') out.push('mpesa');
  if ((mode === 'card' || mode === 'both') && Number(product.price_usd) > 0) out.push('card');
  return out;
}

/**
 * Which lane to offer first. The buyer can override, but only to a lane the
 * product actually supports — a US visitor must never be shown an M-Pesa prompt
 * as the only option (which is exactly what shipped on 2026-11-10).
 */
export function preferredLane(product, opts = {}) {
  const allowed = lanesFor(product);
  if (!allowed.length) return null;
  const requested = String(opts.requested || '').toLowerCase();
  if (requested && allowed.includes(requested)) return requested;
  const country = String(opts.country || '').toUpperCase();
  const byCountry = DEFAULT_COUNTRY_LANE[country] || 'card';
  if (allowed.includes(byCountry)) return byCountry;
  return allowed[0];
}

/** ISO-3166 alpha-2 from whatever the edge or the browser gives us. */
export function normalizeCountry(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  if (raw === 'KENYA') return 'KE';
  if (raw === 'UNITED STATES' || raw === 'USA') return 'US';
  if (raw === 'UNITED KINGDOM' || raw === 'UK' || raw === 'GREAT BRITAIN') return 'GB';
  if (raw === 'CANADA') return 'CA';
  return '';
}

export function validateEmail(input) {
  const email = String((input && input.email) || '').trim();
  if (!email) return { ok: false, error: 'An email address is required for a card receipt.' };
  if (email.length > 254) return { ok: false, error: 'That email address is too long.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: 'That email address does not look valid.' };
  return { ok: true, email: email.toLowerCase() };
}


/** Published only, ordered by the ladder the operator set (`rank`). */
export function sortCatalog(products) {
  return (Array.isArray(products) ? products.slice() : [])
    .filter(isPublished)
    .sort((a, b) => {
      const ra = Number(a.rank == null ? 100 : a.rank);
      const rb = Number(b.rank == null ? 100 : b.rank);
      if (ra !== rb) return ra - rb;
      return Number(a.price_kes || 0) - Number(b.price_kes || 0);
    });
}

export function formatPrice(amount, currency = 'KES') {
  const n = Number(amount);
  if (!isFinite(n)) return '';
  const value = n.toLocaleString('en-KE', { maximumFractionDigits: n % 1 === 0 ? 0 : 2 });
  return currency === 'KES' ? 'KES ' + value : String(currency) + ' ' + value;
}

/**
 * What this checkout would charge, in the lane's own currency. The bump is a real
 * product row, not a hard-coded discount, so the receipt and the delivered access
 * links agree. `opts.lane` defaults to M-Pesa so every pre-2026-11-11 caller keeps
 * its behaviour.
 */
export function quoteCheckout(product, bumpProduct = null, opts = {}) {
  const lane = opts.lane === 'card' ? 'card' : 'mpesa';
  const currency = LANE_CURRENCY[lane];
  const floor = lane === 'card' ? MIN_PRICE_USD : MIN_PRICE_KES;
  const ceiling = lane === 'card' ? MAX_PRICE_USD : MAX_PRICE_KES;
  const priceOf = (p) => (lane === 'card' ? Number(p && p.price_usd) : Number(p && p.price_kes));

  if (!lanesFor(product).includes(lane)) {
    return { ok: false, error: lane === 'card' ? 'This pack is not on sale by card yet.' : 'This pack is not on sale by M-Pesa.' };
  }
  const main = priceOf(product);
  if (!isFinite(main) || main < floor) return { ok: false, error: 'This product has no valid price.' };

  const lines = [{ slug: product.slug, label: product.title, amount: main }];
  if (bumpProduct && isPublished(bumpProduct) && bumpProduct.slug !== product.slug) {
    const bump = priceOf(bumpProduct);
    if (isFinite(bump) && bump >= floor && lanesFor(bumpProduct).includes(lane)) {
      lines.push({ slug: bumpProduct.slug, label: bumpProduct.title, amount: bump, bump: true });
    }
  }
  const amount = lines.reduce((sum, l) => sum + l.amount, 0);
  if (amount > ceiling) return { ok: false, error: 'This order is above the self-serve limit. Book a call instead.' };
  return { ok: true, amount, currency, lane, lines };
}


export function mpesaFee(amount, rate = MPESA_FEE_RATE) {
  const n = Number(amount);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round(n * rate * 100) / 100;
}

/** What actually lands in the account, after Safaricom's collection fee. */
export function netOfFee(amount, rate = MPESA_FEE_RATE) {
  const n = Number(amount);
  if (!isFinite(n)) return 0;
  return Math.round((n - mpesaFee(n, rate)) * 100) / 100;
}


/**
 * The order state machine. A repeated event returns null, which is the caller's
 * signal to reply "already handled" instead of issuing a second access link.
 *
 *   pending --prompted--> prompted --paid--> paid --delivered--> delivered
 *   pending|prompted|paid --failed--> failed
 *   pending --expired--> expired
 */
export function orderTransition(current, event) {
  const state = String(current || 'pending');
  const ev = String(event || '');
  const table = {
    pending: { prompted: 'prompted', paid: 'paid', failed: 'failed', expired: 'expired' },
    prompted: { paid: 'paid', failed: 'failed', prompted: 'prompted' },
    paid: { delivered: 'delivered', paid: 'paid', failed: 'failed' },
    delivered: { delivered: 'delivered', paid: 'delivered' },
    failed: { paid: 'paid', prompted: 'prompted' },
    expired: { paid: 'paid' },
  };
  const next = table[state] && table[state][ev];
  if (!next) return null;
  return next === state ? null : next;
}

export function isTerminalState(state) {
  return TERMINAL_STATES.includes(String(state || ''));
}

/** The WhatsApp message that replaces a support person. Written for a phone. */
export function deliveryMessage({ product, order, accessUrl, expiresAt, receipt }) {
  const title = (product && product.title) || (order && order.product_title) || 'your pack';
  const lines = [];
  lines.push('*' + title + '* is yours.');
  if (receipt) lines.push('Receipt: ' + receipt);
  if (order && order.amount) lines.push('Paid: KES ' + Number(order.amount).toLocaleString('en-KE'));
  lines.push('');
  lines.push('Open your pack: ' + accessUrl);
  if (expiresAt) {
    const d = new Date(expiresAt);
    if (!isNaN(d.getTime())) lines.push('Access runs to ' + d.toISOString().slice(0, 10) + ' — keep this message.');
  }
  lines.push('');
  lines.push('Reply here if the link does not open and a human will resend it.');
  return lines.join('\n');
}

/** The click-to-WhatsApp support line, so delivery is never a dead end. */
export function supportWhatsAppLink(env = process.env) {
  const raw = String(env.DROPS_SUPPORT_WHATSAPP || env.SUPPORT_WHATSAPP || env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
  if (!raw) return null;
  const phone = raw.startsWith('254') ? raw : raw.startsWith('0') ? '254' + raw.slice(1) : raw;
  return 'https://wa.me/' + phone;
}

/**
 * Revenue that is real: only paid and delivered orders count, fees are subtracted
 * per lane, and results are split by currency because KES and USD cannot be summed.
 *
 * The M-Pesa lane loses 0.99% to Safaricom. The card lane's fee is whatever the
 * provider charges (a merchant of record takes a percentage plus a fixed amount),
 * so it is not guessed here: `cardFeeRate` is 0 unless the operator sets it, and
 * `fees.card` says so rather than inventing a number.
 */
export function revenueSummary(orders, opts = {}) {
  const mpesaRate = opts.feeRate == null ? MPESA_FEE_RATE : Number(opts.feeRate);
  const cardRate = opts.cardFeeRate == null ? 0 : Number(opts.cardFeeRate);
  const rows = Array.isArray(orders) ? orders : [];
  const laneOf = (o) => (String((o && (o.lane || o.payment_lane)) || 'mpesa').toLowerCase() === 'card' ? 'card' : 'mpesa');
  const currencyOf = (o) => String((o && o.currency) || LANE_CURRENCY[laneOf(o)] || 'KES').toUpperCase();

  const paid = rows.filter((o) => PAID_STATES.includes(String((o && o.status) || '')));
  const byCurrency = new Map();
  const byLane = new Map();
  const byProduct = new Map();

  for (const o of paid) {
    const currency = currencyOf(o);
    const lane = laneOf(o);
    const amount = Number(o.amount || 0);

    const c = byCurrency.get(currency) || { currency, gross: 0, fees: 0, orders: 0 };
    c.gross += amount;
    c.orders += 1;
    c.fees += lane === 'card' ? amount * cardRate : mpesaFee(amount, mpesaRate);
    byCurrency.set(currency, c);

    const l = byLane.get(lane) || { lane, gross: 0, orders: 0, currency: LANE_CURRENCY[lane] };
    l.gross += amount;
    l.orders += 1;
    byLane.set(lane, l);

    const key = String(o.product_slug || 'unknown');
    const p = byProduct.get(key) || { slug: key, title: o.product_title || key, orders: 0, gross: 0, currency };
    p.orders += 1;
    p.gross += amount;
    byProduct.set(key, p);
  }

  const round = (n) => Math.round(n * 100) / 100;
  const currencies = Array.from(byCurrency.values()).map((c) => ({
    currency: c.currency,
    orders: c.orders,
    gross: round(c.gross),
    fees: round(c.fees),
    net: round(c.gross - c.fees),
    aov: c.orders ? round(c.gross / c.orders) : 0,
  })).sort((a, b) => b.gross - a.gross);

  const primary = currencies.find((c) => c.currency === 'KES') || currencies[0] || null;
  const attempts = rows.length;

  return {
    orders: attempts,
    paid_orders: paid.length,
    delivered: paid.filter((o) => String(o.status) === 'delivered').length,
    primary_currency: primary ? primary.currency : 'KES',
    gross: primary ? primary.gross : 0,
    fees: primary ? primary.fees : 0,
    net: primary ? primary.net : 0,
    aov: primary ? primary.aov : 0,
    conversion: attempts ? Math.round((paid.length / attempts) * 1000) / 10 : 0,
    fee_rate: mpesaRate,
    card_fee_rate: cardRate,
    by_currency: currencies,
    by_lane: Array.from(byLane.values()).map((l) => ({ ...l, gross: round(l.gross) })),
    by_product: Array.from(byProduct.values())
      .map((p) => ({ ...p, gross: round(p.gross) }))
      .sort((a, b) => b.gross - a.gross),
  };
}


/**
 * Read an M-Pesa STK callback once, in one place. The existing `/mpesa/callback`
 * parses the same shape inline; new surfaces should not grow a third copy.
 */
export function parseMpesaCallback(body) {
  const cb = body && body.Body && body.Body.stkCallback ? body.Body.stkCallback : {};
  const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  const pick = (name) => {
    const hit = items.find((i) => i && i.Name === name);
    return hit ? hit.Value : null;
  };
  const checkoutId = cb.CheckoutRequestID || (body && body.CheckoutRequestID) || null;
  return {
    checkoutId,
    merchantRequestId: cb.MerchantRequestID || null,
    resultCode: cb.ResultCode == null ? null : Number(cb.ResultCode),
    resultDesc: cb.ResultDesc || null,
    receipt: pick('MpesaReceiptNumber'),
    amount: pick('Amount'),
    phone: pick('PhoneNumber'),
  };
}

/** True when the table has not been created yet, so the route can say which file to run. */
export function isMissingTable(error) {
  const code = error && (error.code || error.status);
  if (code === '42P01' || code === 'PGRST205') return true;
  const message = String((error && (error.message || error.details)) || '');
  return /does not exist|schema cache|could not find the table/i.test(message);
}

/**
 * Checkout wants a Kenyan mobile number that is actually a Safaricom line, because
 * an STK prompt to anything else fails after the buyer has already committed.
 */
export function validateCheckout(input) {
  const errors = [];
  const phoneRaw = String((input && input.phone) || '').trim();
  const phone = normalizeMsisdn(phoneRaw);
  if (!phoneRaw) errors.push('An M-Pesa phone number is required.');
  else if (!isValidPayerPhone(phoneRaw)) errors.push('Use a Safaricom number, for example 07XX XXX XXX.');
  return { ok: errors.length === 0, errors, phone };
}

/**
 * The hosted checkout URL for the card lane.
 *
 * A merchant of record owns the payment page; this only has to hand the buyer
 * over with enough context to reconcile the sale. Either a per-product map
 * (`DROPS_CARD_LINKS`, JSON: {"slug": "https://provider/..."}) or one default link
 * (`DROPS_CARD_LINK`). Nothing here guesses a provider's API: it appends a
 * reference, and it returns null when no link is configured rather than failing at
 * the last step of a checkout.
 */
export function cardCheckoutUrl(env = process.env, order = {}) {
  const slug = String(order.slug || '');
  let base = '';
  const map = String(env.DROPS_CARD_LINKS || '').trim();
  if (map) {
    try {
      const parsed = JSON.parse(map);
      if (parsed && typeof parsed === 'object' && parsed[slug]) base = String(parsed[slug]);
    } catch (_) { /* a malformed map falls through to the default link */ }
  }
  if (!base) base = String(env.DROPS_CARD_LINK || '').trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set('ref', String(order.orderRef || ''));
    if (order.email) url.searchParams.set('email', String(order.email));
    url.searchParams.set('src', 'alphadome-drops');
    return url.toString();
  } catch (_) {
    return null;
  }
}

/**
 * Verify a card provider's webhook signature over the raw request body.
 * HMAC-SHA256, hex or base64, with an optional `sha256=` prefix. Timing-safe.
 * Provider-specific schemes (Paddle's timestamped `Paddle-Signature`, for example)
 * can be layered in front of this later without touching the order code.
 */
export function verifyCardWebhook(rawBody, signature, secret) {
  const body = typeof rawBody === 'string' ? rawBody : String(rawBody || '');
  const key = String(secret || '');
  const provided = String(signature || '').replace(/^sha256=/i, '').trim();
  if (!key) return { ok: false, reason: 'unconfigured' };
  if (!provided) return { ok: false, reason: 'missing-signature' };
  const expectedHex = crypto.createHmac('sha256', key).update(body).digest('hex');
  const expectedB64 = crypto.createHmac('sha256', key).update(body).digest('base64');
  const match = [expectedHex, expectedB64].some((expected) => {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  return match ? { ok: true } : { ok: false, reason: 'bad-signature' };
}

/** Normalise a provider callback into the one shape the order machine understands. */
export function parseCardWebhook(body) {
  const src = body && typeof body === 'object' ? (body.data && typeof body.data === 'object' ? body.data : body) : {};
  const rawStatus = String(src.status || src.event || src.event_type || '').toLowerCase();
  let status = '';
  if (/paid|succeeded|success|complete|completed|active/.test(rawStatus)) status = 'paid';
  else if (/fail|cancel|expire|refund|declin/.test(rawStatus)) status = 'failed';
  return {
    orderRef: String(src.order_ref || src.orderRef || src.reference || src.ref || '').trim().toUpperCase(),
    status,
    amount: src.amount == null ? null : Number(src.amount),
    currency: src.currency ? String(src.currency).toUpperCase() : null,
    email: src.email ? String(src.email).trim().toLowerCase() : null,
    providerRef: String(src.transaction_id || src.provider_ref || src.id || src.subscription_id || '') || null,
    provider: String(src.provider || src.gateway || 'card') || 'card',
    raw: rawStatus,
  };
}

/** The email a card buyer receives. Written for a person, not for a log file. */
export function deliveryEmail({ product, order, accessUrl, expiresAt, receipt }) {
  const title = (product && product.title) || (order && order.product_title) || 'your pack';
  const amount = order && order.amount ? Number(order.amount).toLocaleString('en-US') : null;
  const currency = (order && order.currency) || 'USD';
  const until = expiresAt ? String(expiresAt).slice(0, 10) : null;
  const safe = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const text = [
    'Thank you — ' + title + ' is yours.',
    '',
    receipt ? 'Receipt: ' + receipt : null,
    amount ? 'Paid: ' + currency + ' ' + amount : null,
    until ? 'Access runs to ' + until + '.' : null,
    '',
    'Open your pack: ' + accessUrl,
    '',
    'This link is personal to your purchase. If it does not open, reply to this email and a human will resend it.',
    '',
    '— Alphadome',
  ].filter((line) => line !== null).join('\n');
  return {
    subject: 'Your pack: ' + title,
    text,
    html: '<p>Thank you — <strong>' + safe(title) + '</strong> is yours.</p>' +
      (receipt ? '<p>Receipt: ' + safe(receipt) + '</p>' : '') +
      (amount ? '<p>Paid: ' + currency + ' ' + amount + '</p>' : '') +
      '<p><a href="' + safe(accessUrl) + '">Open your pack</a></p>' +
      (until ? '<p>Access runs to ' + until + '.</p>' : '') +
      '<p>This link is personal to your purchase. If it does not open, reply to this email and a human will resend it.</p>' +
      '<p>— Alphadome</p>',
  };
}

export const SERVICE_BUDGETS = ['3k-6k', '6k-12k', '12k+', 'unsure'];
export const SERVICE_TIMELINES = ['now', '30-days', 'quarter', 'exploring'];

/**
 * The rung-3 proposal request. A funnel build is a service, so it must arrive with
 * enough context to price it — otherwise the reply is "tell me more", which is the
 * same as no reply.
 */
export function validateServiceRequest(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = [];
  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const name = clean(src.name, 120);
  const company = clean(src.company, 160);
  const sell = clean(src.sell, 600);
  const channel = clean(src.channel, 120);
  const country = normalizeCountry(src.country) || clean(src.country, 60).toUpperCase();
  const budget = clean(src.budget, 20).toLowerCase();
  const timeline = clean(src.timeline, 20).toLowerCase();
  const problem = clean(src.problem, 1200);
  const email = validateEmail(src);

  if (name.length < 2) errors.push('Your name is required.');
  if (!email.ok) errors.push(email.error);
  if (sell.length < 12) errors.push('Say what you sell, in one sentence.');
  if (!SERVICE_BUDGETS.includes(budget)) errors.push('Pick a budget range so the proposal can be priced.');
  if (!SERVICE_TIMELINES.includes(timeline)) errors.push('Pick a timeline.');

  return {
    ok: errors.length === 0,
    errors,
    value: { name, company, email: email.email || '', country, sell, channel, problem, budget, timeline },
  };
}





