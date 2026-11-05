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
 * Which roles already have a referral link — keyed by title, never by card index (2026-11-05).
 *
 * Two reasons this is a named function rather than three lines inside the loop:
 *
 *   1. **The index is not an identity.** Turing's listing is newest-first, so a role published this
 *      morning shifts every index below it. The progress file stores `index → capture`, and a resume
 *      that trusts it skips a role it never captured while re-capturing one it already had.
 *   2. **The worker has no memory.** Every download lands in a new folder, so `tmp/referrals.json`
 *      starts empty and local resume is worth nothing. The only durable answer to "what do I already
 *      own" is the portal's own rows, which is why `referral_url` now travels in `/context`.
 *
 * Returns a Set of `slugifyTitle` keys — the same key `planReferralBackfill` matches on.
 */
export function linkedTitleSet({ offers = [], captures = [] } = {}) {
  const titles = new Set();
  for (const offer of Array.isArray(offers) ? offers : []) {
    if (!String(offer?.referral_url || '').trim()) continue;
    const key = slugifyTitle(offer.title || offer.slug || '');
    if (key) titles.add(key);
  }
  // A capture that already carries a link counts even if the portal refused it later: the link was
  // minted, so re-opening the role only adds traffic, not certainty.
  for (const capture of Array.isArray(captures) ? captures : []) {
    if (!String(capture?.referralUrl || '').trim()) continue;
    const key = slugifyTitle(capture.title || '');
    if (key) titles.add(key);
  }
  return titles;
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
