#!/usr/bin/env node

/**
 * The drops flow, end to end, against a fake database — 2026-11-10.
 *
 * `test_digital_drops.mjs` proves the rules and reads the route source; this
 * proves the wiring. It mounts the real router, buys a real product with a fake
 * STK push, fires a Safaricom-shaped callback, and then tries to break in.
 *
 * What only a live request can show:
 *   - the price in the M-Pesa prompt comes from the catalogue row, not the body
 *   - the callback marks the order delivered, issues one entitlement, and
 *     messages the buyer exactly once
 *   - a replayed callback changes nothing
 *   - the buyer's lookup secret reads their own order and nobody else's
 *   - a tampered access token is refused before any file is touched
 *   - the pack downloads only through the token, and stats net off the fee
 *
 * No network, no Supabase, no Safaricom, no WhatsApp. Exit 1 on any failure.
 * Usage: npm run test:drops:flow
 */
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createDropsRouter } from '../routes/drops.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const products = JSON.parse(fs.readFileSync(path.join(root, 'data', 'drops_catalog.json'), 'utf8')).products;
const db = {
  digital_products: products.map((p, i) => ({ id: 'p' + i, ...p, payment_lane: p.payment_lane || 'both' })),
  digital_orders: [],
  digital_entitlements: [],
  digital_events: [],
  service_requests: [],
};
let seq = 0;

