/**
 * Scan to Pay — the rules shared by the tenant merchant wallet and client wallet.
 *
 * The platform already runs a QR → M-Pesa STK flow for Kassangas
 * (`public/kassangas-merchant-portal.html`, `public/kassangas-client-wallet.html`,
 * `kassangas_templates`, `subscriptions`). Rather than build a second payment
 * engine, the tenant portal reuses that stack: this module owns the parts that
 * must agree everywhere (phone normalisation, link validation, the merchant code
 * a tenant's collections are stamped with, the pay URL, and the "table missing"
 * message that names the migration).
 *
 * Pure functions only: no express, no supabase, no env reads except the optional
 * `env` argument. `scripts/test_scan_pay.mjs` exercises every export offline.
 */

/** subscriptions.plan_type for every tenant scan-to-pay collection. */
export const PLAN_TYPE = 'tenant_scan_pay';

/** The QR-payment table the live Kassangas flow already writes to. */
export const TEMPLATES_TABLE = 'kassangas_templates';

/** The file a deployment must run once before links can be created. */
export const TEMPLATES_MIGRATION = 'SQL_MIGRATION_KASSANGAS_PHASE1.sql';

export const LINK_NAME_MIN = 2;
export const LINK_NAME_MAX = 120;
export const LINK_MIN_AMOUNT = 1;
export const LINK_MAX_AMOUNT = 300000;

/** Env vars `initiateStkPush()` needs before it can send a prompt. */
export const STK_ENV_VARS = [
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_PASSKEY',
  'MPESA_SHORTCODE',
  'MPESA_CALLBACK_URL',
];

/**
 * Kenyan MSISDN → 2547XXXXXXXX. Accepts 07XXXXXXXX, 7XXXXXXXX, +2547XXXXXXXX and
 * 2547XXXXXXXX. Returns the digits as given when they do not match, so the caller
 * can reject with one message instead of guessing.
 */
export function normalizeMsisdn(raw) {
  let v = String(raw ?? '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (/^0[17]\d{8}$/.test(v)) v = '254' + v.slice(1);
  else if (/^[17]\d{8}$/.test(v)) v = '254' + v;
  return v;
}

/** Safaricom mobile number in the shape the STK endpoint accepts. */
export function isValidPayerPhone(raw) {
  return /^2547\d{8}$/.test(normalizeMsisdn(raw));
}

/**
 * The code a tenant's collections are reconciled against. Derived from the
 * tenant's own phone (the platform's tenant key), so it is stable across
 * deploys, unique per tenant and safe inside an M-Pesa account reference
 * (alphanumerics only — the existing Kassangas refs use hyphens, but a paybill
 * statement reads cleanest without punctuation).
 */
export function tenantMerchantCode({ phone, slug } = {}) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 9) return 'SP' + digits.slice(-6);
  const seed = String(slug || 'tenant').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 4) || 'tnnt';
  return 'SP' + seed.toUpperCase() + String(fnv1a(String(slug || phone || ''))).slice(0, 2);
}

/** FNV-1a, so the fallback code is deterministic and does not need a database. */
export function fnv1a(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase();
}

/** One account reference per collection attempt. */
export function buildAccountRef(merchantCode, now = Date.now()) {
  const code = String(merchantCode || 'SP').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'SP';
  return code + Number(now).toString(36).toUpperCase();
}

