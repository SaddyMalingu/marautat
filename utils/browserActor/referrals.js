/**
 * Referral resolution (2026-10-31, corrected)
 *
 * **A referral link belongs to an OFFER, not to a tenant.** Turing issues a link
 * per job (`/dashboard/job_referral`), and the Writer's Flow offer form stores one
 * `referral_url` per offer. So the question is never "which link does this tenant
 * use for Turing?" — it is "which link does this tenant already hold for *this
 * role*?" Getting that wrong puts role A's link on role B's page: the tenant still
 * gets paid, but for the wrong job, and the candidate lands somewhere that does not
 * match the page they just read.
 *
 * Resolution is therefore by ROLE IDENTITY, never by recency:
 *   1. exact `external_id` (e.g. `turing:project-lead-ai-training`) — stable
 *   2. title match, for offers created before the adapter existed
 *
 * Pure: no DB, no network. The caller passes the tenant's existing offers.
 */

/** Lookalike-safe hostname comparison: `work.turing.com` belongs to `turing.com`. */
export function isReferralUrlForHost(url, host) {
  const target = String(host || '').toLowerCase().trim();
  if (!target) return false;
  try {
    const actual = new URL(String(url || '')).hostname.toLowerCase();
    return actual === target || actual.endsWith(`.${target}`);
  } catch {
    return false;
  }
}

/** Same slug rule the adapter uses for ids, so both sides agree. */
export function slugifyTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Find the link this tenant already holds for one role.
 *
 * @param {Array<{id?:string, external_id?:string, title?:string, slug?:string,
 *                referral_url?:string}>} offers
 * @param {{externalId?: string|null, title?: string|null, host?: string}} role
 * @returns {{referralUrl: string|null, offerId: string|null,
 *            matchedBy: 'external_id'|'title'|null}}
 */
export function referralForRole(offers, { externalId = null, title = null, host = '' } = {}) {
  const rows = (Array.isArray(offers) ? offers : []).filter(Boolean);
  const wantedId = externalId ? String(externalId).trim() : null;
  const wantedTitle = title ? slugifyTitle(title) : null;

  const usable = (offer) => {
    const url = String(offer.referral_url || '').trim();
    // A link for another platform can never answer for this role.
    return url && (!host || isReferralUrlForHost(url, host));
  };

  if (wantedId) {
    const byId = rows.find((offer) => String(offer.external_id || '').trim() === wantedId && usable(offer));
    if (byId) {
      return { referralUrl: String(byId.referral_url).trim(), offerId: byId.id || null, matchedBy: 'external_id' };
    }
  }

  if (wantedTitle) {
    const byTitle = rows.find((offer) => {
      if (!usable(offer)) return false;
      const offerTitle = slugifyTitle(offer.title || offer.slug || '');
      return Boolean(offerTitle) && offerTitle === wantedTitle;
    });
    if (byTitle) {
      return { referralUrl: String(byTitle.referral_url).trim(), offerId: byTitle.id || null, matchedBy: 'title' };
    }
  }

  return { referralUrl: null, offerId: null, matchedBy: null };
}
