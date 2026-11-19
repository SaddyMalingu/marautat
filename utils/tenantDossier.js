/**
 * What the bot knows about a tenant's business (2026-11-19)
 *
 * The reply path already had the tenant's name, voice, catalogue matches and a lead
 * coach, but nothing about the *business*: how many orders exist, what the shop is
 * worth, whether a campaign has ever run, when the last customer wrote. So a tenant
 * owner asking "how is my shop doing?" got a polite nothing, and the bot could not
 * suggest the next action because it did not know the last one.
 *
 * Two rules shape this file:
 *
 * 1. **Owner only.** A customer messaging a tenant's number must never receive the
 *    business's numbers. The dossier is attached when the *sender* is the tenant's own
 *    phone (or the named point of contact), and in no other case.
 * 2. **Bounded and never fatal.** Every query has a limit, the rendered block is capped,
 *    and a failing table degrades to "unknown" rather than breaking a reply. A bot that
 *    goes silent because `wf_campaigns` is missing is worse than one that says it does
 *    not know.
 *
 * Pure rendering (`buildDossier`) is separate from IO (`loadDossier`) so the text can be
 * tested without a database.
 */

export const DOSSIER_TTL_MS = 5 * 60 * 1000;
export const MAX_BLOCK_CHARS = 1800;

const cache = new Map();

const digits = (v) => String(v || '').replace(/\D/g, '');
const last9 = (v) => digits(v).slice(-9);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** Totals read as 1,284 in a chat, not 1284. */
const count = (v) => num(v).toLocaleString('en-KE');
const kes = (n) => 'KES ' + Math.round(num(n)).toLocaleString('en-KE');

/** Is this sender the owner (or the named contact) of that tenant? */
export function isOwnerPhone(tenant, phone) {
  const who = last9(phone);
  if (!tenant || !who) return false;
  return [tenant.client_phone, tenant.point_of_contact_phone]
    .map(last9)
    .filter(Boolean)
    .includes(who);
}

function daysSince(iso, now) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor(((now ? new Date(now) : new Date()).getTime() - t) / 86400000));
}

/** "today" / "3 day(s) ago" — a date string means nothing in a chat reply. */

/**
 * Render the block the model reads.
 *
 * `unknown` is rendered as "unknown", never as 0 — "0 orders" and "we could not read the
 * orders" are different facts, and a bot that confuses them will confidently tell an
 * owner their shop has never sold anything.
 */