/** The link a customer opens after scanning the poster QR. */
export function payUrl(baseUrl, templateId) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/pay/t/${encodeURIComponent(String(templateId || ''))}`;
}

/** A tenant may paste either the full link or the bare token. */
export function extractTemplateId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const fromPath = s.match(/\/pay\/t\/([A-Za-z0-9_-]{4,120})/);
  if (fromPath) return fromPath[1];
  const fromQuery = s.match(/[?&]t=([A-Za-z0-9_-]{4,120})/);
  if (fromQuery) return fromQuery[1];
  return /^[A-Za-z0-9_-]{4,120}$/.test(s) ? s : '';
}

/** Human-readable template id, same shape as the live Kassangas flow. */
export function buildTemplateId(now = Date.now(), random = Math.random()) {
  const stamp = String(now).slice(-6);
  const tail = String(random).replace(/[^0-9a-z]/gi, '').slice(2, 8).toUpperCase().padEnd(6, '0');
  return `TMPL-${stamp}-${tail}`;
}

/**
 * Validate what the merchant typed before anything is written. Returns
 * `{ ok, error }` on failure and the cleaned values on success.
 */
export function validateLinkInput(input = {}) {
  const itemName = String(input.itemName ?? input.item_name ?? '')
    .replace(/\s+/g, ' ').trim();
  const amount = Number(input.amount);

  if (itemName.length < LINK_NAME_MIN) {
    return { ok: false, error: 'Give the payment link a name (at least 2 characters).' };
  }
  if (itemName.length > LINK_NAME_MAX) {
    return { ok: false, error: `Keep the name under ${LINK_NAME_MAX} characters.` };
  }
  if (!Number.isFinite(amount) || amount < LINK_MIN_AMOUNT) {
    return { ok: false, error: 'Enter an amount of at least KES 1.' };
  }
  if (amount > LINK_MAX_AMOUNT) {
    return { ok: false, error: `Amounts above KES ${LINK_MAX_AMOUNT.toLocaleString('en-KE')} need a bank transfer — contact Alphadome.` };
  }

  return {
    ok: true,
    itemName,
    // Safaricom accepts whole shillings only, so the amount the prompt carries and
    // the amount the ledger records have to be the same integer.
    amount: Math.round(amount),
    reusable: input.reusable !== false,
  };
}

/** Payer phones in the collections table are masked: the portal is not a phone book. */
export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 6) return '';
  return digits.slice(0, 4) + '***' + digits.slice(-2);
}

/** A payment link as the portal renders it. */
export function shapeLink({ row = {}, baseUrl = '', stats = {} } = {}) {
  const templateId = String(row.template_id || '');
  return {
    templateId,
    itemName: String(row.item_name || ''),
    amount: Number(row.amount) || 0,
    reusable: row.reusable !== false,
    merchantName: String(row.merchant_name || ''),
    status: String(row.status || 'active'),
    createdAt: row.created_at || null,
    url: templateId ? payUrl(baseUrl, templateId) : '',
    paidCount: Number(stats.paidCount) || 0,
    collected: Number(stats.collected) || 0,
    pending: Number(stats.pending) || 0,
  };
}

const PAID_STATUSES = new Set(['completed', 'paid', 'success', 'succeeded']);

/** One collection row as the portal renders it. */
export function describeCollection(row = {}) {
  const status = String(row.status || 'pending').toLowerCase();
  return {
    id: row.id || null,
    amount: Number(row.amount) || 0,
    status,
    payer: maskPhone(row.phone),
    accountRef: String(row.account_ref || ''),
    itemName: String(row?.metadata?.item_name || ''),
    source: String(row?.metadata?.source || ''),
    createdAt: row.created_at || null,
  };
}

/** Totals for the merchant wallet header. */
export function summariseCollections(rows = []) {
  return (rows || []).reduce((acc, row) => {
    const amount = Number(row?.amount) || 0;
    const status = String(row?.status || '').toLowerCase();
    acc.count++;
    if (PAID_STATUSES.has(status)) acc.collected += amount;
    else if (status === 'pending') acc.pending += amount;
    else acc.failed += amount;
    return acc;
  }, { count: 0, collected: 0, pending: 0, failed: 0 });
}

/** Per-link totals, keyed by template id, from the collections rows. */
export function statsByTemplate(rows = []) {
  const out = {};
  (rows || []).forEach((row) => {
    const id = row?.metadata?.template_id;
    if (!id) return;
    const bucket = out[id] || (out[id] = { paidCount: 0, collected: 0, pending: 0 });
    const amount = Number(row?.amount) || 0;
    const status = String(row?.status || '').toLowerCase();
    if (PAID_STATUSES.has(status)) { bucket.paidCount++; bucket.collected += amount; }
    else if (status === 'pending') bucket.pending++;
  });
  return out;
}

/** True when the QR table has not been created in this deployment yet. */
export function isMissingTableError(err) {
  const code = String(err?.code || '');
  const message = String(err?.message || err || '');
  return code === '42P01' || code === 'PGRST205'
    || /could not find the table|relation .* does not exist/i.test(message);
}

export function missingTemplatesMessage() {
  return `Payment links need the ${TEMPLATES_TABLE} table. Run ${TEMPLATES_MIGRATION} in Supabase, then retry.`;
}

/**
 * What is missing before a prompt can be sent. The portal shows this instead of
 * letting `initiateStkPush()` fail with a generic "Missing required M-Pesa
 * credentials" after the tenant has already typed the customer's phone number.
 */
export function stkReadiness(env = {}) {
  const missing = STK_ENV_VARS.filter((key) => !env || !env[key]);
  return { ready: missing.length === 0, missing };
}

export function stkReadinessMessage(missing = []) {
  return `M-Pesa is not configured on this deployment yet (missing: ${missing.join(', ') || 'MPESA_*'}). Add the credentials in Render, then retry.`;
}
