#!/usr/bin/env node

/**
 * Digital Drops, verified without a database, an M-Pesa call or a browser.
 *
 * The money path has four places that fail silently if nobody pins them:
 *
 *   1. The rules in `utils/digitalDrops.js` — pricing, the order state machine,
 *      the signed entitlement and the revenue arithmetic.
 *   2. The routes — the amount must come from the database, the callback must be
 *      idempotent, and the file must never be reachable without a valid token.
 *   3. The catalogue — every published row must validate, have a built pack, and
 *      point its bump at something that is actually on sale.
 *   4. The pack builder — the thing a buyer downloads must contain the offer and
 *      must escape whatever the catalogue says.
 *
 * Usage: npm run test:drops
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PRODUCT_KINDS,
  ORDER_STATES,
  DEFAULT_ACCESS_DAYS,
  MPESA_FEE_RATE,
  MAX_PRICE_KES,
  MIN_PRICE_KES,
  MIGRATION_FILE,
  normalizeSlug,
  newOrderRef,
  isOrderRef,
  newLookupSecret,
  hashLookup,
  lookupMatches,
  signEntitlement,
  verifyEntitlement,
  accessExpiry,
  accessState,
  validateProduct,
  isPublished,
  publicProduct,
  sortCatalog,
  formatPrice,
  quoteCheckout,
  mpesaFee,
  netOfFee,
  orderTransition,
  isTerminalState,
  deliveryMessage,
  supportWhatsAppLink,
  revenueSummary,
  parseMpesaCallback,
  isMissingTable,
  validateCheckout,
  PAYMENT_LANES,
  LANE_CURRENCY,
  lanesFor,
  preferredLane,
  normalizeCountry,
  validateEmail,
  cardCheckoutUrl,
  verifyCardWebhook,
  parseCardWebhook,
  deliveryEmail,
  validateServiceRequest,
  SERVICE_BUDGETS,
} from '../utils/digitalDrops.js';
import { renderPack } from './build_drop_assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const catalogRaw = JSON.parse(read('data/drops_catalog.json'));
const catalog = (catalogRaw.products || []).map((p) => validateProduct(p));
const cards = catalog.filter((c) => c.ok).map((c) => c.value);
const signals = JSON.parse(read('data/demand_signals.json'));

// ---- 1. slugs and order references ------------------------------------------
console.log('\n-- slugs and order references');
ok('a title becomes a slug', normalizeSlug('WhatsApp + M-Pesa Checkout Kit') === 'whatsapp-m-pesa-checkout-kit', normalizeSlug('WhatsApp + M-Pesa Checkout Kit'));
ok('accents and punctuation go', normalizeSlug('Café — naïve / test') === 'cafe-naive-test', normalizeSlug('Café — naïve / test'));
ok('an empty value is an empty slug', normalizeSlug(null) === '');
ok('a slug is capped at 60 characters', normalizeSlug('x'.repeat(200)).length === 60);

const refs = new Set();
for (let i = 0; i < 400; i++) refs.add(newOrderRef());
const oneRef = newOrderRef();
ok('an order reference fits Daraja\'s 12-character limit', oneRef.length <= 12, oneRef + ' (' + oneRef.length + ')');
ok('400 references contain no duplicate', refs.size === 400, String(refs.size));
ok('an order reference validates', isOrderRef(oneRef), oneRef);
ok('a short reference does not validate', !isOrderRef('DRP-1'));
ok('a lowercase reference does not validate', !isOrderRef(oneRef.toLowerCase()));

const lookup = newLookupSecret();
ok('a lookup secret round-trips through its hash', lookupMatches(lookup, hashLookup(lookup)));
ok('a different secret does not match', !lookupMatches(lookup + 'x', hashLookup(lookup)));
ok('an empty secret never matches an empty hash', !lookupMatches('', ''));

// ---- 2. the entitlement token ------------------------------------------------
console.log('\n-- entitlement tokens');
const secret = 'test-secret';
const expiryIso = accessExpiry('2026-11-10T10:00:00.000Z', DEFAULT_ACCESS_DAYS);
const token = signEntitlement({ orderId: 'o1', orderRef: 'DRP-ABC123', productSlug: 'a-kit', expiresAt: expiryIso }, secret);
const verified = verifyEntitlement(token, secret);
ok('a signed token verifies', verified.ok, JSON.stringify(verified));
ok('the token carries the order and the product', verified.ok && verified.payload.o === 'o1' && verified.payload.p === 'a-kit');
ok('the token is two base64url parts', token.split('.').length === 2 && !/[+/=]/.test(token));
const tokenParts = token.split('.');
const decoded = JSON.parse(Buffer.from(tokenParts[0], 'base64url').toString('utf8'));
const forged = Buffer.from(JSON.stringify({ ...decoded, p: 'other-kit' })).toString('base64url') + '.' + tokenParts[1];
ok('a tampered payload fails', verifyEntitlement(forged, secret).ok === false);
ok('a wrong secret fails', verifyEntitlement(token, 'nope').ok === false);
ok('no secret means no verification', verifyEntitlement(token, '').reason === 'unconfigured');
ok('a malformed token fails', verifyEntitlement('garbage', secret).ok === false);
const expired = signEntitlement({ orderId: 'o1', orderRef: 'DRP-ABC123', productSlug: 'a-kit', expiresAt: '2020-01-01T00:00:00.000Z' }, secret);
ok('an expired token is refused, with a reason', verifyEntitlement(expired, secret, new Date('2026-11-10T00:00:00Z')).reason === 'expired');
ok('an incomplete payload cannot be signed', (() => { try { signEntitlement({ orderId: 'o1' }, secret); return false; } catch { return true; } })());
ok('access expiry is 365 days after payment', new Date(expiryIso).getTime() - new Date('2026-11-10T10:00:00.000Z').getTime() === 365 * 86400000);
ok('an active window reads active', accessState(accessExpiry(), new Date()) === 'active');
ok('yesterday reads expired', accessState('2020-01-01T00:00:00Z', new Date()) === 'expired');

// ---- 3. product validation ---------------------------------------------------
console.log('\n-- product validation');
const good = {
  slug: 'test-kit', title: 'Test Kit', kind: 'kit', status: 'published',
  price_kes: 1500, outcomes: ['a', 'b', 'c'], modules: [{ title: 'm1' }, { title: 'm2' }, { title: 'm3' }],
};
ok('a complete row validates', validateProduct(good).ok);
ok('an unknown kind is rejected', validateProduct({ ...good, kind: 'nft' }).errors.some((e) => /kind/.test(e)));
ok('a price below the floor is rejected', validateProduct({ ...good, price_kes: MIN_PRICE_KES - 1 }).errors.some((e) => /price_kes/.test(e)));
ok('a price above the ceiling is rejected', validateProduct({ ...good, price_kes: MAX_PRICE_KES + 1 }).errors.some((e) => /price_kes/.test(e)));
ok('two outcomes are not enough', validateProduct({ ...good, outcomes: ['a', 'b'] }).errors.some((e) => /outcomes/.test(e)));
ok('two modules are not enough', validateProduct({ ...good, modules: [{ title: 'a' }, { title: 'b' }] }).errors.some((e) => /modules/.test(e)));
ok('a missing status defaults to draft', validateProduct({ ...good, status: undefined }).value.status === 'draft');
ok('a nonsense status defaults to draft', validateProduct({ ...good, status: 'live' }).value.status === 'draft');
ok('an unknown kind list is exported', Array.isArray(PRODUCT_KINDS) && PRODUCT_KINDS.includes('course'));
ok('the order-state list is exported', Array.isArray(ORDER_STATES) && ORDER_STATES.includes('delivered'));

// ---- 4. pricing and the quote -------------------------------------------------
console.log('\n-- pricing');
const main = validateProduct(good).value;
const bumpRaw = validateProduct({ ...good, slug: 'bump-kit', title: 'Bump Kit', price_kes: 500 }).value;
ok('a single-product quote is its price', quoteCheckout(main, null).amount === 1500);
ok('a bump adds its own price', quoteCheckout(main, bumpRaw).amount === 2000);
ok('a bump line is marked as a bump', quoteCheckout(main, bumpRaw).lines[1].bump === true);
ok('a draft bump is ignored', quoteCheckout(main, { ...bumpRaw, status: 'draft' }).amount === 1500);
ok('a product cannot bump itself', quoteCheckout(main, { ...main }).amount === 1500);
ok('an unaffordable quote is refused', quoteCheckout({ ...main, price_kes: MAX_PRICE_KES }, { ...bumpRaw, price_kes: 100 }).ok === false);
ok('formatPrice writes shillings', formatPrice(4500) === 'KES 4,500', formatPrice(4500));
ok('formatPrice keeps a fraction when there is one', formatPrice(1500.5).includes('1,500.5'), formatPrice(1500.5));
ok('the M-Pesa fee is 0.99% of the gross', mpesaFee(10000) === 99, String(mpesaFee(10000)));
ok('the net is gross minus the fee', netOfFee(10000) === 9901, String(netOfFee(10000)));
ok('the fee rate is the documented constant', MPESA_FEE_RATE === 0.0099);

// ---- 5. the order state machine ----------------------------------------------
console.log('\n-- order state machine');
ok('pending + prompted = prompted', orderTransition('pending', 'prompted') === 'prompted');
ok('prompted + paid = paid', orderTransition('prompted', 'paid') === 'paid');
ok('paid + delivered = delivered', orderTransition('paid', 'delivered') === 'delivered');
ok('a repeated paid callback returns null (idempotent)', orderTransition('paid', 'paid') === null);
ok('a repeated delivered callback returns null', orderTransition('delivered', 'delivered') === null);
ok('a late paid callback on a delivered order is a no-op', orderTransition('delivered', 'paid') === null);
ok('a failed prompt can still be paid', orderTransition('prompted', 'failed') === 'failed' && orderTransition('failed', 'paid') === 'paid');
ok('an unknown event returns null', orderTransition('pending', 'refunded') === null);
ok('an unknown state returns null', orderTransition('archived', 'paid') === null);
ok('delivered is terminal', isTerminalState('delivered') && isTerminalState('failed') && !isTerminalState('prompted'));

// ---- 6. delivery and revenue --------------------------------------------------
console.log('\n-- delivery and revenue');
const msg = deliveryMessage({
  product: { title: 'WhatsApp + M-Pesa Checkout Kit' },
  order: { amount: 4500, product_title: 'x' },
  accessUrl: 'https://x.test/drops/access/abc',
  expiresAt: '2027-11-10T00:00:00.000Z',
  receipt: 'QK12ABC34',
});
ok('the delivery message names the product', msg.includes('WhatsApp + M-Pesa Checkout Kit'));
ok('the delivery message carries the access URL', msg.includes('https://x.test/drops/access/abc'));
ok('the delivery message carries the receipt', msg.includes('QK12ABC34'));
ok('the delivery message states the access window', msg.includes('2027-11-10'));
ok('support link normalises a local number', supportWhatsAppLink({ DROPS_SUPPORT_WHATSAPP: '0712 345 678' }) === 'https://wa.me/254712345678');
ok('support link is absent when unset', supportWhatsAppLink({}) === null);

const orders = [
  { status: 'delivered', amount: 4500, product_slug: 'kit-a', product_title: 'Kit A' },
  { status: 'paid', amount: 1500, product_slug: 'kit-b', product_title: 'Kit B' },
  { status: 'failed', amount: 12000, product_slug: 'kit-c', product_title: 'Kit C' },
  { status: 'prompted', amount: 2500, product_slug: 'kit-b', product_title: 'Kit B' },
];
const rev = revenueSummary(orders);
ok('only paid and delivered orders count', rev.paid_orders === 2, String(rev.paid_orders));
ok('gross is the sum of paid orders', rev.gross === 6000, String(rev.gross));
ok('fees come off the gross', rev.net === Math.round((6000 - mpesaFee(6000)) * 100) / 100, String(rev.net));
ok('AOV is gross over paid orders', rev.aov === 3000, String(rev.aov));
ok('conversion is paid over attempts', rev.conversion === 50, String(rev.conversion));
ok('revenue is attributed per product', rev.by_product.length === 2 && rev.by_product[0].slug === 'kit-a');
ok('an empty report does not divide by zero', revenueSummary([]).aov === 0 && revenueSummary([]).conversion === 0);

// ---- 7. callbacks and checkout input -------------------------------------------
console.log('\n-- callbacks and checkout input');
const callback = parseMpesaCallback({
  Body: {
    stkCallback: {
      MerchantRequestID: 'm-1',
      CheckoutRequestID: 'c-1',
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      CallbackMetadata: {
        Item: [
          { Name: 'Amount', Value: 4500 },
          { Name: 'MpesaReceiptNumber', Value: 'QK12ABC34' },
          { Name: 'PhoneNumber', Value: 254712345678 },
        ],
      },
    },
  },
});
ok('the callback checkout id is read', callback.checkoutId === 'c-1');
ok('the callback result code is numeric', callback.resultCode === 0);
ok('the callback receipt is read', callback.receipt === 'QK12ABC34');
ok('the callback phone is read', callback.phone === 254712345678);
ok('an empty callback does not throw', parseMpesaCallback({}).checkoutId === null);
ok('a local number is normalised for STK', validateCheckout({ phone: '0712 345 678' }).phone === '254712345678');
ok('a non-Safaricom number is refused', validateCheckout({ phone: '0112345678' }).ok === false);
ok('an empty phone is refused', validateCheckout({}).ok === false);
ok('a missing table is recognised by code', isMissingTable({ code: '42P01' }));
ok('a missing table is recognised by message', isMissingTable({ message: 'relation "digital_orders" does not exist' }));
ok('a real error is not treated as a missing table', !isMissingTable({ code: '23505', message: 'duplicate key' }));

// ---- 8. the catalogue on disk --------------------------------------------------
console.log('\n-- catalogue');
ok('every catalogue row validates', catalog.every((c) => c.ok), catalog.filter((c) => !c.ok).map((c) => c.errors.join('; ')).join(' | '));
ok('there are at least five published products', cards.filter(isPublished).length >= 5, String(cards.filter(isPublished).length));
const slugs = cards.map((c) => c.slug);
ok('catalogue slugs are unique', new Set(slugs).size === slugs.length);
const published = cards.filter(isPublished);
ok('every bump points at a published product', published.every((p) => !p.bump_slug || published.some((q) => q.slug === p.bump_slug)),
  published.filter((p) => p.bump_slug && !published.some((q) => q.slug === p.bump_slug)).map((p) => p.slug).join(', '));
ok('every published product has a built pack', published.every((p) => p.asset_file && fs.existsSync(path.join(root, 'drops_assets', p.asset_file))),
  published.filter((p) => !p.asset_file || !fs.existsSync(path.join(root, 'drops_assets', p.asset_file))).map((p) => p.slug).join(', '));
ok('the ladder is ordered by rank', published.every((p, i) => i === 0 || Number(published[i - 1].rank) <= Number(p.rank)));

const rawPublished = (catalogRaw.products || []).filter((p) => p.status === 'published');
ok('every published row names a demand signal', rawPublished.every((p) => p.demand && Array.isArray(p.demand.signals) && p.demand.signals.length));
ok('every named signal exists in demand_signals.json', rawPublished.every((p) => (p.demand.signals || []).every((s) => signals.signals[s])),
  rawPublished.flatMap((p) => (p.demand.signals || []).filter((s) => !signals.signals[s])).join(', '));
ok('every signal carries a source and a checked date', Object.values(signals.signals).every((s) => s.source && s.checked));
ok('every published row has SEO copy', rawPublished.every((p) => p.seo && p.seo.title && p.seo.description));
ok('the public payload hides internal notes', (() => {
  const pub = publicProduct(published[0]);
  return pub && !('asset_sources' in pub) && !('rank' in pub) && 'price_kes' in pub;
})());
ok('sortCatalog drops drafts', sortCatalog([...cards, { slug: 'd', title: 'D', status: 'draft', rank: 1 }]).every((p) => p.status === 'published'));

// ---- 9. the routes -------------------------------------------------------------
console.log('\n-- routes');
const server = read('server.js');
const routes = read('routes/drops.js');
ok('server.js imports the drops router', /from "\.\/routes\/drops\.js"/.test(server));
ok('server.js mounts the drops router', /app\.use\('\/', createDropsRouter\(\{/.test(server));
ok('the mount receives the STK function and the WhatsApp sender', /createDropsRouter\(\{\s*supabase,\s*initiateStkPush,\s*sendMessage,\s*log/.test(server));
ok('initiateStkPush accepts a per-call callback URL', /async function initiateStkPush\(\{ phone, amount, accountRef, transactionDesc, callbackUrl \}\)/.test(server));
ok('the callback URL falls back to the configured one', /CallBackURL: callbackUrl \|\| process\.env\.MPESA_CALLBACK_URL/.test(server));
ok('there is still exactly one STK implementation', (server.match(/mpesa\/stkpush\/v1\/processrequest/g) || []).length === 1);

for (const route of [
  "router.get('/drops'", "router.get('/drops/:slug'", "router.get('/drops/access/:token'",
  "router.get('/api/drops'", "router.get('/api/drops/stats'", "router.get('/api/drops/:slug'",
  "router.post('/api/drops/:slug/checkout'", "router.post('/drops/mpesa/callback'",
  "router.get('/api/drops/order/:ref'", "router.get('/api/drops/access/:token'",
  "router.get('/api/drops/access/:token/file'",
]) ok('route exists: ' + route, routes.includes(route));

ok('checkout prices the order from the database', /quoteCheckout\(product, bumpProduct\)/.test(routes));
ok('checkout never reads an amount from the request body', !/req\.body\.(amount|price)|body\.(amount|price)\s*[,}]/.test(routes));
ok('checkout validates the phone', /validateCheckout\(body\)/.test(routes));
ok('checkout reuses an open order inside the replay window', /CHECKOUT_REPLAY_MS/.test(routes) && /reused: true/.test(routes));
ok('checkout sends this lane its own callback', /\/drops\/mpesa\/callback/.test(routes));
ok('the callback acknowledges before it works', (() => {
  const at = routes.indexOf("router.post('/drops/mpesa/callback'");
  const ack = routes.indexOf('res.status(200).json({ ResultCode: 0', at);
  const work = routes.indexOf('parseMpesaCallback', at);
  return at > -1 && ack > at && work > ack;
})());
ok('the callback is idempotent on a repeated payment', /orderTransition\(order\.status, 'paid'\)/.test(routes));
ok('the callback writes one entitlement per line', /for \(const line of lines\)/.test(routes));
ok('a WhatsApp failure cannot undo a payment', /delivery message failed/.test(routes));
ok('the access route verifies the token before reading the product', (() => {
  const at = routes.indexOf("router.get('/api/drops/access/:token'");
  const verify = routes.indexOf('loadEntitlement', at);
  const product = routes.indexOf('from(TABLES.products)', at);
  return at > -1 && verify > at && product > verify;
})());
ok('the file route cannot leave the asset directory', /path\.basename\(String\(product\.asset_file\)\)/.test(routes) && /startsWith\(path\.resolve\(assetRoot\)/.test(routes));
ok('the file route enforces a download ceiling', /MAX_ACCESS_DOWNLOADS/.test(routes));
ok('stats are admin-key gated', /x-admin-key/.test(routes) && /say\(res, 403/.test(routes));
ok('a missing table answers 503 naming the migration', /notInitialised\(res\)/.test(routes) && /MIGRATION_FILE/.test(routes));
ok('the buyer can only poll with their lookup secret', /lookupMatches\(lookup, order\.lookup_hash\)/.test(routes));

for (const route of [
  "router.post('/api/drops/:slug/checkout-card'",
  "router.post('/drops/card/webhook'",
  "router.post('/api/service-requests'",
  "router.get('/api/service-requests'",
  "router.get('/build'",
]) ok('new route exists: ' + route, routes.includes(route));

// The router is mounted at '/' in server.js. That is only safe while every path
// it declares is namespaced — so this pins the namespace. A future edit that adds
// a bare '/orders' or '/catalog' would shadow a tenant route, and this fails first.
const dropsPaths = [...routes.matchAll(/router\.(?:get|post|put|patch|delete)\('([^']+)'/g)].map((m) => m[1]);
const ALLOWED = ['/drops', '/build', '/api/drops', '/api/service-requests'];
const offNamespace = dropsPaths.filter((p) => !ALLOWED.some((pre) => p === pre || p.startsWith(pre + '/')));
ok('every drops route sits inside its own namespace', offNamespace.length === 0, offNamespace.join(', '));
const FOREIGN = ['/tenant', '/admin', '/discovery', '/mpesa', '/ai-jobs', '/go', '/blog', '/pay', '/api/kassangas', '/checkout'];
const collisions = dropsPaths.filter((p) => FOREIGN.some((pre) => p === pre || p.startsWith(pre + '/')));
ok('no drops route can shadow a tenant, admin or payment route', collisions.length === 0, collisions.join(', '));
ok('the router declares at least a dozen routes', dropsPaths.length >= 12, String(dropsPaths.length));

const otherRouters = fs.readdirSync(path.join(root, 'routes'))
  .filter((f) => f.endsWith('.js') && f !== 'drops.js')
  .map((f) => ({ file: f, src: read('routes/' + f) }));
ok('no other router serves /drops or /build',
  otherRouters.every((r) => !/['"]\/(drops|build)(['"/]|$)/.test(r.src)),
  otherRouters.filter((r) => /['"]\/(drops|build)(['"/]|$)/.test(r.src)).map((r) => r.file).join(', '));
ok('server.js has no catch-all route that could swallow /drops',
  !/app\.(?:get|use)\(\s*['"]\*['"]/.test(server) && !/app\.get\(\s*['"]\/:/.test(server));
ok('the drops router still reuses the single STK implementation', /initiateStkPush,/.test(server));


ok('the card checkout prices in USD from the catalogue', /quoteCheckout\(product, bumpProduct, \{ lane: 'card' \}\)/.test(routes));
ok('the card checkout requires an email, not a phone', /validateEmail\(body\)/.test(routes));
ok('the card webhook checks the signature before reading an order', (() => {
  const at = routes.indexOf("router.post('/drops/card/webhook'");
  const verify = routes.indexOf('verifyCardWebhook(', at);
  const read = routes.indexOf('from(TABLES.orders)', at);
  return at > -1 && verify > at && read > verify;
})());
ok('both lanes deliver through one function', (routes.match(/deliverOrder\(/g) || []).length >= 3,
  String((routes.match(/deliverOrder\(/g) || []).length));
ok('the delivery email is sent in the same path as WhatsApp', /deliveryEmail\(\{ product, order, accessUrl, expiresAt, receipt \}\)/.test(routes));
ok('the proposal queue is admin-key gated', (() => {
  const at = routes.indexOf("router.get('/api/service-requests'");
  const block = at > -1 ? routes.slice(at, at + 600) : '';
  return /x-admin-key/.test(block) && /say\(res, 403/.test(block);
})());

const buildPage = read('public/build.html');
ok('the build page posts to the proposal queue', buildPage.includes("fetch('/api/service-requests'"));
ok('the build page names a starting price', /\$3,000/.test(buildPage));
ok('the build page refuses to promise revenue', /not a revenue promise|Not a revenue promise/i.test(buildPage));

const laneMigration = read('migrations/2026-11-11_digital_drops_card_lane.sql');
ok('the lane migration adds payment_lane', /ADD COLUMN IF NOT EXISTS payment_lane/.test(laneMigration));
ok('the lane migration makes phone nullable', /ALTER COLUMN phone DROP NOT NULL/.test(laneMigration));
ok('the lane migration requires a phone or an email', /phone IS NOT NULL OR customer_email IS NOT NULL/.test(laneMigration));
ok('the lane migration creates the proposal queue', /CREATE TABLE IF NOT EXISTS public\.service_requests/.test(laneMigration));
ok('the lane migration makes a provider reference unique', /digital_orders_provider_ref_idx/.test(laneMigration));
ok('the lane migration refuses to run before the base tables exist',
  /RAISE EXCEPTION[\s\S]{0,200}2026-11-10_digital_drops\.sql/.test(laneMigration));
ok('the lane migration checks with to_regclass instead of a bare ALTER',
  /to_regclass\('public\.digital_products'\)/.test(laneMigration));

const baseMigration = read('migrations/2026-11-10_digital_drops.sql');
const combinedMigration = read('migrations/APPLY_ALL_digital_drops.sql');
const flat = (s) => s.replace(/\r\n/g, '\n').trim();
ok('the combined migration contains the base file verbatim', flat(combinedMigration).includes(flat(baseMigration)));
ok('the combined migration contains the lane file verbatim', flat(combinedMigration).includes(flat(laneMigration)));
ok('the combined migration runs the base file first',
  flat(combinedMigration).indexOf(flat(baseMigration)) < flat(combinedMigration).indexOf(flat(laneMigration)));
ok('the combined migration is one paste, two transactions',
  (combinedMigration.match(/^BEGIN;/gm) || []).length === 2 && (combinedMigration.match(/^COMMIT;/gm) || []).length === 2);
ok('the schema doctor exists', fs.existsSync(path.join(root, 'scripts', 'drops_doctor.mjs')));
ok('the migration runner exists', fs.existsSync(path.join(root, 'scripts', 'drops_apply_migrations.mjs')));

// The first generated version of this file carried a shell command on line 13:
// a PowerShell double-quoted here-string ate the backticks around `npm run
// test:drops`, turning it into "pm run test:drops" and making the whole paste
// fail with `syntax error at or near "pm"`. A comment-only header is the fix, and
// this is the guard.
const combinedLines = combinedMigration.replace(/\r\n/g, '\n').split('\n');
ok('the combined migration header is comments only',
  combinedLines.slice(0, 20).every((l) => l.startsWith('--') || l.trim() === ''));
const shellLines = combinedLines.filter((l) => /^\s*(pm|npm|node|psql|npx|cd|git)\b/.test(l));
ok('the combined migration contains no shell command lines', shellLines.length === 0, shellLines.join(' | '));
ok('no line of the combined migration lost its leading character',
  !combinedLines.some((l) => /^pm run|^ode |^px /.test(l)));




const page = read('public/drops.html');
const accessPage = read('public/drops-access.html');
ok('the storefront page calls the catalogue', page.includes("fetch('/api/drops')"));
ok('the storefront sends only a phone number and a bump flag', /var body = \{ phone: phoneEl\.value \}/.test(page) && !/body\.amount/.test(page));
ok('the storefront polls its own order', /\/api\/drops\/order\//.test(page));
ok('the delivery page reads the access API', accessPage.includes('/api/drops/access/'));
ok('the delivery page links only to the served file', accessPage.includes('d.file'));

const migration = read(MIGRATION_FILE);
for (const table of ['digital_products', 'digital_orders', 'digital_entitlements', 'digital_events']) {
  ok('migration creates ' + table, migration.includes('CREATE TABLE IF NOT EXISTS public.' + table));
}
ok('migration enables row level security on all four', (migration.match(/ENABLE ROW LEVEL SECURITY/g) || []).length === 4);
ok('migration makes the checkout id unique', /CREATE UNIQUE INDEX IF NOT EXISTS digital_orders_checkout_idx/.test(migration));
ok('migration makes an entitlement token unique', /token\s+text NOT NULL UNIQUE/.test(migration));
ok('migration is idempotent and transactional', /^BEGIN;/m.test(migration) && /^COMMIT;/m.test(migration));

// ---- 10. the pack a buyer downloads -------------------------------------------
console.log('\n-- pack builder');
const sampleRaw = (catalogRaw.products || []).find((p) => p.slug === published[0].slug);
const sampleHtml = renderPack(sampleRaw);
ok('a pack names the product', sampleHtml.includes(published[0].title));
ok('a pack carries the summary', sampleHtml.includes(published[0].summary.slice(0, 40)));
ok('a pack lists every module title', published[0].modules.every((m) => sampleHtml.includes(m.title)));
ok('a pack states its licence', /one buyer, one organisation/i.test(sampleHtml));
ok('a pack refuses to promise income', /Not a guarantee of income/i.test(sampleHtml));
ok('a pack is not indexable', sampleHtml.includes('noindex,nofollow'));
ok('an assembled pack bundles its sources', (() => {
  const raw = (catalogRaw.products || []).find((p) => Array.isArray(p.asset_sources) && p.asset_sources.length) ;
  return raw ? renderPack(raw).includes('Source documents') : true;
})());
const hostile = renderPack({ title: 'Bad <script>alert(1)</script>', summary: 'x', outcomes: ['a'], modules: [{ title: 'm', detail: 'd' }] });
ok('a hostile title is escaped in the pack', hostile.includes('&lt;script&gt;') && !hostile.includes('<script>alert'));
ok('an empty pack does not throw', typeof renderPack({}) === 'string');
const md = renderPack({ title: 'MD', modules: [{ title: 'h', detail: '## Heading\n\n- one\n- two\n\n```js\nconst a = 1;\n```' }] });
ok('markdown headings render as headings', md.includes('<h2>Heading</h2>'));
ok('markdown lists render as lists', md.includes('<li>one</li>') && md.includes('<li>two</li>'));
ok('fenced code is escaped, not executed', md.includes('<pre><code>') && md.includes('const a = 1;'));

// ---- 11. the card lane ---------------------------------------------------------
console.log('\n-- card lane');
const usdProduct = validateProduct({ ...good, price_usd: 99 }).value;
const mpesaOnly = validateProduct({ ...good, price_usd: 99, payment_lane: 'mpesa' }).value;
const cardOnly = validateProduct({ ...good, price_usd: 99, payment_lane: 'card' }).value;
const bumpUsd = validateProduct({ ...good, slug: 'bump-usd', title: 'Bump USD', price_kes: 500, price_usd: 25 }).value;

ok('two lanes are declared', PAYMENT_LANES.length === 2 && PAYMENT_LANES.includes('card'));
ok('each lane has its own currency', LANE_CURRENCY.mpesa === 'KES' && LANE_CURRENCY.card === 'USD');
ok('a both-lane product with a USD price is on both lanes', lanesFor(usdProduct).join(',') === 'mpesa,card');
ok('a product without a USD price cannot be sold by card', lanesFor(validateProduct({ ...good, price_usd: null }).value).join(',') === 'mpesa');
ok('a card-only product is on the card lane', lanesFor(cardOnly).join(',') === 'card');
ok('a card-only product must carry a USD price', validateProduct({ ...good, payment_lane: 'card' }).ok === false);
ok('an mpesa-only product refuses the card lane', lanesFor(mpesaOnly).includes('card') === false);
ok('a Kenyan buyer is offered M-Pesa first', preferredLane(usdProduct, { country: 'KE' }) === 'mpesa');
ok('a US buyer is offered the card first', preferredLane(usdProduct, { country: 'US' }) === 'card');
ok('an unknown country defaults to card', preferredLane(usdProduct, { country: '' }) === 'card');
ok('an explicit request is honoured when allowed', preferredLane(usdProduct, { country: 'US', requested: 'mpesa' }) === 'mpesa');
ok('an explicit request cannot force a lane the product lacks', preferredLane(mpesaOnly, { requested: 'card' }) === 'mpesa');
ok('a single-lane product ignores the country default', preferredLane(cardOnly, { country: 'KE' }) === 'card');
ok('country codes are normalised', normalizeCountry('usa') === 'US' && normalizeCountry('United Kingdom') === 'GB' && normalizeCountry('Kenya') === 'KE');
ok('a two-letter code passes through', normalizeCountry('ca') === 'CA');
ok('nonsense country is empty', normalizeCountry('somewhere') === '');

ok('an email is validated', validateEmail({ email: 'Buyer@Example.com' }).email === 'buyer@example.com');
ok('an empty email is refused', validateEmail({}).ok === false);
ok('a malformed email is refused', validateEmail({ email: 'buyer@example' }).ok === false);

const cardQuote = quoteCheckout(usdProduct, null, { lane: 'card' });
ok('a card quote is in USD', cardQuote.currency === 'USD' && cardQuote.amount === 99, JSON.stringify(cardQuote));
ok('the card quote records its lane', cardQuote.lane === 'card');
ok('a card bump is priced in USD', quoteCheckout(usdProduct, bumpUsd, { lane: 'card' }).amount === 124);
ok('an mpesa bump is ignored on the card lane', quoteCheckout(usdProduct, validateProduct({ ...good, slug: 'kes-only', title: 'KES only', price_kes: 900 }).value, { lane: 'card' }).amount === 99);
ok('a card quote on a KES-only product fails', quoteCheckout(mpesaOnly, null, { lane: 'card' }).ok === false);
ok('the mpesa lane still quotes shillings', quoteCheckout(usdProduct, null).currency === 'KES' && quoteCheckout(usdProduct, null).amount === 1500);

const cardUrl = cardCheckoutUrl({ DROPS_CARD_LINK: 'https://pay.example.com/checkout' }, { slug: 'test-kit', orderRef: 'DRP-ABC123', email: 'a@b.co' });
ok('a card checkout URL carries the order reference', cardUrl.includes('ref=DRP-ABC123'), cardUrl);
ok('a card checkout URL carries the buyer email', cardUrl.includes('email=a%40b.co'), cardUrl);
ok('a per-product link map wins over the default', cardCheckoutUrl({ DROPS_CARD_LINK: 'https://x.test/d', DROPS_CARD_LINKS: '{"test-kit":"https://x.test/p"}' }, { slug: 'test-kit' }).startsWith('https://x.test/p'));
ok('a malformed link map falls back to the default', cardCheckoutUrl({ DROPS_CARD_LINK: 'https://x.test/d', DROPS_CARD_LINKS: 'not json' }, { slug: 'test-kit' }).startsWith('https://x.test/d'));
ok('no configured link returns null', cardCheckoutUrl({}, { slug: 'x' }) === null);

const cryptoModule = await import('crypto');
const rawBody = JSON.stringify({ order_ref: 'DRP-ABC123', status: 'paid', amount: 99, currency: 'USD' });
const goodSig = cryptoModule.createHmac('sha256', 'whsec').update(rawBody).digest('hex');
ok('a correct hex signature verifies', verifyCardWebhook(rawBody, goodSig, 'whsec').ok);
ok('a sha256= prefix is accepted', verifyCardWebhook(rawBody, 'sha256=' + goodSig, 'whsec').ok);
ok('a base64 signature verifies', verifyCardWebhook(rawBody, cryptoModule.createHmac('sha256', 'whsec').update(rawBody).digest('base64'), 'whsec').ok);
ok('a wrong signature is refused', verifyCardWebhook(rawBody, 'deadbeef', 'whsec').ok === false);
ok('no signature is refused', verifyCardWebhook(rawBody, '', 'whsec').reason === 'missing-signature');
ok('no secret is unwired, not open', verifyCardWebhook(rawBody, goodSig, '').reason === 'unconfigured');
ok('a modified body breaks the signature', verifyCardWebhook(rawBody + ' ', goodSig, 'whsec').ok === false);

const parsedCard = parseCardWebhook({ data: { order_ref: 'drp-abc123', status: 'COMPLETED', amount: 99, currency: 'usd', transaction_id: 'tx-1', provider: 'paddle' } });
ok('a card callback is unwrapped from data', parsedCard.orderRef === 'DRP-ABC123');
ok('a completed status reads as paid', parsedCard.status === 'paid');
ok('a card callback keeps the amount and currency', parsedCard.amount === 99 && parsedCard.currency === 'USD');
ok('a provider reference is kept', parsedCard.providerRef === 'tx-1' && parsedCard.provider === 'paddle');
ok('a refund reads as failed', parseCardWebhook({ status: 'refunded' }).status === 'failed');
ok('an unknown status is not paid', parseCardWebhook({ status: 'pending' }).status === '');
ok('an empty callback does not throw', parseCardWebhook({}).orderRef === '');

const cardMail = deliveryEmail({
  product: { title: 'AI Agent Ops Track' },
  order: { amount: 99, currency: 'USD', product_title: 'x' },
  accessUrl: 'https://x.test/drops/access/tok',
  expiresAt: '2027-11-11T00:00:00.000Z',
  receipt: 'tx-1',
});
ok('the email names the pack', cardMail.subject.includes('AI Agent Ops Track'));
ok('the email carries the access link', cardMail.text.includes('https://x.test/drops/access/tok') && cardMail.html.includes('https://x.test/drops/access/tok'));
ok('the email carries the amount in USD', cardMail.text.includes('USD 99'));
ok('the email states the access window', cardMail.text.includes('2027-11-11'));
ok('the email escapes what it interpolates', deliveryEmail({ product: { title: '<b>x</b>' }, order: {}, accessUrl: 'https://x.test/a' }).html.includes('&lt;b&gt;'));

// ---- 12. mixed-currency revenue ------------------------------------------------
console.log('\n-- mixed-currency revenue');
const mixed = revenueSummary([
  { status: 'delivered', amount: 12000, currency: 'KES', lane: 'mpesa', product_slug: 'a', product_title: 'A' },
  { status: 'paid', amount: 99, currency: 'USD', lane: 'card', product_slug: 'b', product_title: 'B' },
  { status: 'paid', amount: 99, currency: 'USD', lane: 'card', product_slug: 'b', product_title: 'B' },
]);
ok('two currencies are reported separately', mixed.by_currency.length === 2, JSON.stringify(mixed.by_currency));
ok('the primary currency stays KES when KES exists', mixed.primary_currency === 'KES');
ok('KES gross is not polluted by USD', mixed.gross === 12000, String(mixed.gross));
ok('the USD bucket carries its own gross and AOV', mixed.by_currency.find((c) => c.currency === 'USD').gross === 198);
ok('the USD bucket pays no M-Pesa fee by default', mixed.by_currency.find((c) => c.currency === 'USD').fees === 0);
ok('the KES bucket still pays the M-Pesa fee', mixed.by_currency.find((c) => c.currency === 'KES').fees === mpesaFee(12000));
ok('revenue is split by lane', mixed.by_lane.length === 2 && mixed.by_lane.find((l) => l.lane === 'card').orders === 2);
ok('a card fee rate can be set when the provider is known', revenueSummary([{ status: 'paid', amount: 100, currency: 'USD', lane: 'card' }], { cardFeeRate: 0.05 }).fees === 5);

// ---- 13. the rung-3 proposal request -------------------------------------------
console.log('\n-- funnel build request');
const svc = validateServiceRequest({
  name: 'Dana Reed', email: 'dana@shop.co', company: 'Shop Co', country: 'United States',
  sell: 'We sell industrial water pumps to farms and estates.', channel: 'WhatsApp and phone',
  problem: 'Quotes are written by hand.', budget: '6k-12k', timeline: '30-days',
});
ok('a complete request validates', svc.ok, svc.errors.join('; '));
ok('the request normalises the country', svc.value.country === 'US');
ok('the request normalises the email', svc.value.email === 'dana@shop.co');
ok('a missing budget is refused', validateServiceRequest({ ...svc.value, budget: '' }).ok === false);
ok('an unknown budget is refused', validateServiceRequest({ ...svc.value, budget: '1m' }).ok === false);
ok('an unknown timeline is refused', validateServiceRequest({ ...svc.value, timeline: 'someday' }).ok === false);
ok('a one-word answer is not enough', validateServiceRequest({ ...svc.value, sell: 'pumps' }).ok === false);
ok('a bad email is refused', validateServiceRequest({ ...svc.value, email: 'nope' }).ok === false);
ok('the four budget bands are exported', SERVICE_BUDGETS.length === 4);

// ---- 14. the outreach batch (drafts only) --------------------------------------
console.log('\n-- outreach batch');
const outreach = await import('./build_page_outreach.mjs');
const now = Date.now();
const prospects = [
  { email: 'a@shop.co', name: 'Ada', business_name: 'Shop Co', industry: 'Retail', status: 'new', submitted_at: new Date(now - 86400000).toISOString() },
  { email: 'b@farm.co', name: 'Ben', status: 'contacted', submitted_at: new Date(now - 2 * 86400000).toISOString() },
  { email: 'c@tenant.co', name: 'Cleo', status: 'approved', submitted_at: new Date(now - 3 * 86400000).toISOString() },
  { email: 'd@closed.co', name: 'Dan', status: 'rejected', submitted_at: new Date(now - 4 * 86400000).toISOString() },
  { email: 'a@shop.co', name: 'Ada again', status: 'new', submitted_at: new Date(now - 5 * 86400000).toISOString() },
  { email: 'old@shop.co', name: 'Old', status: 'new', submitted_at: new Date(now - 400 * 86400000).toISOString() },
];
const picked = outreach.selectRecipients(prospects, { days: 90, limit: 20 });
ok('an approved prospect is not re-pitched', picked.every((p) => p.email !== 'c@tenant.co'));
ok('a rejected prospect is left alone', picked.every((p) => p.email !== 'd@closed.co'));
ok('an already-contacted prospect is skipped by default', picked.every((p) => p.email !== 'b@farm.co'));
ok('a duplicate address appears once', picked.filter((p) => p.email === 'a@shop.co').length === 1);
ok('a prospect outside the window is excluded', picked.every((p) => p.email !== 'old@shop.co'));
ok('the newest prospect comes first', picked[0] && picked[0].email === 'a@shop.co');
ok('the limit is respected', outreach.selectRecipients(prospects, { days: 90, limit: 1 }).length === 1);

const drafted = outreach.draftMessage(
  { name: 'Ada', business_name: 'Shop Co', industry: 'Retail', submitted_at: new Date(now - 86400000).toISOString() },
  { url: 'https://x.test/build', sender: 'Alphadome' },
);
ok('the draft names the business', drafted.includes('Shop Co'));
ok('the draft links to the scope form', drafted.includes('https://x.test/build'));
ok('the draft states the starting price', drafted.includes('$3,000'));
ok('the draft offers a way to close the file', /reply "not now"/.test(drafted));
ok('the draft makes no revenue promise', !/guarantee|you will earn|double your/i.test(drafted));
const anon = outreach.draftMessage({ name: 'Zed' }, { url: 'https://x.test/build' });
ok('a draft without a business still reads', anon.startsWith('You asked us about getting sales out of WhatsApp'));


// ---- summary --------------------------------------------------------------------
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);







