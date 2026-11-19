/**
 * The revenue hunt (2026-11-19)
 *
 * `money:routine` says where the money is. This says what to do in the next 24 hours, in
 * order, with the message to send — computed from what the system already knows:
 *
 *   1. someone wrote and nobody answered      → reply now, the 24h window is open
 *   2. an owner was messaged and went quiet   → the day-2 proof
 *   3. clicks without a pack                  → the pack, in front of that traffic
 *   4. a catalogue exists and no order does   → one order end to end
 *   5. approved discovery without a portal    → issue the link
 *
 * Read-only: it never sends, never writes. Aggression belongs in the follow-up, not in
 * the tooling.  node scripts/revenue_hunt.mjs [--json]
 */
import 'dotenv/config';
import { requireSupabaseEnv } from '../utils/supabaseEnv.js';
import { offerLine } from '../utils/founderOffer.js';

const asJson = process.argv.slice(2).includes('--json');
const { url, key } = requireSupabaseEnv();
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(url, key);

const digits = (v) => String(v || '').replace(/\D/g, '');
const last9 = (v) => digits(v).slice(-9);
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

const read = async (fn) => {
  try {
    const { data, error } = await fn();
    return error ? [] : (data || []);
  } catch {
    return [];
  }
};

const [tenants, products, orders, leads, submissions, clicks, convos] = await Promise.all([
  read(() => sb.from('bot_tenants').select('id, client_name, client_phone, portal_token, is_active, status').limit(300)),
  read(() => sb.from('bot_products').select('bot_tenant_id, sku').limit(1000)),
  read(() => sb.from('bot_orders').select('bot_tenant_id, total_amount, status').limit(500)),
  read(() => sb.from('digital_leads').select('id, created_at').limit(200)),
  read(() => sb.from('discovery_submissions').select('id, name, business_name, phone, status').limit(200)),
  read(() => sb.from('analytics_clicks').select('page_path, click_type').gte('created_at', hoursAgo(24 * 7)).limit(3000)),
  read(() => sb.from('conversations').select('direction, created_at').gte('created_at', hoursAgo(48)).limit(1000))
]);

const count = (rows, id) => rows.filter((r) => String(r.bot_tenant_id) === String(id)).length;
const active = tenants.filter((t) => t.is_active !== false && String(t.status || 'active') === 'active');
const inbound24 = convos.filter((c) => c.direction === 'incoming' && c.created_at >= hoursAgo(24));
const outbound24 = convos.filter((c) => c.direction === 'outgoing' && c.created_at >= hoursAgo(24));
const kitClicks = clicks.filter((c) => c.click_type === 'kit_offer').length;
const applyClicks = clicks.filter((c) => c.click_type === 'apply').length;
const paidOrders = orders.filter((o) => ['paid', 'delivered', 'completed'].includes(String(o.status || '').toLowerCase()));

const actions = [];
const add = (score, title, why, doThis) => actions.push({ score, title, why, doThis });


// 1 · an unanswered human is the only thing worth doing first
if (inbound24.length) {
  add(100, inbound24.length + ' message(s) from a human in the last 24h',
    'They wrote. The 24-hour window is open right now and closes on its own.',
    'Reply personally today: business name + portal link + "send your list like: Omo 1kg | 320 | 12".');
} else if (outbound24.length) {
  add(90, 'You messaged in 24h and nobody has answered yet',
    'The campaign landed; the day-2 proof is the message that earns a reply.',
    'Send the USD 566 proof: npm run tenants:campaign -- --step proof');
}

// 2 · intent that reached a click but not money
if (kitClicks && !paidOrders.length) {
  add(85, kitClicks + ' pack click(s) in 7 days, 0 paid order(s)',
    'Intent without checkout — every click is a person who wanted the pack.',
    'Sell it by hand: "you looked at the kit — send KES 1,500 and I will open it now."');
} else if (applyClicks && !kitClicks) {
  add(80, applyClicks + ' apply click(s), 0 pack click(s)',
    'Readers press Apply and leave for the marketplace; the pack line shipped today and nobody has taken it.',
    'Put /drops/ai-work-application-kit in front of the traffic you control — one post, one broadcast.');
}

// 3 · stock and no order: the demo that closes the other eleven
const stocked = active.filter((t) => count(products, t.id) > 0);
const stockedNoOrders = stocked.filter((t) => count(orders, t.id) === 0);
if (stockedNoOrders.length) {
  add(75, stockedNoOrders.length + ' tenant(s) have stock and no order',
    stockedNoOrders.map((t) => t.client_name + ' (' + count(products, t.id) + ' products)').join(', ')
      + ' — one real order is the proof every other tenant is sold with.',
    'Take one order end to end on ' + stockedNoOrders[0].client_name
      + ': bot → /tenant/orders → M-Pesa. Screenshot it.');
}

// 4 · approved, no portal link: a warm lead with a locked door
const approvedNoLink = submissions.filter((s) => String(s.status) === 'approved')
  .filter((s) => !active.some((t) => last9(t.client_phone) === last9(s.phone) && t.portal_token));
if (approvedNoLink.length) {
  add(70, approvedNoLink.length + ' approved business(es) without a working portal link',
    approvedNoLink.slice(0, 4).map((s) => s.business_name || s.name).join(', '),
    'Issue the link, then the day-0 message: POST /admin/api/tenants/:id/portal-link');
}

// 5 · the empty shelf, which is why the fee cannot start
const empty = active.filter((t) => count(products, t.id) === 0);
if (empty.length) {
  add(60, empty.length + ' tenant(s) still have an empty catalogue',
    'An empty shop cannot be invoiced, so the monthly fee never starts.',
    'Ask each for one photo of their price list; load it with npm run catalog:import -- --tenant <phone>');
}

// 6 · the fee itself
add(50, 'Start the first ' + offerLine({ existing: true }),
  'Nobody has been invoiced. The price is fixed and the page is live.',
  'Invoice the first tenant who has taken an order, with /founders-package.html attached.');

actions.sort((a, b) => b.score - a.score);

if (asJson) {
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    counts: { active: active.length, inbound24: inbound24.length, applyClicks, kitClicks, paidOrders: paidOrders.length, leads: leads.length },
    actions
  }, null, 2));
  process.exit(0);
}

console.log('\n-- Revenue hunt · ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC ---');
console.log('   ' + active.length + ' active tenant(s) · ' + applyClicks + ' apply click(s)/7d · '
  + kitClicks + ' pack click(s)/7d · ' + paidOrders.length + ' paid order(s) · ' + leads.length + ' captured lead(s)');
console.log('   Read-only. Nothing here sends anything.\n');

actions.forEach((a, i) => {
  console.log((i + 1) + '. [' + a.score + '] ' + a.title);
  console.log('     why: ' + a.why);
  console.log('     do:  ' + a.doThis);
  console.log('');
});

console.log('Aggressive means the first two items today, not all six. The rest is the queue.\n');
