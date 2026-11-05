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
import { judgeWorkerReportedTitle, verifyReferralLink } from './referralVerify.js';
import { planReferralBackfill } from './tasks/turingReferrals.js';
import { planDescriptionUpdates } from './enrichment.js';
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
    if (error && String(error.code || '') === '23505') {
      /**
       * The unique slug index refused the batch — so the `existingOffers` snapshot was stale (a
       * `known` list from before another run, or a second machine). One bad row used to lose the
       * whole capture; inserting one at a time means the new roles land and the ones that already
       * exist are reported. Either way there is no duplicate: the database is the one deciding,
       * not this function's memory.
       */
      const inserted = [];
      for (const row of rows) {
        const single = await supabase
          .from('opportunities')
          .insert(row)
          .select('id, title, slug, referral_url');
        if (single.error) {
          result.skipped.push({ title: row.title, reason: 'exists_or_conflict' });
          continue;
        }
        inserted.push(...(Array.isArray(single.data) ? single.data : []));
      }
      result.inserted = inserted.length;
      result.created = inserted;
      result.conflicted = result.skipped.filter((row) => row.reason === 'exists_or_conflict').length;
      return { ...result, rows };
    }
    if (error) {
      result.error = error.message;
      return { ...result, rows };
    }
    result.inserted = Array.isArray(data) ? data.length : 0;
    result.created = data || [];
  }
  return { ...result, rows };
}

/**
 * Attach what a worker read to offers that **already exist** (2026-11-03).
 *
 * `applyCaptures` creates draft offers, which is what a Micro1 capture needs: the roles it
 * reads are new to the tenant. A Turing capture is the opposite case — the 78 offers are
 * already imported, and the capture brings the two things they are missing: the per-role
 * referral link and the full job body. Feeding those through the create path would insert
 * duplicates; the honest operation is an update, guarded by the same rule as everywhere else:
 * a link is written only if it provably resolves to the role it is attached to, and only into
 * an offer that has no link yet.
 *
 * Pure planners do the deciding (`planReferralBackfill`, `planDescriptionUpdates`); this only
 * performs what they planned.
 *
 * @returns {{links: object, descriptions: object}}
 */
export async function applyCaptureUpdates({ supabase, offers = [], captures = [], verify = verifyReferralLink, apply = true } = {}) {
  const rows = Array.isArray(offers) ? offers : [];
  const linkPlan = planReferralBackfill({ offers: rows, captures });
  const verification = [];
  const accepted = [];
  for (const update of linkPlan.updates) {
    const check = await verify({ url: update.referral_url, expectedTitle: update.title });
    /**
     * When the server cannot read the page, ask the browser that minted the link.
     *
     * Turing renders roles in JavaScript: a fetch from Render gets the shell and a generic title,
     * which on 2026-11-04 refused 120 correct links as `unverified_mismatch`. The worker opened
     * each role in the tenant's own signed-in session and reported its `<title>`; that evidence is
     * judged with the same rules, so a link is still only attached when the title matches the role.
     */
    let verdict = check.verdict;
    let reason = check.reason;
    let resolvedTitle = check.resolvedTitle || null;
    let source = 'server';
    if (verdict === 'unresolvable' && update.pageTitle) {
      const byWorker = judgeWorkerReportedTitle({ expectedTitle: update.title, pageTitle: update.pageTitle });
      if (byWorker.verdict === 'match') {
        verdict = 'match';
        reason = byWorker.reason;
        resolvedTitle = byWorker.resolvedTitle;
        source = 'worker';
      }
    }
    verification.push({
      title: update.title,
      referral_url: update.referral_url,
      verdict,
      reason,
      resolvedTitle,
      source
    });
    if (verdict === 'match') accepted.push(update);
    else {
      // Carry the evidence, not just the verdict: "unverified_mismatch" twelve times tells the
      // tenant nothing, while the title we actually got back names the cause (a login page, a
      // redirect, a wrong link). 120 rejections in one run on 2026-11-04 were undiagnosable
      // because only the reason string survived.
      linkPlan.skipped.push({
        title: update.title,
        reason: `unverified_${verdict}`,
        resolvedTitle,
        detail: reason || null,
        // Say what would fix it, so the panel and the worker window can repeat it.
        hint: verdict === 'unresolvable'
          ? 'the page could not be read from here — capture the role again so its browser title travels with the link'
          : null
      });
    }
  }

  const links = {
    planned: accepted.length,
    updated: 0,
    skipped: linkPlan.skipped,
    conflicts: linkPlan.conflicts,
    verification
  };

  if (apply) {
    for (const update of accepted) {
      if (!update.id) { links.skipped.push({ title: update.title, reason: 'no_id' }); continue; }
      const { data, error } = await supabase
        .from('opportunities')
        .update({ referral_url: update.referral_url, updated_at: new Date().toISOString() })
        .eq('id', update.id)
        // `.is('referral_url', null)` is the compare-and-set: a link someone attached while
        // this run was driving the browser must not be overwritten by a slower capture.
        .is('referral_url', null)
        .select('id, title');
      if (error) { links.skipped.push({ title: update.title, reason: error.message }); continue; }
      links.updated += Array.isArray(data) ? data.length : 0;
    }
  }

  // Descriptions are a second, independent win: a capture that failed to mint a link may still
  // have read the body, and a body that is already long enough is skipped rather than rewritten.
  const descriptionPlan = planDescriptionUpdates({ captures, offers: rows });
  const descriptions = { planned: descriptionPlan.updates.length, updated: 0, skipped: descriptionPlan.skipped };
  if (apply) {
    for (const update of descriptionPlan.updates) {
      if (!update.id) { descriptions.skipped.push({ title: update.title, reason: 'no_id' }); continue; }
      const { data, error } = await supabase
        .from('opportunities')
        .update({ description: update.description, updated_at: new Date().toISOString() })
        .eq('id', update.id)
        .select('id, title');
      if (error) { descriptions.skipped.push({ title: update.title, reason: error.message }); continue; }
      descriptions.updated += Array.isArray(data) ? data.length : 0;
    }
  }

  return { links, descriptions };
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
