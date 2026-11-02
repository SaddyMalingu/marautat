/**
 * Captures -> tenant offers (2026-11-02)
 *
 * Extracted from `browser_actor_micro1.mjs` when the tenant worker arrived, because there
 * are now two callers and they must not drift:
 *
 *   - the operator script, which holds a Supabase client;
 *   - `POST /api/agent/runs/:id/result`, where a **tenant's own machine** sends what it saw
 *     and the server writes it.
 *
 * The second caller is the reason this lives server-side at all: a machine that only has a
 * worker token must not also need a service-role key. Writing offers is a privileged act, so
 * it happens where the privilege already is.
 *
 * Two rules carried over from Turing, because they are about the marketplace being external
 * rather than about Turing:
 *   - a link is only attached if it provably lands on its own role (`verifyReferralLink`)
 *   - an existing offer is never touched (`planOfferImport` skips by external_id, slug and
 *     title), which is what protects a link the tenant pasted by hand
 */
import { verifyReferralLink } from './referralVerify.js';
import { planOfferImport } from './offersImport.js';
import { describeEnrichment } from './enrichment.js';

/**
 * @param {{supabase: object, tenant: {id: string, slug: string}, offers?: object[],
 *          sourceId?: string|null, sourceSlug: string, captures: object[],
 *          apply?: boolean, verify?: Function}} input
 */
export async function applyCaptures({
  supabase,
  tenant,
  offers = [],
  sourceId = null,
  sourceSlug,
  captures = [],
  apply = true,
  verify = verifyReferralLink
} = {}) {
  if (!tenant?.id) throw new Error('applyCaptures needs the tenant id — offers are tenant-scoped');
  if (!sourceSlug) throw new Error('applyCaptures needs a source slug');

  const verification = [];
  for (const capture of captures) {
    if (!capture.referralUrl) continue;
    const check = await verify({ url: capture.referralUrl, expectedTitle: capture.title });
    verification.push({
      title: capture.title,
      jobId: capture.jobId,
      referral_url: capture.referralUrl,
      verdict: check.verdict,
      reason: check.reason,
      resolvedTitle: check.resolvedTitle || null
    });
    // A link that does not land on its own role is worse than no link: it drives the
    // tenant's candidate to somebody else's job.
    if (check.verdict !== 'match') {
      capture.reason = `unverified_${check.verdict}`;
      capture.referralUrl = null;
    }
  }

  const items = captures
    .filter((capture) => capture.title && capture.jobId)
    .map((capture) => ({
      title: capture.title,
      externalId: capture.externalId,
      summary: capture.content || capture.summary || null,
      rate: capture.rate || null,
      url: capture.url || null
    }));

  const plan = planOfferImport({
    items,
    existingOffers: offers,
    tenantSlug: tenant.slug,
    tenantId: tenant.id,
    sourceSlug,
    sourceId
  });

  // The body and the verified link are attached after planning, so the planner stays the
  // single place that decides *whether* a row is created.
  const byJobId = new Map(captures.filter((c) => c.jobId).map((c) => [c.jobId, c]));
  const rows = plan.create.map((row) => {
    const jobId = String(row.external_id || '').replace(/^micro1:/, '');
    const capture = byJobId.get(jobId) || null;
    if (!capture) return row;
    return {
      ...row,
      description: capture.content || row.description,
      destination_url: capture.url || row.destination_url,
      referral_url: capture.referralUrl || null
    };
  });

  const withLinks = rows.filter((row) => row.referral_url).length;
  const result = {
    planned: rows.length,
    skipped: plan.skipped,
    withLinks,
    withoutLinks: rows.length - withLinks,
    verification,
    inserted: 0,
    error: null
  };

  if (!apply) return { ...result, rows };

  if (rows.length) {
    const { data, error } = await supabase.from('opportunities').insert(rows).select('id, title, slug, referral_url');
    if (error) {
      result.error = error.message;
      return { ...result, rows };
    }
    result.inserted = Array.isArray(data) ? data.length : 0;
    result.created = data || [];
  }
  return { ...result, rows };
}

/** Coverage as the database holds it now — not as the loop hoped. */
export async function readCoverage(supabase, tenantId) {
  const { data, error } = await supabase
    .from('opportunities')
    .select('id, title, external_id, description, deleted_at')
    .eq('tenant_id', tenantId);
  if (error) return null;
  const live = (data || []).filter((row) => row.deleted_at == null);
  return describeEnrichment(live);
}