export function buildDossier({
  tenant = {},
  catalogue = null,
  orders = null,
  conversations = null,
  campaigns = null,
  leads = null,
  posts = null,
  offers = null,
  discovery = null,
  now = new Date()
} = {}) {
  const lines = [];
  const gaps = [];

  lines.push('BUSINESS SNAPSHOT — ' + (tenant.client_name || 'this business'));
  lines.push('You are speaking with the OWNER of this business. These are their own numbers: use them, never invent one, and do not recite them as a list unless asked.');

  // ---- catalogue -------------------------------------------------------------
  if (catalogue && Number.isFinite(Number(catalogue.count))) {
    const active = Number(catalogue.active || 0);
    if (active === 0) {
      lines.push('Catalogue: EMPTY — nothing is on the shelf, so the bot cannot sell anything.');
      gaps.push('load the catalogue (a price list like "Omo 1kg | 320 | 12" is enough)');
    } else {
      lines.push('Catalogue: ' + active + ' active product(s), ' + kes(catalogue.stock_value) + ' of stock'
        + (Number(catalogue.out_of_stock || 0) ? ', ' + catalogue.out_of_stock + ' out of stock' : '')
        + (catalogue.top ? ' · dearest: ' + catalogue.top : ''));
    }
  } else {
    lines.push('Catalogue: unknown (could not be read)');
  }

  // ---- orders ---------------------------------------------------------------
  if (orders && Number.isFinite(Number(orders.count))) {
    if (Number(orders.count) === 0) {
      lines.push('Orders: none recorded yet.');
      gaps.push('take one order end to end so the shop is proven');
    } else {
      lines.push('Orders: ' + count(orders.count) + ' recorded, ' + kes(orders.value) + ' across completed ones'
        + (orders.paid && Number(orders.paid) !== Number(orders.count) ? ' (' + count(orders.paid) + ' marked paid)' : '')
        + (orders.last_at ? ' · last ' + ago(orders.last_at, now) : ''));
    }
  } else {
    lines.push('Orders: unknown (could not be read)');
  }

  // ---- conversations --------------------------------------------------------
  // A tenant with no line of its own has nothing to count, and saying so is more useful
  // than "unknown": it is the first thing that has to be true before the bot can sell.
  const hasLine = tenant.whatsapp_phone_number_id
    && !/^pending:/i.test(String(tenant.whatsapp_phone_number_id));
  if (!hasLine) {
    lines.push('WhatsApp: no dedicated line configured yet — the bot cannot answer this business\'s customers.');
    gaps.push('connect the business WhatsApp number (Meta phone id + token in the portal)');
  } else if (conversations && Number.isFinite(Number(conversations.total))) {
    lines.push('WhatsApp: ' + count(conversations.total) + ' message(s) stored, '
      + count(conversations.inbound) + ' from customers, '
      + count(conversations.last_7d) + ' in the last 7 days'
      + (conversations.last_at ? ' · last ' + ago(conversations.last_at, now) : ''));
  } else if (hasLine) {
    // The line exists but the messages are not attributed to this tenant yet: say that,
    // rather than "unknown", so nobody reads it as "no customers have written".
    lines.push('WhatsApp: line connected; message history is not attributed to this tenant yet.');
  } else {
    lines.push('WhatsApp: unknown (could not be read)');
  }

  // ---- Writer's Flow --------------------------------------------------------
  if (campaigns && Number.isFinite(Number(campaigns.count))) {
    if (Number(campaigns.count) === 0) {
      lines.push("Writer's Flow: no campaign has been run yet.");
      gaps.push("run one Writer's Flow campaign and show the leads it finds");
    } else {
      lines.push("Writer's Flow: " + count(campaigns.count) + ' campaign(s), '
        + count(campaigns.leads_found) + ' lead(s) found, '
        + count(campaigns.outreach_sent) + ' outreach message(s) sent'
        + (campaigns.last_run_at ? ' · last run ' + ago(campaigns.last_run_at, now) : ''));
    }
  } else {
    lines.push("Writer's Flow: unknown (could not be read)");
  }
  if (leads && Number.isFinite(Number(leads.count)) && Number(leads.count) > 0) {
    lines.push('Leads: ' + count(leads.count) + ' captured'
      + (leads.qualified ? ' (' + count(leads.qualified) + ' qualified)' : ''));
  }

  // ---- discovery ------------------------------------------------------------
  // Someone who filled the form told us their industry, budget and what hurts. Asking
  // again is the fastest way to look like nobody read it (2026-11-19).
  if (discovery && discovery.found) {
    const bits = [];
    if (discovery.industry) bits.push(discovery.industry);
    if (discovery.budget) bits.push('budget ' + discovery.budget);
    if (discovery.timeline) bits.push(discovery.timeline);
    lines.push('Discovery form: submitted ' + (ago(discovery.submitted_at, now) || 'recently')
      + ' — ' + (bits.join(' · ') || 'no detail given')
      + (discovery.challenges ? ' · asked for: ' + discovery.challenges : '')
      + (discovery.status ? ' · status ' + discovery.status : ''));
    if (String(discovery.status).toLowerCase() === 'new') {
      gaps.push('approve their discovery submission so a portal link can be issued');
    }
    if (String(discovery.status).toLowerCase() === 'approved' && !tenant.portal_token) {
      gaps.push('send their portal link (it has been approved)');
    }
  }

  // ---- content --------------------------------------------------------------
  if (posts && Number.isFinite(Number(posts.published))) {
    const titles = Array.isArray(posts.titles) ? posts.titles.slice(0, 3) : [];
    lines.push('Content: ' + count(posts.published) + ' published page(s)'
      + (titles.length
        ? ' — ' + titles.join(' · ')
          + (posts.published > titles.length ? ' · +' + count(posts.published - titles.length) + ' more' : '')
        : '')
      + (posts.newest_at ? ' · newest ' + ago(posts.newest_at, now) : ''));
  }
  if (offers && Number.isFinite(Number(offers.published))) {
    lines.push('Live offers behind those pages: ' + count(offers.published) + '.');
  }

  // ---- what to do next ------------------------------------------------------
  // The bot's most useful sentence is not a number, it is the next action — and the gaps
  // are the only reason to have read any of the above.
  if (gaps.length) lines.push('Next actions you may offer: ' + gaps.join('; ') + '.');

  const text = lines.join('\n');
  return {
    text: text.length > MAX_BLOCK_CHARS ? text.slice(0, MAX_BLOCK_CHARS) + '…' : text,
    gaps
  };
}

/**
 * Read the business, tolerantly.
 *
 * Every table is read inside its own try: one missing column or empty table must not
 * cost the owner their reply. The result is cached for five minutes, because a
 * conversation is a burst of messages and the numbers do not change between them.
 */
