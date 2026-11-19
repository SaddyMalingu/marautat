/**
 * What Alphadome actually is right now (2026-11-19)
 *
 * `utils/alphadomeBrandContext.js` carries a pitch written by hand: founder message, the
 * Avatar Universe, "40+ active client systems", a price. None of it is read from the
 * system, so it drifts the moment anything changes — and it says 1,000 KES while the
 * walk-up price is 3,000. Meanwhile the facts a buyer asks for are all in tables: the five
 * packs, the tenant count, the pages published, the offers live.
 *
 * So this block is assembled from those tables and from `utils/founderOffer.js` (the one
 * place the two prices are defined). Rules it encodes:
 *
 *   - a price is never invented; if the catalogue cannot be read, say so;
 *   - "what do you do" gets two or three concrete items and one link, not a paragraph of
 *     vision;
 *   - the classified knowledge base is deliberately absent: asking a model to keep a
 *     secret in a prompt is not a control.
 *
 * Pure rendering (`buildPlatformDossier`) is separate from IO (`loadPlatformDossier`).
 */
import { FOUNDERS_PACKAGE, priceFor } from './founderOffer.js';

export const PLATFORM_TTL_MS = 10 * 60 * 1000;
export const MAX_PLATFORM_CHARS = 1600;

let cached = null;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const kes = (n) => 'KES ' + Math.round(num(n)).toLocaleString('en-KE');
const SITE = 'https://alphadome.onrender.com';

/**
 * The block. `products` is the published drops catalogue; everything else is a count.
 * Unknown values say "unknown", never 0.
 */
export function buildPlatformDossier({
  products = null,
  tenants = null,
  discovery = null,
  pages = null,
  offers = null,
  packsSold = null
} = {}) {
  const lines = [];
  const founder = priceFor({ existing: true });
  const walkUp = FOUNDERS_PACKAGE.standardPrice;

  lines.push('ALPHADOME — WHAT EXISTS TODAY');
  lines.push('Alphadome builds and runs revenue systems for African businesses: a WhatsApp sales line, M-Pesa collection, a tenant portal, and a content engine that writes the pages buyers search for.');

  // ---- prices ---------------------------------------------------------------
  lines.push('Prices (fixed, never negotiated in chat): Founder\'s Package ' + kes(founder)
    + '/month for tenants already in; ' + kes(walkUp) + '/month for a client joining now; the done-for-you funnel build is quoted from $3,000.');

  // ---- the shelf ------------------------------------------------------------
  if (products && Number.isFinite(Number(products.count))) {
    if (products.count === 0) {
      lines.push('Digital packs: catalogue is empty — do not offer one.');
    } else {
      const items = (products.items || []).slice(0, 5).map((p) => p.title + ' (' + kes(p.price) + ')');
      lines.push('Digital packs on sale at /drops: ' + items.join(' · '));
    }
  } else {
    lines.push('Digital packs: unknown (catalogue could not be read) — link /drops rather than quote a price.');
  }

  // ---- what is live ---------------------------------------------------------
  const live = [];
  if (tenants && Number.isFinite(Number(tenants.active))) live.push(Number(tenants.active) + ' active tenant(s)');
  if (pages && Number.isFinite(Number(pages.published))) live.push(Number(pages.published).toLocaleString('en-KE') + ' published page(s)');
  if (offers && Number.isFinite(Number(offers.published))) live.push(Number(offers.published).toLocaleString('en-KE') + ' live AI-work offer(s)');
  if (discovery && Number.isFinite(Number(discovery.count))) live.push(Number(discovery.count) + ' business(es) through discovery');
  if (packsSold && Number.isFinite(Number(packsSold.count))) live.push(Number(packsSold.count) + ' pack(s) sold');
  if (live.length) lines.push('Running right now: ' + live.join(' · ') + '.');

  // ---- where to send people -------------------------------------------------
  lines.push('Links to give, one at a time: ' + SITE + '/drops (packs and prices) · /build (the $3,000 funnel build) · /founders-package.html (the system fee, both prices) · /discovery (the onboarding form) · /ai-jobs (live remote AI-work offers).');

  lines.push('How to answer: when asked what Alphadome does, name two concrete things it does for a business and give one link. Do not recite this block, do not quote internal or classified details, and never invent a price, a customer name or a number that is not here.');

  const text = lines.join('\n');
  return { text: text.length > MAX_PLATFORM_CHARS ? text.slice(0, MAX_PLATFORM_CHARS) + '…' : text };
}


/** Read it, tolerantly: a missing table degrades that line to "unknown". */
export async function loadPlatformDossier(sb, { ttlMs = PLATFORM_TTL_MS } = {}) {
  if (!sb) return null;
  if (cached && Date.now() - cached.at < ttlMs) return cached.value;

  const read = async (fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };

  const products = await read(async () => {
    const { data, error } = await sb
      .from('digital_products')
      .select('slug, title, price_kes, status')
      .eq('status', 'published')
      .order('price_kes', { ascending: true })
      .limit(20);
    if (error) return null;
    const rows = data || [];
    return { count: rows.length, items: rows.map((r) => ({ title: r.title, price: r.price_kes, slug: r.slug })) };
  });

  const tenants = await read(async () => {
    const { data, error } = await sb.from('bot_tenants').select('id, is_active, status').limit(500);
    if (error) return null;
    return { active: (data || []).filter((t) => t.is_active !== false && String(t.status || 'active') === 'active').length };
  });

  const countOf = (table, filter) => read(async () => {
    let q = sb.from(table).select('id', { count: 'exact', head: true });
    if (filter) q = q.eq(filter.column, filter.value);
    const { count, error } = await q;
    if (error) return null;
    return { count: count || 0 };
  });

  const discovery = await countOf('discovery_submissions');
  const pages = await countOf('blog_posts', { column: 'status', value: 'published' });
  const offers = await countOf('opportunities', { column: 'status', value: 'published' });
  const packsSold = await countOf('digital_orders');

  const value = buildPlatformDossier({
    products,
    tenants,
    discovery,
    pages: pages ? { published: pages.count } : null,
    offers: offers ? { published: offers.count } : null,
    packsSold
  });
  cached = { at: Date.now(), value };
  return value;
}

export function clearPlatformCache() {
  cached = null;
}
