/**
 * Offer patch validation (2026-10-31)
 *
 * The portal could create and delete offers but not edit them, so a tenant had no
 * way to add the one thing that earns: the per-role referral link. This is the
 * allowlist behind `PATCH /tenant/blogger/offers/:id`.
 *
 * Deliberately NOT patchable:
 *   slug          — globally UNIQUE and already published/links depend on it
 *   status        — publishing is its own action with its own side effects
 *   tenant_id     — the route scopes by session; accepting it here would be a
 *                   cross-tenant write waiting to happen
 *   id, source_id, created_at, updated_at — not the tenant's to set
 *
 * Anything outside the allowlist is dropped rather than rejected, so an older
 * client posting the whole row does not fail; the response says what changed.
 */

export const PATCHABLE_FIELDS = Object.freeze([
  'title',
  'description',
  'referral_url',
  'destination_url',
  'cta_label',
  'offer_type',
  'category_id',
  'compensation_max',
  'compensation_currency',
  'location_text'
]);

const LOCKED_FIELDS = Object.freeze(['id', 'slug', 'status', 'tenant_id', 'source_id', 'created_at', 'updated_at', 'published_at']);
const URL_FIELDS = Object.freeze(['referral_url', 'destination_url']);
const OFFER_TYPES = Object.freeze(['job', 'product', 'service', 'brand', 'affiliate', 'course']);

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @returns {{patch: object, ignored: string[], errors: string[]}}
 */
export function sanitizeOfferPatch(body = {}) {
  const patch = {};
  const ignored = [];
  const errors = [];
  const input = body && typeof body === 'object' ? body : {};

  for (const key of Object.keys(input)) {
    if (LOCKED_FIELDS.includes(key)) { ignored.push(key); continue; }
    if (!PATCHABLE_FIELDS.includes(key)) { ignored.push(key); continue; }
    const raw = input[key];

    if (URL_FIELDS.includes(key)) {
      const value = raw == null ? '' : String(raw).trim();
      if (!value) { patch[key] = null; continue; }
      if (!isHttpUrl(value)) { errors.push(`${key} must be an http(s) URL`); continue; }
      patch[key] = value;
      continue;
    }

    if (key === 'compensation_max') {
      if (raw === '' || raw == null) { patch[key] = null; continue; }
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 0) { errors.push('compensation_max must be a positive number'); continue; }
      patch[key] = amount;
      continue;
    }

    if (key === 'offer_type') {
      const type = String(raw || '').trim().toLowerCase();
      if (!OFFER_TYPES.includes(type)) { errors.push(`offer_type must be one of: ${OFFER_TYPES.join(', ')}`); continue; }
      patch[key] = type;
      continue;
    }

    const value = raw == null ? '' : String(raw).trim();
    if (key === 'title' && !value) { errors.push('title cannot be empty'); continue; }
    patch[key] = value || null;
  }

  if (!Object.keys(patch).length && !errors.length) {
    errors.push('nothing to update');
  }
  return { patch, ignored, errors };
}
