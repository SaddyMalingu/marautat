/**
 * The money routine (2026-11-19)
 *
 * One command that answers the only three questions a day of selling actually has:
 * who do I call, who owes me, and what do I send them. Read-only by construction:
 * nothing here writes, charges, or sends — the sending is a person's job, and this
 * prints the words to send.
 *
 *   node scripts/money_routine.mjs          # the routine
 *   node scripts/money_routine.mjs --json   # the same facts, for another tool
 *
 * Why it exists: on 2026-11-19 the repository had a live storefront, a live M-Pesa
 * lane and five built packs, and had taken zero orders — while two people who filled
 * in the discovery form nine days earlier, naming a budget, had never been answered.
 * The gap was not code. It was that nothing put those two facts on one screen.
 */
import 'dotenv/config';
import { requireSupabaseEnv } from '../utils/supabaseEnv.js';
import { recoveryQueue, recoveryMessage, settlementFor } from '../utils/digitalDrops.js';
import { offerLine } from '../utils/founderOffer.js';

const asJson = process.argv.slice(2).includes('--json');
const { url, key } = requireSupabaseEnv();
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(url, key);

const digits = (v) => String(v || '').replace(/\D/g, '');
const last9 = (v) => digits(v).slice(-9);
const money = (amount, currency = 'KES') => `${currency} ${Number(amount || 0).toLocaleString('en-KE')}`;
const daysAgo = (iso) => {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
};

// A missing table is a fact about the deployment, not a crash: the routine must still
// print the part of the picture that does exist.
const problems = [];
async function read(table, select, opts = {}) {
  let q = sb.from(table).select(select);
  if (opts.order) q = q.order(opts.order, { ascending: Boolean(opts.ascending) });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) {
    problems.push(`${table}: ${error.message}`);
    return [];
  }
  return data || [];
}

const [orders, products, submissions, tenants, tenantProducts, leads, requests] = await Promise.all([
  read('digital_orders', 'order_ref, product_slug, product_title, phone, amount, currency, status, lane, mpesa_receipt, paid_at, created_at, metadata', { order: 'created_at', limit: 5000 }),
  read('digital_products', 'slug, title, price_kes, price_usd, status, next_slug', { order: 'price_kes', ascending: true }),
  read('discovery_submissions', 'name, business_name, industry, phone, email, budget, timeline, challenges, status, submitted_at', { order: 'submitted_at', limit: 60 }),
  read('bot_tenants', 'id, client_name, client_phone, status, is_active'),
  read('bot_products', 'bot_tenant_id'),
  read('digital_leads', 'id, created_at'),
  read('service_requests', 'id, created_at'),
]);

const round = (n) => Math.round(n * 100) / 100;
const paidRows = orders.filter((o) => ['paid', 'delivered'].includes(String(o.status)));
const queue = recoveryQueue(orders, { now: new Date() });
const owedRefs = new Set(queue.items.map((i) => i.order_ref));
const collectedRows = paidRows.filter((o) => !owedRefs.has(o.order_ref));
const sumBy = (rows) => rows.reduce((total, o) => total + Number(o.amount || 0), 0);

const productCount = new Map();
for (const p of tenantProducts) {
  const id = String(p.bot_tenant_id || '');
  productCount.set(id, (productCount.get(id) || 0) + 1);
}

const activeTenants = tenants.filter((t) => t.is_active);
const emptyTenants = activeTenants.filter((t) => (productCount.get(String(t.id)) || 0) === 0);

// People who asked for the thing we sell and were never answered. Anything with a
// stocked catalogue drops off the list, because their next step is a renewal, not a
// first sale — and a call list that mixes the two stops being a call list.
//
// One row per phone number, newest first: the same person submitted the form three
// times on 2026-10-26 and a call list that shows them three times is a call list
// nobody finishes.
const seenPhone = new Set();
const callList = submissions
  .filter((s) => String(s.status || '') !== 'rejected')
  .sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')))
  .filter((s) => {
    const phoneKey = last9(s.phone) || String(s.email || '').toLowerCase();
    if (!phoneKey || seenPhone.has(phoneKey)) return false;
    seenPhone.add(phoneKey);
    return true;
  })
  .map((s) => {
    const phone9 = last9(s.phone);
    const tenant = phone9 ? activeTenants.find((t) => last9(t.client_phone) === phone9) || null : null;
    const onShelf = tenant ? (productCount.get(String(tenant.id)) || 0) : null;
    return {
      name: s.name || '(no name)',
      business: s.business_name || '',
      industry: s.industry || '',
      phone: s.phone || '',
      email: s.email || '',
      budget: s.budget || 'not stated',
      timeline: s.timeline || 'not stated',
      challenges: s.challenges || '',
      status: s.status || '',
      asked_days_ago: daysAgo(s.submitted_at),
      tenant: tenant ? tenant.client_name : null,
      catalogue: onShelf,
      ask: tenant
        ? (onShelf === 0
          ? `Catalogue empty: load their stock, one order end to end, then start the ${offerLine({ existing: true })}.`
          : 'Already selling: ask for the monthly founder\'s-package renewal.')
        : `No tenant yet: same-day pilot, then the founder's rate (walk-up is KES 3,000).`
    };
  })
  .filter((s) => s.catalogue === null || s.catalogue === 0)
  .sort((a, b) => (a.asked_days_ago == null ? 999 : a.asked_days_ago) - (b.asked_days_ago == null ? 999 : b.asked_days_ago));

