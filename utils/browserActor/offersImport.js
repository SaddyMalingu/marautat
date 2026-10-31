/**
 * Marketplace roles -> tenant offers (2026-10-31)
 *
 * The offers the portal shows are rows in `opportunities` (see POST
 * /tenant/blogger/offers, server.js:4941). Three facts shape this module:
 *
 *   1. **`slug` is globally UNIQUE** across every tenant *and* the legacy Mercor
 *      catalogue. So a slug cannot be just the role title: two tenants both
 *      finding "Project Lead - AI Training" must not fight over one row.
 *   2. **A referral link belongs to one offer.** Re-running an import must never
 *      overwrite an existing row's `referral_url`, or a tenant silently loses the
 *      link they pasted for that specific role.
 *   3. **Nothing is published by an agent.** Every row lands as `status: 'draft'`.
 *
 * `planOfferImport` is pure: it takes the roles, the tenant's existing offers, and
 * returns what it *would* write. The caller decides whether to apply it.
 */

const MAX_SLUG = 60;

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG);
}

/**
 * Deterministic, tenant-scoped, collision-resistant slug.
 * `malingu-ventures` + `turing` + `Project Lead - AI Training`
 *   -> `malingu-ventures-turing-project-lead-ai-training` (truncated).
 * Re-running yields the same slug, which is what makes the import idempotent.
 */
export function offerSlugFor({ tenantSlug, sourceSlug, title }) {
  const tenant = slugify(tenantSlug).slice(0, 20);
  const source = slugify(sourceSlug).slice(0, 12);
  const role = slugify(title) || 'role';
  const prefix = [tenant, source].filter(Boolean).join('-');
  return (prefix ? `${prefix}-${role}` : role).slice(0, MAX_SLUG).replace(/-+$/g, '');
}

/**
 * @param {{items: object[], existingOffers?: object[], tenantSlug: string,
 *          tenantId: string, sourceSlug: string, sourceId?: string|null,
 *          host?: string, now?: string}} input
 * @returns {{create: object[], skipped: {title: string, reason: string}[],
 *            needsReferral: string[], tenantSlug: string}}
 */
export function planOfferImport({
  items = [],
  existingOffers = [],
  tenantSlug = '',
  tenantId = '',
  sourceSlug = '',
  sourceId = null,
  host = '',
  now = new Date().toISOString()
} = {}) {
  if (!tenantSlug) throw new Error('planOfferImport needs a tenant slug — offers are tenant-scoped');
  if (!tenantId) throw new Error('planOfferImport needs the tenant id the offers belong to');

  const existing = (Array.isArray(existingOffers) ? existingOffers : []).filter(Boolean);
  const takenSlugs = new Set(existing.map((offer) => String(offer.slug || '').toLowerCase()).filter(Boolean));
  const takenTitles = new Set(existing.map((offer) => slugify(offer.title)).filter(Boolean));
  const takenExternal = new Set(existing.map((offer) => String(offer.external_id || '').trim()).filter(Boolean));

  const create = [];
  const skipped = [];
  const needsReferral = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const title = String(item?.title || '').trim();
    if (!title) {
      skipped.push({ title: '', reason: 'no_title' });
      continue;
    }
    const slug = offerSlugFor({ tenantSlug, sourceSlug, title });

    if (seen.has(slug)) { skipped.push({ title, reason: 'duplicate_in_batch' }); continue; }
    seen.add(slug);

    // Already imported (or created by hand with the same slug): leave it alone.
    // Skipping is what protects an existing referral_url.
    if (item.externalId && takenExternal.has(String(item.externalId).trim())) {
      skipped.push({ title, reason: 'exists_by_external_id' });
      continue;
    }
    if (takenSlugs.has(slug)) { skipped.push({ title, reason: 'exists' }); continue; }
    // An offer the tenant created manually under another slug still counts.
    if (takenTitles.has(slugify(title))) { skipped.push({ title, reason: 'exists_by_title' }); continue; }

    const amount = String(item.rate || '').match(/\d[\d,]*/);
    const compensation = amount ? Number(amount[0].replace(/,/g, '')) : null;

    create.push({
      tenant_id: tenantId,
      source_id: sourceId || null,
      title,
      slug,
      // `external_id` exists on `opportunities` even though the portal's own
      // create route does not set it. Storing it makes per-role referral matching
      // exact instead of title-guesswork.
      external_id: item.externalId || null,
      description: item.summary || null,
      offer_type: 'job',
      compensation_max: Number.isFinite(compensation) ? compensation : null,
      compensation_currency: 'USD',
      location_text: null,
      destination_url: item.url || null,
      // Left null until this role's own link exists; see the note below.
      referral_url: null,
      cta_label: 'Apply through this link',
      skills: [],
      status: 'draft',
      created_at: now,
      updated_at: now
    });
    needsReferral.push(title);
  }

  return { create, skipped, needsReferral, tenantSlug };
}

/**
 * Fill in each new row's referral link from the tenant's own history, by ROLE.
 *
 * Deliberately separate from planning: a role with no link yet is still worth
 * importing (the page can be written and the tenant pastes the link before
 * publishing), but a role must never borrow another role's link.
 */
export function attachReferrals(plan, { existingOffers = [], referralForRole, host = '' } = {}) {
  if (typeof referralForRole !== 'function') {
    throw new Error('attachReferrals needs referralForRole');
  }
  const withLinks = plan.create.map((row) => {
    const match = referralForRole(existingOffers, { externalId: row.external_id, title: row.title, host });
    return match && match.referralUrl ? { ...row, referral_url: match.referralUrl } : row;
  });
  const stillMissing = withLinks.filter((row) => !row.referral_url).map((row) => row.title);
  return { ...plan, create: withLinks, needsReferral: stillMissing };
}