function q(table) {
  const state = { table, op: 'select', filters: [], values: null, limit: 1000 };
  const match = (row) => state.filters.every(([k, v, kind]) => {
    if (kind === 'in') return v.includes(row[k]);
    if (kind === 'gte') return String(row[k]) >= String(v);
    return String(row[k]) === String(v);
  });
  const exec = () => {
    const rows = db[table] || [];
    if (state.op === 'select') return { data: rows.filter(match).slice(0, state.limit), error: null };
    if (state.op === 'insert') {
      const added = state.values.map((v) => ({ id: 'row' + (++seq), created_at: new Date().toISOString(), ...v }));
      rows.push(...added);
      return { data: added, error: null };
    }
    if (state.op === 'update') {
      const touched = [];
      for (const r of rows) if (match(r)) { Object.assign(r, state.values); touched.push(r); }
      return { data: touched, error: null };
    }
    if (state.op === 'upsert') {
      const touched = [];
      for (const v of state.values) {
        const found = rows.find((r) => r.order_id === v.order_id && r.product_slug === v.product_slug);
        if (found) { Object.assign(found, v); touched.push(found); }
        else { const added = { id: 'row' + (++seq), created_at: new Date().toISOString(), ...v }; rows.push(added); touched.push(added); }
      }
      return { data: touched, error: null };
    }
    return { data: [], error: null };
  };
  const api = {
    select() { return api; },
    insert(v) { state.op = 'insert'; state.values = v; return api; },
    update(v) { state.op = 'update'; state.values = v; return api; },
    upsert(v) { state.op = 'upsert'; state.values = v; return api; },
    eq(k, v) { state.filters.push([k, v, 'eq']); return api; },
    in(k, v) { state.filters.push([k, v, 'in']); return api; },
    gte(k, v) { state.filters.push([k, v, 'gte']); return api; },
    order() { return api; },
    limit(n) { state.limit = n; return api; },
    maybeSingle() { const r = exec(); return Promise.resolve({ data: r.data[0] || null, error: null }); },
    single() { const r = exec(); return Promise.resolve({ data: r.data[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
  };
  return api;
}
const supabase = { from: (t) => q(t) };

const stkCalls = [];
const messages = [];
const emails = [];
const CARD_SECRET = 'whsec-smoke';
const app = express();
// Mirrors server.js: the raw body is what a provider's signature is computed over.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf ? buf.toString('utf8') : ''; } }));
app.use('/', createDropsRouter({
  supabase,
  initiateStkPush: async (args) => { stkCalls.push(args); return { CheckoutRequestID: 'cid-1', MerchantRequestID: 'mid-1' }; },
  sendMessage: async (to, text) => { messages.push({ to, text }); return true; },
  sendEmail: async (args) => { emails.push(args); return { ok: true, messageId: 'msg-1' }; },
  log: () => {},
  env: {
    DROPS_TOKEN_SECRET: 'smoke-secret',
    ADMIN_PASS: 'smoke-admin',
    DROPS_SUPPORT_WHATSAPP: '0712345678',
    DROPS_CARD_LINK: 'https://pay.example.com/checkout',
    DROPS_CARD_WEBHOOK_SECRET: CARD_SECRET,
  },
}));

const srv = http.createServer(app);
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};
const getJson = async (p) => {
  const r = await fetch(base + p);
  const text = await r.text();
  let body = {};
  try { body = JSON.parse(text); } catch (_) {}
  return { status: r.status, body, text };
};
const getText = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
const postJson = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const page = await getText('/drops');
ok('GET /drops serves the storefront', page.status === 200 && page.text.includes('Digital drops'));
ok('GET /drops/<slug> serves the same page', (await getText('/drops/ai-agent-ops-track')).status === 200);

const catalog = await getJson('/api/drops');
ok('GET /api/drops lists five published products', catalog.status === 200 && catalog.body.products.length === 5, String(catalog.body.products && catalog.body.products.length));
ok('the catalogue comes from the database when it is there', catalog.body.source === 'db', catalog.body.source);

const health = await getJson('/api/drops/health');
ok('the health endpoint answers without a key', health.status === 200);
ok('health reports where the token secret comes from', health.body.configured.token_secret_source === 'DROPS_TOKEN_SECRET', health.body.configured.token_secret_source);
ok('health reports the admin key is on the ADMIN_PASS fallback', health.body.configured.admin_key_source === 'ADMIN_PASS', health.body.configured.admin_key_source);
ok('health fingerprints the explicit token secret', /^sha256:[0-9a-f]{12}$/.test(String(health.body.fingerprints.token_secret)), health.body.fingerprints.token_secret);
ok('health refuses to fingerprint a fallback password', health.body.fingerprints.admin_key === null);
ok('health never returns a secret value', !health.text.includes('smoke-secret') && !health.text.includes('smoke-admin'));
ok('health reports the catalogue source and card lane', health.body.catalogue.source === 'db' && health.body.lanes.card === true);


const detail = await getJson('/api/drops/ai-agent-ops-track');
ok('a product page carries its bump', detail.status === 200 && detail.body.bump && detail.body.bump.slug === 'repo-build-log-2026');
ok('an unknown product is a 404', (await getJson('/api/drops/nope')).status === 404);

const badPhone = await postJson('/api/drops/ai-agent-ops-track/checkout', { phone: '0112345678', amount: 10 });
ok('checkout refuses an unusable phone', badPhone.status === 400);

const checkout = await postJson('/api/drops/ai-agent-ops-track/checkout', { phone: '0712345678' });
ok('checkout returns 200 with an order reference', checkout.status === 200 && checkout.body.orderRef, JSON.stringify(checkout.body));
ok('the amount comes from the catalogue, not the request', checkout.body.amount === 12000, String(checkout.body.amount));
ok('the STK call carries this lane\'s callback', stkCalls.length === 1 && stkCalls[0].callbackUrl.endsWith('/drops/mpesa/callback'), JSON.stringify(stkCalls[0]));
ok('the account reference is the order reference', stkCalls[0].accountRef === checkout.body.orderRef);
ok('the order row is stored as prompted', db.digital_orders[0].status === 'prompted' && db.digital_orders[0].checkout_request_id === 'cid-1');

const bumpCheckout = await postJson('/api/drops/repo-build-log-2026/checkout', { phone: '0712345679', bump: true });
ok('a bump is priced from its own row', bumpCheckout.body.amount === 2500, String(bumpCheckout.body.amount));
const tapped = await postJson('/api/drops/ai-agent-ops-track/checkout', { phone: '0712345678' });
ok('a double tap reuses the open order', tapped.body.reused === true && tapped.body.orderRef === checkout.body.orderRef, JSON.stringify(tapped.body));

const callback = await postJson('/drops/mpesa/callback', {
  Body: { stkCallback: {
    CheckoutRequestID: 'cid-1', ResultCode: 0, ResultDesc: 'ok',
    CallbackMetadata: { Item: [
      { Name: 'MpesaReceiptNumber', Value: 'QK12ABC34' },
      { Name: 'Amount', Value: 12000 },
      { Name: 'PhoneNumber', Value: 254712345678 },
    ] },
  } },
});
ok('the callback acknowledges', callback.status === 200 && callback.body.ResultCode === 0);
ok('the order is marked delivered', db.digital_orders[0].status === 'delivered' && db.digital_orders[0].mpesa_receipt === 'QK12ABC34');
ok('exactly one entitlement was issued', db.digital_entitlements.length === 1, String(db.digital_entitlements.length));
ok('the buyer was messaged with the access link', messages.length === 1 && messages[0].text.includes('/drops/access/'), JSON.stringify(messages[0]));

const poll = await getJson('/api/drops/order/' + checkout.body.orderRef + '?lookup=' + encodeURIComponent(checkout.body.lookup));
ok('the buyer can poll their own order', poll.status === 200 && poll.body.status === 'delivered');
ok('the poll returns the access path', poll.body.access && poll.body.access[0].path.startsWith('/drops/access/'));
ok('a wrong lookup cannot read the order', (await getJson('/api/drops/order/' + checkout.body.orderRef + '?lookup=nope')).status === 404);

await postJson('/drops/mpesa/callback', { Body: { stkCallback: { CheckoutRequestID: 'cid-1', ResultCode: 0 } } });
ok('a replayed callback issues no second entitlement', db.digital_entitlements.length === 1, String(db.digital_entitlements.length));
ok('a replayed callback sends no second message', messages.length === 1, String(messages.length));

const token = db.digital_entitlements[0].token;
const access = await getJson('/api/drops/access/' + encodeURIComponent(token));
ok('the access page names the pack', access.status === 200 && access.body.product.title === 'AI Agent Ops Track');
ok('the access page exposes the file behind the token', access.body.file === '/api/drops/access/' + encodeURIComponent(token) + '/file');
const file = await getText('/api/drops/access/' + encodeURIComponent(token) + '/file');
ok('the pack itself downloads', file.status === 200 && file.text.includes('AI Agent Ops Track'));
ok('a tampered token is refused', (await getJson('/api/drops/access/' + encodeURIComponent(token.slice(0, -2) + 'xx'))).status === 403);

const stats = await getJson('/api/drops/stats?key=smoke-admin');
ok('stats are readable with the admin key', stats.status === 200 && stats.body.paid_orders === 1, JSON.stringify(stats.body));
ok('stats subtract the collection fee', stats.body.net === Math.round((12000 - 118.8) * 100) / 100, String(stats.body.net));
ok('stats are closed without a key', (await getJson('/api/drops/stats?key=wrong')).status === 403);

const late = await postJson('/drops/mpesa/callback', { Body: { stkCallback: { CheckoutRequestID: 'cid-1', ResultCode: 1032, ResultDesc: 'cancelled' } } });
ok('a late failure cannot undo a delivery', late.status === 200 && db.digital_orders[0].status === 'delivered');

console.log('\n-- card lane, end to end');
const crypto = await import('crypto');
const sign = (s) => crypto.createHmac('sha256', CARD_SECRET).update(s).digest('hex');
const postRaw = async (p, bodyString, headers = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: bodyString });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const cat2 = await getJson('/api/drops');
ok('the catalogue advertises the card lane', Boolean(cat2.body.lanes && cat2.body.lanes.card));
const det2 = await getJson('/api/drops/ai-agent-ops-track');
ok('a product lists both lanes', (det2.body.product.lanes || []).join(',') === 'mpesa,card', JSON.stringify(det2.body.product.lanes));

ok('a card checkout needs an email', (await postJson('/api/drops/ai-agent-ops-track/checkout-card', {})).status === 400);
const cardCheckout = await postJson('/api/drops/ai-agent-ops-track/checkout-card', { email: 'Dana@Shop.co' });
ok('a card checkout returns a hosted URL', cardCheckout.status === 200 && /^https:\/\/pay\.example\.com\/checkout\?ref=DRP-/.test(cardCheckout.body.checkoutUrl || ''), JSON.stringify(cardCheckout.body));
ok('the card order is priced in USD from the catalogue', cardCheckout.body.amount === 99 && cardCheckout.body.currency === 'USD');
const cardOrder = db.digital_orders.find((o) => o.order_ref === cardCheckout.body.orderRef);
ok('the card order stores the email, not a phone', cardOrder.customer_email === 'dana@shop.co' && !cardOrder.phone);
ok('the card order is on the card lane and pending', cardOrder.lane === 'card' && cardOrder.status === 'pending');

const payload = JSON.stringify({ order_ref: cardCheckout.body.orderRef, status: 'completed', amount: 99, currency: 'USD', transaction_id: 'tx-99', provider: 'paddle' });
ok('an unsigned webhook is refused', (await postRaw('/drops/card/webhook', payload)).status === 401);
ok('a mis-signed webhook is refused', (await postRaw('/drops/card/webhook', payload, { 'x-drops-signature': 'nope' })).status === 401);
const hooked = await postRaw('/drops/card/webhook', payload, { 'x-drops-signature': sign(payload) });
ok('a signed webhook delivers', hooked.status === 200 && hooked.body.status === 'delivered', JSON.stringify(hooked.body));
ok('the card order is delivered', db.digital_orders.find((o) => o.order_ref === cardCheckout.body.orderRef).status === 'delivered');
ok('an entitlement was issued for the card order', db.digital_entitlements.some((e) => e.order_ref === cardCheckout.body.orderRef));
ok('the card buyer was emailed the access link', emails.length === 1 && emails[0].to === 'dana@shop.co' && emails[0].text.includes('/drops/access/'));
ok('no WhatsApp went to a card buyer', messages.length === 1, String(messages.length));
ok('a replayed webhook is a no-op', (await postRaw('/drops/card/webhook', payload, { 'x-drops-signature': sign(payload) })).body.duplicate === true);
ok('a replayed webhook sends no second email', emails.length === 1, String(emails.length));

const stats2 = await getJson('/api/drops/stats?key=smoke-admin');
ok('stats separate KES from USD', stats2.body.by_currency.length === 2, JSON.stringify(stats2.body.by_currency));
ok('stats show the card lane', stats2.body.by_lane.some((l) => l.lane === 'card'));

console.log('\n-- funnel build request');
const buildPage = await getText('/build');
ok('GET /build serves the proposal page', buildPage.status === 200 && buildPage.text.includes('Ask for a written scope'));
ok('a proposal request without a budget is refused', (await postJson('/api/service-requests', {
  name: 'Dana', email: 'dana@shop.co', sell: 'We sell pumps to farms.', budget: 'nonsense', timeline: 'now',
})).status === 400);
const okReq = await postJson('/api/service-requests', {
  name: 'Dana Reed', email: 'dana@shop.co', company: 'Shop Co', country: 'United States',
  sell: 'We sell industrial water pumps to farms.', channel: 'WhatsApp', problem: 'Quotes by hand.',
  budget: '6k-12k', timeline: '30-days',
});
ok('a valid proposal request is accepted', okReq.status === 201, JSON.stringify(okReq.body));
ok('the proposal request is stored with its country', db.service_requests.length === 1 && db.service_requests[0].country === 'US');
ok('the proposal queue is admin-gated', (await getJson('/api/service-requests?key=wrong')).status === 403);
ok('the admin can read the queue', (await getJson('/api/service-requests?key=smoke-admin')).body.requests.length === 1);

srv.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);