const settlement = settlementFor(process.env, 'mpesa');
const payTo = {
  shortcode: String(process.env.MPESA_SHORTCODE || '').trim(),
  account: String(process.env.DROPS_RECOVERY_ACCOUNT || process.env.MPESA_SHORTCODE || '').trim(),
};
const supportNumber = digits(process.env.DROPS_SUPPORT_WHATSAPP || '');
const support = supportNumber
  ? 'https://wa.me/' + supportNumber.replace(/^0/, '254')
  : null;
if (asJson) {
  // The same facts without the colour, so another tool can read them. `problems` is
  // part of the payload: a report that silently omits a table it could not read looks
  // like a business with no orders.
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    host: url.replace(/^https?:\/\//, ''),
    settlement_mode: settlement,
    money: {
      booked: round(sumBy(paidRows)),
      collected: round(sumBy(collectedRows)),
      owed: round(sumBy(queue.items)),
      paid_orders: paidRows.length,
      orders: orders.length,
      leads: leads.length,
      service_requests: requests.length,
    },
    chase: queue,
    call_list: callList,
    products: products.map((p) => ({ slug: p.slug, title: p.title, price_kes: Number(p.price_kes || 0), status: p.status })),
    tenants: { active: activeTenants.length, with_empty_catalogue: emptyTenants.length },
    problems,
  }, null, 2));
  process.exit(0);
}



console.log(`\n-- Money routine, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC ---`);
console.log('   Read-only. Nothing here writes, charges or sends.');
console.log(`   Offer: ${offerLine({ existing: true })}`);
console.log('   Campaign copy: npm run tenants:campaign (messages + wa.me links, read-only)\n');

console.log('MONEY');
console.log(`   booked     ${money(sumBy(paidRows))} over ${paidRows.length} paid order(s)`);
console.log(`   collected  ${money(sumBy(collectedRows))}   owed  ${money(sumBy(queue.items))} over ${queue.count} order(s)`);
console.log(`   funnel     ${leads.length} free capture(s) · ${requests.length} build request(s) · ${orders.length} order attempt(s)`);
console.log(`   settlement ${settlement}${settlement === 'collected' ? '' : '   (MPESA_ENV is not "production")'}`);
if (settlement !== 'collected') {
  console.log('   !! every order paid today is reversed by Safaricom: it is a debt, not income.');
  console.log('      The pack still opens. Chase the money on a live channel; the client is not told why.');
}

console.log('\nTO CHASE');
if (!queue.count) {
  console.log('   nothing owed');
} else {
  for (const item of queue.items) {
    console.log(`   ${item.order_ref}  ${money(item.amount, item.currency)}  ${item.product_title}  ${item.phone}  (${item.age_days}d)`);
    for (const line of recoveryMessage({ order: item, payTo, support }).text.split('\n')) {
      console.log('      | ' + line);
    }
    console.log('');
  }
}

console.log('TO CALL');
if (!callList.length) {
  console.log('   nobody waiting — the discovery form is the top of the funnel; send traffic at it');
} else {
  callList.forEach((s, i) => {
    console.log(`   ${i + 1}. ${s.name}${s.business ? ' — ' + s.business : ''}  (${s.industry || 'no industry'})`);
    console.log(`      budget ${s.budget} · ${s.timeline} · asked ${s.asked_days_ago}d ago · status ${s.status}`);
    console.log(`      ${s.phone || 'no phone'} · ${s.email || 'no email'}`);
    console.log(`      needs: ${s.challenges || 'not stated'}`);
    if (s.tenant) console.log(`      tenant "${s.tenant}" exists with ${s.catalogue} product(s)`);
    console.log(`      ask: ${s.ask}`);
    console.log('');
  });
}

console.log('TO SEND');
const live = products.filter((p) => String(p.status || '') === 'published');
if (!live.length) console.log('   no published products — run npm run drops:publish -- --apply');
for (const p of live) {
  console.log(`   /drops/${p.slug}  ${money(p.price_kes)}${p.price_usd ? ' / $' + p.price_usd : ''}  ${p.title}`);
}
console.log('   /founders-package.html  the offer page every tenant message links to');

console.log('\nTENANTS');
console.log(`   ${activeTenants.length} active · ${emptyTenants.length} with an empty catalogue (nothing to sell, so nothing to pay for)`);
for (const t of emptyTenants.slice(0, 6)) {
  console.log(`   - ${t.client_name} (${t.client_phone})`);
}
if (emptyTenants.length > 6) console.log(`   … and ${emptyTenants.length - 6} more`);

if (problems.length) {
  console.log('\nCOULD NOT READ');
  for (const p of problems) console.log('   - ' + p);
}

console.log('\nNext: two calls, then the chase list, then the pack link. Nothing else pays today.\n');
