#!/usr/bin/env node

/**
 * Scan to Pay, verified without a database or an M-Pesa call (2026-10-25).
 *
 * The tenant portal now has a merchant wallet and a client wallet. Both ride the
 * QR + STK stack that is already live for Kassangas (`kassangas_templates`,
 * `subscriptions`, `initiateStkPush`), so this suite pins the parts that would
 * break silently:
 *
 *   1. The pure rules in `utils/scanPay.js` — phone normalisation, link
 *      validation, the per-tenant merchant code, the pay URL / account reference,
 *      collection totals and the "table missing" message.
 *   2. The routes: tenant-scoped writes, a public pay page that carries no
 *      session, a 90-second double-prompt guard, and exactly one STK implementation.
 *   3. The portal: a nav entry that reaches the renderer, the endpoints it calls,
 *      the QR libraries it degrades without, and the Micro1 link.
 *
 * Usage: npm run test:scan-pay
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import fs from 'fs';
import {
  PLAN_TYPE,
  TEMPLATES_TABLE,
  TEMPLATES_MIGRATION,
  normalizeMsisdn,
  isValidPayerPhone,
  tenantMerchantCode,
  buildAccountRef,
  payUrl,
  extractTemplateId,
  buildTemplateId,
  validateLinkInput,
  maskPhone,
  shapeLink,
  describeCollection,
  summariseCollections,
  statsByTemplate,
  isMissingTableError,
  missingTemplatesMessage,
  stkReadiness,
  stkReadinessMessage,
} from '../utils/scanPay.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

// ---- 1. phone handling -----------------------------------------------------
ok('a local 07… number becomes 2547…', normalizeMsisdn('0712 345 678') === '254712345678', normalizeMsisdn('0712 345 678'));
ok('a +254 number loses the plus', normalizeMsisdn('+254712345678') === '254712345678', normalizeMsisdn('+254712345678'));
ok('a 9-digit subscriber number is completed', normalizeMsisdn('712345678') === '254712345678', normalizeMsisdn('712345678'));
ok('a 2547 number is left alone', normalizeMsisdn('254712345678') === '254712345678');
ok('a non-Safaricom prefix is rejected by the payer check', !isValidPayerPhone('254112345678'));
ok('an empty phone is rejected', !isValidPayerPhone(''));
ok('a valid phone passes the payer check', isValidPayerPhone('0712345678'));

// ---- 2. the tenant's merchant code -----------------------------------------
const codeA = tenantMerchantCode({ phone: '254702245555', slug: 'kassangas' });
ok('the merchant code comes from the tenant phone', codeA === 'SP245555', codeA);
ok('the code is stable for the same tenant', codeA === tenantMerchantCode({ phone: '254702245555', slug: 'kassangas' }));
ok('two tenants with different phones get different codes', codeA !== tenantMerchantCode({ phone: '254711111111' }));
ok('the code is alphanumeric only (safe in an account reference)', /^[A-Z0-9]+$/.test(codeA), codeA);
const fallbackCode = tenantMerchantCode({ slug: 'kassangas-music-shop' });
ok('a tenant without a phone still gets a deterministic code', /^SP[A-Z0-9]{4,}$/.test(fallbackCode), fallbackCode);

const ref1 = buildAccountRef(codeA, 1730000000000);
ok('the account reference carries the merchant code', ref1.startsWith(codeA), ref1);
ok('the account reference is deterministic for a fixed clock', ref1 === buildAccountRef(codeA, 1730000000000));
ok('the account reference has no punctuation', /^[A-Z0-9]+$/.test(ref1), ref1);
ok('two attempts a second apart get different references', buildAccountRef(codeA, 1730000000001) !== ref1);

// ---- 3. links and identifiers ----------------------------------------------
const url = payUrl('https://alphadome.onrender.com/', 'TMPL-123456-ABCDEF');
ok('the pay URL drops a trailing slash and keeps the token', url === 'https://alphadome.onrender.com/pay/t/TMPL-123456-ABCDEF', url);
ok('a token inside a full URL is extracted', extractTemplateId(url) === 'TMPL-123456-ABCDEF', extractTemplateId(url));
ok('a token in a query string is extracted', extractTemplateId('https://x.test/kassangas-client-wallet?t=TMPL-9') === 'TMPL-9');
ok('a bare token is accepted', extractTemplateId('TMPL-123456-ABCDEF') === 'TMPL-123456-ABCDEF');
ok('free text is not a token', extractTemplateId('pay me please') === '');

const tid = buildTemplateId(1730000000000, 0.123456);
ok('the template id has the live Kassangas shape', /^TMPL-\d{6}-[0-9A-Z]{6}$/.test(tid), tid);
ok('the template id is deterministic for fixed inputs', tid === buildTemplateId(1730000000000, 0.123456));
ok('a different draw gives a different template id', tid !== buildTemplateId(1730000000000, 0.998877));

// ---- 4. link validation ----------------------------------------------------
ok('a missing name is refused', validateLinkInput({ amount: 10 }).ok === false);
ok('a one-character name is refused', validateLinkInput({ itemName: 'x', amount: 10 }).ok === false);
ok('a zero amount is refused', validateLinkInput({ itemName: 'Setup', amount: 0 }).ok === false);
ok('a negative amount is refused', validateLinkInput({ itemName: 'Setup', amount: -50 }).ok === false);
ok('a non-numeric amount is refused', validateLinkInput({ itemName: 'Setup', amount: 'free' }).ok === false);
ok('an excessive amount is refused', validateLinkInput({ itemName: 'Setup', amount: 900000 }).ok === false);
const good = validateLinkInput({ itemName: '  Guitar   setup ', amount: '1500.456', reusable: false });
ok('a valid link is accepted', good.ok === true, good.error);
ok('the name is trimmed and collapsed', good.itemName === 'Guitar setup', good.itemName);
ok('the amount is rounded to whole shillings', good.amount === 1500, String(good.amount));
ok('reusable defaults to true when absent', validateLinkInput({ itemName: 'Setup', amount: 100 }).reusable === true);
ok('an explicit false is honoured', good.reusable === false);

// ---- 5. what the portal renders -------------------------------------------
ok('payer phones are masked', maskPhone('254712345678') === '2547***78', maskPhone('254712345678'));
ok('a missing payer renders as empty, never as a crash', maskPhone('') === '');

const shaped = shapeLink({
  row: { template_id: 'TMPL-1', item_name: 'Setup', amount: '1500', merchant_name: 'Shop', created_at: '2026-10-25T00:00:00Z' },
  baseUrl: 'https://alphadome.onrender.com',
  stats: { paidCount: 2, collected: 3000 },
});
ok('a link carries its pay URL', shaped.url === 'https://alphadome.onrender.com/pay/t/TMPL-1', shaped.url);
ok('a link carries its own totals', shaped.paidCount === 2 && shaped.collected === 3000);
ok('an unset status reads as active', shaped.status === 'active', shaped.status);
ok('a link with no sales still renders', shapeLink({ row: { template_id: 'T', amount: 5 } }).paidCount === 0);

const collection = describeCollection({
  id: 'c1', phone: '254712345678', amount: '900', status: 'PENDING',
  account_ref: 'SP245555ABC', metadata: { item_name: 'Setup', source: 'public_pay_page' },
});
ok('a collection masks the payer', collection.payer === '2547***78', collection.payer);
ok('a collection keeps its reference for reconciliation', collection.accountRef === 'SP245555ABC');
ok('a collection carries the item it paid for', collection.itemName === 'Setup');
ok('a collection status is lower-cased', collection.status === 'pending');

const totals = summariseCollections([
  { amount: 900, status: 'completed' },
  { amount: 600, status: 'pending' },
  { amount: 100, status: 'failed' },
]);
ok('collected only counts settled prompts', totals.collected === 900, JSON.stringify(totals));
ok('pending is the money still on a phone', totals.pending === 600, JSON.stringify(totals));
ok('failed attempts are counted, not mixed into either total', totals.failed === 100 && totals.count === 3, JSON.stringify(totals));

const perLink = statsByTemplate([
  { amount: 500, status: 'completed', metadata: { template_id: 'T1' } },
  { amount: 500, status: 'completed', metadata: { template_id: 'T1' } },
  { amount: 300, status: 'pending', metadata: { template_id: 'T1' } },
  { amount: 100, status: 'completed', metadata: { template_id: 'T2' } },
  { amount: 100, status: 'completed', metadata: {} },
]);
ok('per-link totals count paid prompts', perLink.T1.paidCount === 2 && perLink.T1.collected === 1000, JSON.stringify(perLink.T1));
ok('per-link totals keep pending apart', perLink.T1.pending === 1, JSON.stringify(perLink.T1));
ok('per-link totals do not merge links', perLink.T2.paidCount === 1 && perLink.T2.collected === 100);
ok('rows without a template id are ignored', Object.keys(perLink).length === 2, Object.keys(perLink).join(','));

// ---- 6. the two failure modes a deployment can hit ------------------------
ok('a missing-table code is recognised', isMissingTableError({ code: '42P01' }));
ok('a PostgREST missing-table code is recognised', isMissingTableError({ code: 'PGRST205' }));
ok('a Postgres message is recognised', isMissingTableError(new Error('relation "kassangas_templates" does not exist')));
ok('an unrelated error is not blamed on the table', !isMissingTableError(new Error('timeout')));
ok('the missing-table message names the table and the migration',
  missingTemplatesMessage().includes(TEMPLATES_TABLE) && missingTemplatesMessage().includes(TEMPLATES_MIGRATION),
  missingTemplatesMessage());

const missingStk = stkReadiness({ MPESA_CONSUMER_KEY: 'a', MPESA_CONSUMER_SECRET: 'b', MPESA_PASSKEY: 'c', MPESA_SHORTCODE: 'd' });
ok('a half-configured deployment is not ready', missingStk.ready === false);
ok('the readiness check names the missing variable', missingStk.missing.includes('MPESA_CALLBACK_URL'), missingStk.missing.join(','));
ok('the readiness message names the variable it needs',
  stkReadinessMessage(missingStk.missing).includes('MPESA_CALLBACK_URL'), stkReadinessMessage(missingStk.missing));
ok('a fully configured deployment is ready',
  stkReadiness({ MPESA_CONSUMER_KEY: 'a', MPESA_CONSUMER_SECRET: 'b', MPESA_PASSKEY: 'c', MPESA_SHORTCODE: 'd', MPESA_CALLBACK_URL: 'e' }).ready === true);

ok('the plan type is tenant-specific', PLAN_TYPE === 'tenant_scan_pay', PLAN_TYPE);

// ---- 7. the routes ---------------------------------------------------------
const server = fs.readFileSync('server.js', 'utf8');
const scoped = (needle, span = 200) => {
  const i = server.indexOf(needle);
  return i > -1 && /tenantSessionAuth/.test(server.slice(i, i + span));
};

ok('server.js imports the scan-pay rules', /from "\.\/utils\/scanPay\.js"/.test(server));
ok('GET /tenant/scan-pay exists', server.indexOf('app.get("/tenant/scan-pay"') > -1);
ok('GET /tenant/scan-pay is tenant-scoped', scoped('app.get("/tenant/scan-pay"'));
ok('POST /tenant/scan-pay/links exists', server.indexOf('app.post("/tenant/scan-pay/links"') > -1);
ok('POST /tenant/scan-pay/links is tenant-scoped', scoped('app.post("/tenant/scan-pay/links"'));
ok('POST /tenant/scan-pay/charge exists', server.indexOf('app.post("/tenant/scan-pay/charge"') > -1);
ok('POST /tenant/scan-pay/charge is tenant-scoped', scoped('app.post("/tenant/scan-pay/charge"'));
ok('POST /tenant/scan-pay/pay exists (client wallet)', server.indexOf('app.post("/tenant/scan-pay/pay"') > -1);
ok('POST /tenant/scan-pay/pay is tenant-scoped', scoped('app.post("/tenant/scan-pay/pay"'));

const iIntent = server.indexOf('app.post("/pay/t/:tokenId/intent"');
ok('the public intent route exists', iIntent > -1);
ok('the public intent route carries no tenant session', iIntent > -1 && !/tenantSessionAuth/.test(server.slice(iIntent, iIntent + 200)));
const iPayPage = server.indexOf('app.get("/pay/t/:tokenId"');
ok('the public pay page route exists', iPayPage > -1);
ok('the public pay page serves public/pay.html', iPayPage > -1 && /pay\.html/.test(server.slice(iPayPage, iPayPage + 200)));
ok('the pay page is not gated by a session', iPayPage > -1 && !/tenantSessionAuth/.test(server.slice(iPayPage, iPayPage + 200)));

const iIntentFn = server.indexOf('async function createScanPayIntent(');
const intentSrc = iIntentFn > -1 ? server.slice(iIntentFn, iIntentFn + 3200) : '';
ok('one shared prompt function exists', intentSrc.length > 0);
ok('the shared prompt reuses initiateStkPush', /await initiateStkPush\(/.test(intentSrc));
ok('a double tap is replayed instead of re-sent', /90_000/.test(intentSrc) && /reused: true/.test(intentSrc));
ok('the prompt is recorded against the link and the tenant',
  /template_id: template\?\.template_id/.test(intentSrc) && /tenant_id: template\?\.metadata\?\.tenant_id/.test(intentSrc));
ok('only one STK implementation exists in the repo',
  (server.match(/mpesa\/stkpush\/v1\/processrequest/g) || []).length === 1,
  String((server.match(/mpesa\/stkpush\/v1\/processrequest/g) || []).length));

const iGet = server.indexOf('app.get("/tenant/scan-pay"');
const getSrc = iGet > -1 ? server.slice(iGet, iGet + 2600) : '';
ok('links are scoped to this tenant site', /contains\("metadata", \{ tenant_id: ctx\.site\.id \}\)/.test(getSrc));
ok('collections are scoped by plan type and account prefix',
  /eq\("plan_type", SCAN_PAY_PLAN_TYPE\)/.test(getSrc) && /ilike\("account_ref"/.test(getSrc));
ok('a missing table is reported, not swallowed', /isMissingTableError/.test(getSrc) && /missingTemplatesMessage/.test(getSrc));
ok('the portal is told whether M-Pesa is configured', /stk: ready\.ready/.test(getSrc) && /stkMissing: ready\.missing/.test(getSrc));
ok('a merchant cannot charge another tenant\'s link',
  /loadScanPayLink\(templateId, scan\.ctx\.site\.id\)/.test(server));
ok('an unconfigured deployment answers 503 before an STK call',
  /err\.status = 503/.test(intentSrc) && /stkReadiness\(process\.env\)/.test(intentSrc));

// ---- 8. the portal ---------------------------------------------------------
const dash = fs.readFileSync('admin/tenant_dashboard.html', 'utf8');
ok('the portal has a Scan to Pay nav entry', /data-sec="scan-pay"/.test(dash));
ok('go() routes scan-pay to its renderer', /'scan-pay':renderScanPay/.test(dash));
ok('the renderer is defined', /async function renderScanPay\(/.test(dash));
ok('the section loads the tenant wallet context', /apiJson\('\/tenant\/scan-pay'\)/.test(dash));
ok('creating a link posts to the tenant endpoint', /apiJson\('\/tenant\/scan-pay\/links'/.test(dash));
ok('charging a customer posts to the charge endpoint', /apiJson\('\/tenant\/scan-pay\/charge'/.test(dash));
ok('paying a link posts to the pay endpoint', /apiJson\('\/tenant\/scan-pay\/pay'/.test(dash));
ok('the QR is drawn from the returned pay URL', /new QRCode\(canvas/.test(dash));
ok('a missing QR library degrades to the link instead of breaking',
  /typeof QRCode === 'undefined'/.test(dash));
ok('a poster can be scanned back into the pay form',
  /typeof jsQR === 'undefined'/.test(dash) && /jsQR\(/.test(dash));
ok('both libraries come from the CDNs the live wallet already uses',
  /qrcode\.js\/1\.5\.3/.test(dash) && /jsqr@1\.4\.0/.test(dash));
ok('the merchant code is shown for reconciliation',
  /Merchant wallet/.test(dash) && /merchant\.code/.test(dash));
ok('the merchant can charge a customer', /Request payment from a customer/.test(dash));
ok('the tenant can pay as a client', /Client wallet/.test(dash));
ok('both wallet directions are on the same page',
  /spScanPayFormsHtml/.test(dash) && /spScanPayTablesHtml/.test(dash));
ok('collections are shown with a status badge', /Recent collections/.test(dash) && /badge\(c\.status/.test(dash));

// ---- 9. the Micro1 hand-off ------------------------------------------------
ok('Writer\'s Flow carries a Connect Micro1 button', /id="wfMicro1Btn"/.test(dash));
ok('the Micro1 button points at the referral opportunities page',
  /href="https:\/\/refer\.micro1\.ai\/opportunities"/.test(dash));
ok('the Micro1 button opens a new tab without handing over the opener',
  /id="wfMicro1Btn"[\s\S]{0,240}rel="noopener noreferrer"/.test(dash),
  'anchor does not close with rel=noopener');
ok('the Micro1 button is on the Writer\'s Flow section, not inside one tab',
  dash.indexOf('id="wfMicro1Btn"') < dash.indexOf('data-tab="outreach"'));

// ---- 10. the page the customer opens --------------------------------------
ok('the customer pay page exists', fs.existsSync('public/pay.html'));
const payPage = fs.readFileSync('public/pay.html', 'utf8');
ok('the customer pay page is not indexable', /name="robots" content="noindex,nofollow"/.test(payPage));
ok('the customer pay page resolves the payment link', /\/api\/kassangas\/template\//.test(payPage));
ok('the customer pay page posts its own prompt', /\/pay\/t\//.test(payPage) && /\/intent/.test(payPage));
ok('the customer pay page says nothing is charged before the PIN',
  /Nothing is charged until you enter your PIN/.test(payPage));
ok('the customer pay page explains a dead link', /not available/.test(payPage));
ok('the customer pay page loads no third-party script', !/<script[^>]+src=/.test(payPage));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