export async function loadDossier(sb, tenant, { now = new Date(), ttlMs = DOSSIER_TTL_MS } = {}) {
  if (!sb || !tenant || !tenant.id) return null;
  const hit = cache.get(tenant.id);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;

  const read = async (fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };

  const products = await read(async () => {
    const { data, error } = await sb
      .from('bot_products')
      .select('sku, name, price, stock_count, is_active')
      .eq('bot_tenant_id', tenant.id)
      .limit(500);
    if (error) return null;
    const rows = data || [];
    const active = rows.filter((r) => r.is_active !== false);
    const stockValue = active.reduce((sum, r) => sum + num(r.price) * num(r.stock_count), 0);
    const dearest = active.slice().sort((a, b) => num(b.price) - num(a.price))[0];
    return {
      count: rows.length,
      active: active.length,
      stock_value: stockValue,
      out_of_stock: active.filter((r) => num(r.stock_count) <= 0).length,
      top: dearest ? dearest.name + ' (' + kes(dearest.price) + ')' : null
    };
  });

  const orders = await read(async () => {
    const { data, error } = await sb
      .from('bot_orders')
      .select('status, total_amount, currency, created_at')
      .eq('bot_tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return null;
    const rows = data || [];
    const paidStates = ['paid', 'completed', 'fulfilled', 'delivered'];
    const paid = rows.filter((r) => paidStates.includes(String(r.status || '').toLowerCase()));
    return {
      count: rows.length,
      paid: paid.length,
      value: rows.reduce((sum, r) => sum + (paidStates.includes(String(r.status || '').toLowerCase()) ? num(r.total_amount) : 0), 0),
      last_at: rows[0]?.created_at || null
    };
  });

  const conversations = await read(async () => {
    if (!tenant.brand_id) return null;
    const { data, error } = await sb
      .from('conversations')
      .select('direction, created_at')
      .eq('brand_id', tenant.brand_id)
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) return null;
    const rows = data || [];
    const weekAgo = new Date((now || new Date()).getTime() - 7 * 86400000);
    return {
      total: rows.length,
      inbound: rows.filter((r) => String(r.direction) === 'incoming').length,
      last_7d: rows.filter((r) => new Date(r.created_at) >= weekAgo).length,
      last_at: rows[0]?.created_at || null
    };
  });

  const campaigns = await read(async () => {
    const { data, error } = await sb
      .from('wf_campaigns')
      .select('id, status, total_leads_found, total_outreach_sent, last_run_at')
      .eq('tenant_id', tenant.id)
      .limit(50);
    if (error) return null;
    const rows = data || [];
    const lastRun = rows.map((r) => r.last_run_at).filter(Boolean).sort().pop() || null;
    return {
      count: rows.length,
      leads_found: rows.reduce((s, r) => s + num(r.total_leads_found), 0),
      outreach_sent: rows.reduce((s, r) => s + num(r.total_outreach_sent), 0),
      last_run_at: lastRun,
      ids: rows.map((r) => r.id)
    };
  });

  const leads = await read(async () => {
    if (!campaigns || !campaigns.ids?.length) return null;
    const { data, error } = await sb
      .from('wf_leads')
      .select('id, status')
      .in('campaign_id', campaigns.ids)
      .limit(1000);
    if (error) return null;
    const rows = data || [];
    return {
      count: rows.length,
      qualified: rows.filter((r) => /qualified|approved|contacted|replied/i.test(String(r.status || ''))).length
    };
  });

  const posts = await read(async () => {
    const { data, error } = await sb
      .from('blog_posts')
      .select('id, title, slug, status, created_at')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return null;
    const rows = data || [];
    const published = rows.filter((r) => /publish/i.test(String(r.status || '')));
    return {
      published: published.length,
      titles: published.map((r) => r.title).filter(Boolean),
      newest_at: published[0]?.created_at || null
    };
  });

  // The offers behind those pages: published opportunities owned by this tenant.
  const offers = await read(async () => {
    const { count, error } = await sb
      .from('opportunities')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('status', 'published');
    if (error) return null;
    return { published: count || 0 };
  });

  // What they told us in the discovery form, if this tenant ever filled one.
  const discovery = await read(async () => {
    const phone = String(tenant.client_phone || '').replace(/\D/g, '').slice(-9);
    if (!phone) return null;
    const { data, error } = await sb
      .from('discovery_submissions')
      .select('business_name, industry, budget, timeline, challenges, status, submitted_at, phone')
      .limit(200);
    if (error) return null;
    const hit = (data || []).find((r) => String(r.phone || '').replace(/\D/g, '').slice(-9) === phone);
    if (!hit) return { found: false };
    return {
      found: true,
      industry: hit.industry || '',
      budget: hit.budget || '',
      timeline: hit.timeline || '',
      challenges: hit.challenges || '',
      status: hit.status || '',
      submitted_at: hit.submitted_at || null
    };
  });

  const value = buildDossier({
    tenant,
    catalogue: products,
    orders,
    conversations,
    campaigns,
    leads,
    posts,
    offers,
    discovery,
    now
  });
  cache.set(tenant.id, { at: Date.now(), value });
  return value;
}

/** Used by the CLI after a write, so the next message does not read a stale snapshot. */
export function clearDossierCache(tenantId = null) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

function ago(iso, now) {
  const d = daysSince(iso, now);
  if (d === null) return '';
  return d === 0 ? 'today' : d + ' day(s) ago';
}
