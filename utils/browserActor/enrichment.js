/**
 * Offer enrichment (2026-11-01)
 *
 * A marketplace role has two layers: a one-line tile summary and the real job page.
 * Publishing only the tile made every offer look like it had no detail — measured at a
 * median of 73 characters across 96 offers — so a capture must carry both, and the
 * write must prefer the fuller one.
 *
 * Everything here is marketplace-agnostic except `CONTENT_EXTRACTORS`, which is a
 * registry: adding Micro1 means adding one entry, and the rest of the pipeline
 * (capture, plan, write, verify) is unchanged.
 *
 * Pure: no network, no database. The caller passes captures and offers.
 */
import { TURING_DETAIL_CONTENT_EXPR } from './tasks/turingReferrals.js';
import { MICRO1_DETAIL_CONTENT_EXPR } from './tasks/micro1.js';

/** Below this, a description is a tile summary rather than a job. */
export const MIN_FULL_DESCRIPTION_CHARS = 300;

/** A replacement must beat the current text by this much to be worth a write. */
export const MIN_DESCRIPTION_GAIN = 40;

/**
 * Per-marketplace page extractors.
 *
 * Adding a marketplace is one entry here. `micro1` was added on 2026-11-02 after its
 * adapter was verified live: its job page is client-rendered (48 KB of HTML, 57
 * characters of text, no JSON-LD), which is exactly why this is a *page* expression and
 * not a fetch. Turing and Micro1 now go through the same plan/write/verify path.
 */
export const CONTENT_EXTRACTORS = Object.freeze({
  turing: TURING_DETAIL_CONTENT_EXPR,
  micro1: MICRO1_DETAIL_CONTENT_EXPR
});


/** The page expression for a platform, or null when none is registered. */
export function contentExprFor(platform) {
  return CONTENT_EXTRACTORS[String(platform || '').toLowerCase()] || null;
}

/** Is this text too short to be a job description? */
export function isThinDescription(text, minChars = MIN_FULL_DESCRIPTION_CHARS) {
  return String(text || '').trim().length < minChars;
}

/**
 * Which offers these captures can improve, and to what.
 *
 * Matching is by `external_id` only. A title match would put one role's body on
 * another role's page, which is the same class of mistake as a wrong referral link.
 * Only ever grows: a capture never shortens a description that already exists.
 */
export function planDescriptionUpdates({
  captures = [],
  offers = [],
  minGain = MIN_DESCRIPTION_GAIN
} = {}) {
  const byExternal = new Map();
  for (const offer of Array.isArray(offers) ? offers : []) {
    const key = String(offer?.external_id || '').trim();
    if (key) byExternal.set(key, offer);
  }

  const updates = [];
  const skipped = [];
  for (const capture of Array.isArray(captures) ? captures : []) {
    const body = String(capture?.content || '').trim();
    const externalId = String(capture?.externalId || '').trim();
    if (!body || !externalId) continue;
    const offer = byExternal.get(externalId);
    if (!offer) {
      skipped.push({ externalId, reason: 'no_offer_for_role' });
      continue;
    }
    const existing = String(offer.description || '').trim();
    if (body.length <= existing.length + minGain) {
      skipped.push({ externalId, reason: 'already_at_least_as_full' });
      continue;
    }
    updates.push({
      id: offer.id,
      externalId,
      title: offer.title,
      from: existing.length,
      to: body.length,
      description: body
    });
  }
  return { updates, skipped };
}

/**
 * Marketplace offers that still show a tile summary.
 *
 * Marketplace only: a hand-written offer has no source page to read, so reporting it
 * as "missing" would ask the agent to invent content for it.
 */
export function findThinMarketplaceOffers(offers = [], { minChars = MIN_FULL_DESCRIPTION_CHARS } = {}) {
  return (Array.isArray(offers) ? offers : [])
    .filter((offer) => offer && String(offer.external_id || '').trim())
    .filter((offer) => isThinDescription(offer.description, minChars))
    .map((offer) => ({
      id: offer.id || null,
      externalId: String(offer.external_id || '').trim(),
      title: offer.title || null,
      chars: String(offer.description || '').trim().length
    }));
}

/** Coverage summary a run can print, and a tenant can act on. */
export function describeEnrichment(offers = [], { minChars = MIN_FULL_DESCRIPTION_CHARS } = {}) {
  const rows = (Array.isArray(offers) ? offers : []).filter(Boolean);
  const marketplace = rows.filter((offer) => String(offer.external_id || '').trim());
  const full = marketplace.filter((offer) => !isThinDescription(offer.description, minChars));
  const thin = findThinMarketplaceOffers(rows, { minChars });
  const lengths = full.map((offer) => String(offer.description || '').trim().length).sort((a, b) => a - b);
  return {
    marketplace: marketplace.length,
    full: full.length,
    thin: thin.length,
    medianChars: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0,
    thinOffers: thin
  };
}
