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
import { judgeWorkerReportedTitle, resolveLinkVerdict, verifyReferralLink } from './referralVerify.js';
import { planReferralBackfill } from './tasks/turingReferrals.js';
import { referralAttribution, titleKey } from './tasks/micro1Referrals.js';
import { planDescriptionUpdates } from './enrichment.js';
import { planOfferImport } from './offersImport.js';
import { describeEnrichment } from './enrichment.js';
import { referralCodeOf } from './referralCode.js';

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
  verify = verifyReferralLink,
  // Set by a re-mint run: a stored link that carries a code but was never minted for this tenant is replaceable.
  allowReplacePayable = false
} = {}) {
  if (!tenant?.id) throw new Error('applyCaptures needs the tenant id — offers are tenant-scoped');
  if (!sourceSlug) throw new Error('applyCaptures needs a source slug');

  const verification = [];
  for (const capture of captures) {
    if (!capture.referralUrl) continue;
    if (capture.groupId) {
      // A pair link resolves to a LIST of roles, so title-matching it against one posting is the wrong test — it
      // refused every group link as a mismatch on 2026-11-16. The evidence a group link has is different: the roles
      // were ticked and the page's own counter confirmed them. What still must be checked is attribution, because a
      // group URL without a referral code credits nobody.
      const attribution = referralAttribution(capture.referralUrl);
      verification.push({
        title: capture.title,
        jobId: capture.jobId,
        referral_url: capture.referralUrl,
        verdict: attribution === 'none' ? 'no_attribution' : 'group',
        reason: `group link covers ${(capture.sharedWith || []).length + 1} role(s), ticked and confirmed on the page`,
        source: 'group-selection',
        resolvedTitle: null
      });
      if (attribution === 'none') {
        capture.reason = 'link_without_attribution';
        capture.referralUrl = null;
      }
      continue;
    }
    const check = await verify({ url: capture.referralUrl, expectedTitle: capture.title });
    // New offers take the same decision as existing ones, including the browser's own title when
    // the server cannot read the page. A role page rendered late is not a wrong link.
    const decided = resolveLinkVerdict({ check, expectedTitle: capture.title, pageTitle: capture.pageTitle });
    verification.push({
      title: capture.title,
      jobId: capture.jobId,
      referral_url: capture.referralUrl,
      verdict: decided.verdict,
      reason: decided.reason,
      source: decided.source,
      resolvedTitle: decided.resolvedTitle || null
    });
    // A link that does not land on its own role is worse than no link: it drives the
    // tenant's candidate to somebody else's job.
    if (decided.verdict !== 'match') {
      capture.reason = `unverified_${decided.verdict}`;
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
 * Which host each marketplace issues its referral links on (2026-11-18).
 *
 * `planReferralBackfill` defaults to Turing's host, so a Micro1 capture was refused as `wrong_host` — while the very
 * same URL had just been accepted by the insert path a few lines earlier. One live run therefore reported "imported 23
 * draft offer(s) (23 with a verified link)" and, immediately below it, 23 × "link skipped … wrong_host" for those same
 * rows: two opinions about one URL, which is how a run that worked reads like a run that failed.
 *
 * `micro1.ai` covers both `jobs.micro1.ai` (one link per role) and `refer.micro1.ai` (one link per pair), because
 * `isReferralUrlForHost` compares subdomain-safely. Turing keeps its planner default, so nothing changes for it.
 */
export const REFERRAL_HOST_BY_SOURCE = { micro1: 'micro1.ai' };

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
export async function applyCaptureUpdates({ supabase, offers = [], captures = [], verify = verifyReferralLink, apply = true, allowReplacePayable = false, sourceSlug = null } = {}) {
  const rows = Array.isArray(offers) ? offers : [];
  const allCaptures = Array.isArray(captures) ? captures : [];
  const host = REFERRAL_HOST_BY_SOURCE[String(sourceSlug || '').toLowerCase()] || null;
  // A paired link is handled directly, by title — not through the single-role planner. It lives on refer.micro1.ai and
  // carries no job id, so the planner refuses it as `wrong_host` before any verification could happen. Its evidence is
  // different too: the roles were ticked and the page's own counter confirmed them.
  const groupCaptures = allCaptures.filter((capture) => capture && capture.groupId && capture.referralUrl);
  const linkPlan = planReferralBackfill({
    offers: rows,
    captures: allCaptures.filter((capture) => !(capture && capture.groupId)),
    // Spread, not `host`: passing null would override the planner's own default and refuse every link.
    ...(host ? { host } : {})
  });
  const verification = [];
  const accepted = [];

  // Match a paired link to the offer it belongs to. Exact title first, then the shared normalised key — one
  // implementation (`titleKey`), because the planner needs the same answer to avoid minting a link for a role the
  // tenant does not own.
  const offerByTitle = new Map();
  for (const offer of rows) {
    const exact = String(offer.title || '').toLowerCase();
    if (exact) offerByTitle.set(exact, offer);
    const loose = titleKey(offer.title);
    if (loose && !offerByTitle.has(loose)) offerByTitle.set(loose, offer);
  }
  for (const capture of groupCaptures) {
    const offer = offerByTitle.get(String(capture.title || '').toLowerCase()) || offerByTitle.get(titleKey(capture.title));
    if (!offer || !offer.id) {
      // A paired role that is not an offer yet: the insert path needs a job id, which a pair link does not have.
      linkPlan.skipped.push({ title: capture.title, reason: 'no_offer_for_role' });
      continue;
    }
    const existing = String(offer.referral_url || '').trim();
    let replaceOf = null;
    if (existing) {
      // A URL that carries NO attribution credits nobody — it is the dead row this phase exists to replace. The
      // tenant's catalogue is exactly this shape: hundreds of offers with a link, none of them payable. A URL that
      // *does* attribute is somebody's working referral and is never touched — unless the run is a re-mint, where the
      // tenant has established that the stored codes do not credit them (2026-11-17).
      const newUrl = String(capture.referralUrl || '').trim();
      const sameLink = Boolean(newUrl) && newUrl === existing;
      if (referralAttribution(existing) !== 'none' && !(allowReplacePayable && !sameLink)) {
        linkPlan.skipped.push({ title: capture.title, reason: 'already_has_link' });
        continue;
      }
      if (!sameLink) replaceOf = existing;
    }
    const attribution = referralAttribution(capture.referralUrl);
    verification.push({
      title: offer.title,
      referral_url: capture.referralUrl,
      verdict: attribution === 'none' ? 'no_attribution' : 'group',
      reason: replaceOf
        ? `paired with ${(capture.sharedWith || []).join(' + ') || 'another role'} — replacing a link that does not credit you`
        : `paired with ${(capture.sharedWith || []).join(' + ') || 'another role'}`,
      resolvedTitle: null,
      source: 'group-selection',
      replaced: Boolean(replaceOf)
    });
    if (attribution === 'none') {
      linkPlan.skipped.push({ title: capture.title, reason: 'link_without_attribution' });
      continue;
    }
    accepted.push({ id: offer.id, title: offer.title, referral_url: capture.referralUrl, replaceOf });
  }

  for (const update of linkPlan.updates) {
    const check = await verify({ url: update.referral_url, expectedTitle: update.title });
    /**
     * One decision, made in `referralVerify.resolveLinkVerdict`.
     *
     * Turing renders roles in JavaScript: a fetch from Render gets the shell and a generic title,
     * which on 2026-11-04 refused 120 correct links as `unverified_mismatch`. The worker opened
     * each role in the tenant's own signed-in session and reported its `<title>`; that evidence is
     * judged with the same rules, so a link is still only attached when the title matches the role.
     * The Turing runner runs the same function when a tenant captures by hand, which is why it
     * lives there rather than here.
     */
    const { verdict, reason, resolvedTitle, source } = resolveLinkVerdict({
      check,
      expectedTitle: update.title,
      pageTitle: update.pageTitle
    });
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
    // How many of the planned writes are replacements of a link already on file. A re-mint run reports this so the
    // tenant can see it displaced something rather than quietly adding a second link (2026-11-17).
    replaced: accepted.filter((update) => update.replaceOf).length,
    skipped: linkPlan.skipped,
    conflicts: linkPlan.conflicts,
    verification
  };

  if (apply) {
    for (const update of accepted) {
      if (!update.id) { links.skipped.push({ title: update.title, reason: 'no_id' }); continue; }
      const base = supabase
        .from('opportunities')
        .update({ referral_url: update.referral_url, updated_at: new Date().toISOString() })
        .eq('id', update.id);
      // Compare-and-set either way: against NULL when the row had no link, or against the exact dead value we are
      // replacing. A link somebody attached while this run was driving the browser is never clobbered.
      const { data, error } = await (update.replaceOf ? base.eq('referral_url', update.replaceOf) : base.is('referral_url', null))
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
    .select('id, title, external_id, description, referral_url, deleted_at')
    .eq('tenant_id', tenantId);
  if (error) return null;
  const live = (data || []).filter((row) => row.deleted_at == null);
  const coverage = describeEnrichment(live);

  /**
   * The commercial number (2026-11-17).
   *
   * Description fullness says whether the funnel has text to work with; this says whether an offer can EARN. A row with
   * no URL and a row whose URL carries no referral code are both dead, and only the second looks healthy in a list —
   * which is exactly how 259 offers sat there paying nothing.
   *
   * The test is `referralCodeOf`, the *same* one the portal's funnel uses, and not `referralAttribution`. They answer
   * different questions: attribution is deliberately forgiving about an unrecognised query so a capture is not thrown
   * away on a guess, while this number claims that a click earns. `?utm_source=share` and `?referralCode=` are worlds
   * apart, and letting the lenient one answer the money question is how a run log and a dashboard end up disagreeing.
   */
  let payable = 0;
  let unpayable = 0;
  let unlinked = 0;
  for (const row of live) {
    const url = String(row.referral_url || '').trim();
    if (!url) unlinked += 1;
    else if (!referralCodeOf(url)) unpayable += 1;
    else payable += 1;
  }
  return {
    ...coverage,
    links: { payable, unpayable, unlinked, total: live.length }
  };
}
