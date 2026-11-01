/**
 * Marketplace coverage (2026-10-31)
 *
 * The collector's progress file lives on the operator's machine, because the
 * browser does. The portal runs elsewhere and cannot read it — so the portal shows
 * what actually survived the trip: how many roles were captured per marketplace,
 * how many are live, and how many still have no referral link (i.e. are earning
 * nothing).
 *
 * Pure: the route passes the tenant's offer rows, joined to their source.
 */

const EMPTY = { total: 0, published: 0, drafts: 0, missingReferral: 0, verified: 0, wrong: 0 };

/**
 * Which marketplace owns this offer.
 *
 * `source_id` is the correct answer, but it is null on rows imported before the
 * `opportunity_sources` seed was applied — and reporting 30 offers as
 * "Unattributed" tells a tenant nothing. The importer's own slug convention
 * (`<tenant>-<source>-<role>`) is our data, not a guess about the marketplace, so
 * it is used as the fallback.
 */
const SLUG_SOURCES = [
  ['turing', 'Turing'],
  ['micro1', 'Micro1'],
  ['mercor', 'Mercor']
];

function sourceOf(offer) {
  if (offer.source?.slug) {
    return { slug: String(offer.source.slug), name: String(offer.source.name || offer.source.slug) };
  }
  const slug = String(offer.slug || '').toLowerCase();
  for (const [key, name] of SLUG_SOURCES) {
    if (slug.includes(`-${key}-`)) return { slug: key, name };
  }
  return { slug: 'unsourced', name: 'Unattributed' };
}

export function summarizeCoverage(offers = []) {
  const bySource = new Map();
  let total = 0;
  let published = 0;
  let drafts = 0;
  let missingReferral = 0;
  let verified = 0;
  let wrong = 0;

  for (const offer of Array.isArray(offers) ? offers : []) {
    if (!offer) continue;
    total += 1;

    const isPublished = String(offer.status || '').toLowerCase() === 'published';
    const hasReferral = Boolean(String(offer.referral_url || '').trim());
    // A verdict is only meaningful for a link that exists; the audit writes one of
    // 'match' | 'mismatch' | 'unresolvable', and null means "never checked".
    const verdict = hasReferral ? String(offer.link_verdict || '').toLowerCase() : '';
    const isVerified = verdict === 'match';
    const isWrong = verdict === 'mismatch';

    if (isPublished) published += 1; else drafts += 1;
    if (!hasReferral) missingReferral += 1;
    if (isVerified) verified += 1;
    if (isWrong) wrong += 1;

    const { slug, name } = sourceOf(offer);
    const row = bySource.get(slug) || { slug, name, ...EMPTY };
    row.total += 1;
    if (isPublished) row.published += 1; else row.drafts += 1;
    if (!hasReferral) row.missingReferral += 1;
    if (isVerified) row.verified += 1;
    if (isWrong) row.wrong += 1;
    bySource.set(slug, row);
  }

  return {
    total,
    published,
    drafts,
    missingReferral,
    verified,
    wrong,
    // How many links exist but have never been resolved. Not an error — just unknown.
    uncheckedLinks: Math.max(0, total - missingReferral - verified - wrong),
    // Most-captured marketplace first: that is the one earning the most attention.
    sources: [...bySource.values()].sort((a, b) => b.total - a.total)
  };
}

/** One line a tenant can read without interpreting numbers. */
export function coverageHeadline(summary) {
  if (!summary || !summary.total) return 'No marketplace roles captured yet.';
  const parts = summary.sources.map(
    (s) => `${s.name}: ${s.total} captured, ${s.published} live, ${s.missingReferral} without a referral link`
  );
  const line = parts.join(' · ');
  if (summary.wrong) {
    // Lead with the thing that costs money, not with the total.
    return `${summary.wrong} referral link${summary.wrong === 1 ? '' : 's'} point at the wrong job · ${line}`;
  }
  if (summary.verified) {
    return `${summary.verified} referral link${summary.verified === 1 ? '' : 's'} verified · ${line}`;
  }
  return line;
}
