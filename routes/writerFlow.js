/**
 * Writer's Flow control routes (2026-11-02)
 *
 * The portal's Writer's Flow section could report *outcomes* (coverage, link health)
 * but nothing about the *work*: no way to start a run, no way to watch one, and no way
 * to act on a link that verification had already proven wrong. This router supplies
 * exactly that, always scoped to the signed-in tenant:
 *
 *   GET  /tenant/blogger/writer-flow        funnel, runs, and what to do next
 *   POST /tenant/blogger/links/verify       resolve every stored link, now
 *   POST /tenant/blogger/links/:id/resolve  recheck | clear | accept one link
 *   POST /tenant/blogger/runs               queue a collection run for a runner
 *   POST /tenant/blogger/runs/:id/cancel    withdraw a run that has not finished
 *
 * The split between the two kinds of work is the whole design:
 *
 *   **Verification needs no browser.** One HTTP request per link, so the button does
 *   the work inside the request and the tenant sees the result immediately.
 *
 *   **Collection needs the leased browser**, which lives on the operator's machine.
 *   The portal therefore cannot run it — so it records the *request* (a queued row) and
 *   returns the exact worker command. The tenant sees "queued — waiting for a runner"
 *   instead of a spinner that never ends, and the operator gets a queue instead of a
 *   WhatsApp message.
 *
 * Every query is tenant-scoped in the query itself, never in a post-fetch check: a
 * foreign id matches no row and reports 404.
 */
import { Router } from 'express';
import {
  RUN_TABLE,
  QUEUEABLE_KINDS,
  canQueue,
  createRunStore,
  describeRun,
  isActiveStatus,
  isExpiredQueue,
  isStalled,
  kindLabel
} from '../utils/browserActor/runs.js';
import { verifyReferralLink } from '../utils/browserActor/referralVerify.js';
import { parseProfileMap, maskEnvId } from '../utils/browserActor/identity.js';
import { resolveAccessIdentity } from '../utils/tenantAccess.js';

/** One click should finish inside a request, not hold a browser open. */
const VERIFY_DEFAULT = 40;
const VERIFY_MAX = 120;
/** Four at a time: a 96-link tenant must not open 96 sockets. */
const VERIFY_CONCURRENCY = 4;

function intParam(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Which browser this tenant's captures will use, in words a tenant can read.
 *
 * Three sources, in the order the runners themselves resolve:
 *
 *   1. **their own** profile — connected with a key, or reported by their worker from their
 *      own computer (`metadata.workerBrowser`);
 *   2. the operator's `BROWSER_ACTOR_PROFILES` map;
 *   3. the single-profile default.
 *
 * Only the last two used to be checked here, which is why a tenant with a working, worker-
 * connected browser was told "No browser identity registry is configured on this server" —
 * a sentence about our environment shown to someone who does not have an environment.
 * The full profile id never leaves the server: masked, as everywhere else in this subsystem.
 */
export function describeIdentityFor(tenantSlug, env = process.env, metadata = null) {
  let envMap = {};
  try {
    envMap = parseProfileMap(env.BROWSER_ACTOR_PROFILES || '');
  } catch {
    // A malformed map is the operator's problem to see in the logs, not a reason to tell the
    // tenant their browser is missing.
    envMap = {};
  }
  const own = resolveAccessIdentity({
    tenantSlug,
    metadata,
    envMap,
    defaultEnvId: env.BROWSER_ACTOR_DEFAULT_ENV_ID || '',
    // A worker-reported profile is exactly the case this line has to be able to describe.
    workerRuns: true
  });
  if (!own) {
    return { configured: false, mapped: false, source: 'none', label: 'No browser is set up for this tenant yet.' };
  }

  const masked = maskEnvId(own.envId);
  const name = own.label ? `${own.label} ` : '';
  const label = own.source === 'worker'
    ? `${name}(${masked}) — on your computer`
    : own.source === 'tenant'
      ? `${name}(${masked}) — connected with your key`
      : own.source === 'hosted'
        ? `${masked} — hosted by Alphadome`
        : `${masked} — shared demo profile`;
  return { configured: true, mapped: true, source: own.source, envIdMasked: masked, label };
}

export function createWriterFlowRouter({
  tenantSessionAuth,
  tenantSiteFromSession,
  supabase,
  verify = verifyReferralLink,
  runTable = RUN_TABLE,
  now = () => Date.now()
} = {}) {
  const router = Router();
  const store = createRunStore({ table: () => supabase.from(runTable), now });

  const sendError = (res, err) => {
    console.error('[writer-flow]', err?.message || err);
    res.status(500).json({ error: err?.message || 'Something went wrong' });
  };

  /**
   * Offer columns, with a fallback ladder.
   *
   * A database that has not had the newer migrations applied must still render the
   * funnel, so `link_verdict`/`link_note` and `deleted_at` are each optional: the page
   * loses that detail and says so, rather than failing to load.
   */
  async function loadOffers(tenantId) {
    const base = 'id, slug, title, status, description, external_id, referral_url, source:opportunity_sources(slug, name)';
    const attempts = [
      { columns: `${base}, link_verdict, link_checked_at, link_note`, softDelete: true },
      { columns: `${base}, link_verdict, link_checked_at`, softDelete: true },
      { columns: base, softDelete: true },
      { columns: base, softDelete: false }
    ];
    let lastError = null;
    for (const attempt of attempts) {
      let query = supabase.from('opportunities').select(attempt.columns).eq('tenant_id', tenantId);
      if (attempt.softDelete) query = query.is('deleted_at', null);
      const { data, error } = await query;
      // Degraded when the winning column set has no `link_note`: the panel must say link
      // health is partial rather than show a filter that silently cannot work.
      if (!error) return { offers: data || [], degraded: !attempt.columns.includes('link_note') };
      lastError = error;
    }
    throw lastError;
  }

  async function loadRuns(tenantId, limit = 100) {
    try {
      // Two reads, because they answer two different questions:
      //   * the newest rows of any kind — what "Last run: …" means;
      //   * the newest *capture* rows — what each marketplace card must be able to show.
      // One window cannot serve both: verification runs are written on every click and would
      // eventually push a real capture out of view (it did, 3 Nov: Micro1 read "never run"
      // while twelve roles had just been imported).
      const [recent, captures] = await Promise.all([
        store.list({ tenantId, limit }),
        store.list({ tenantId, limit: 40, kinds: ['micro1', 'collect', 'referrals'] })
      ]);
      const { mergeRunWindows } = await import('../utils/writerFlow.js');
      return { runs: mergeRunWindows(recent, captures), available: true };
    } catch (error) {
      // A missing table is a deployment state, not a crash: report it as unavailable so
      // the portal can say "run history unavailable" instead of "no runs yet".
      if (/relation|does not exist|schema cache|column/i.test(String(error?.message || error))) {
        return { runs: [], available: false };
      }
      throw error;
    }
  }

  /**
   * `link_note` arrives with the run-tracking migration, which is applied by hand. Until
   * it is there, verification still works — there are simply no human overrides on
   * record to protect — so the retry is deliberate rather than a fallback of convenience.
   */
  async function withNoteSupport(run) {
    try {
      return await run(true);
    } catch (error) {
      if (!/link_note/i.test(String(error?.message || ''))) throw error;
      return run(false);
    }
  }

  // -------------------------------------------------------------------------
  // The panel payload
  // -------------------------------------------------------------------------

  router.get('/tenant/blogger/writer-flow', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return res.status(404).json({ error: 'Tenant not found' });

      const [{ offers, degraded }, { runs, available }] = await Promise.all([
        loadOffers(ctx.site.id),
        loadRuns(ctx.site.id)
      ]);

      const { writerFlowView } = await import('../utils/writerFlow.js');
      const view = writerFlowView({
        offers,
        runs,
        runsAvailable: available,
        identity: describeIdentityFor(ctx.site.slug, process.env, ctx.site.metadata),
        now: now(),
        linkLimit: intParam(req.query.linkLimit, 25, 1, 100)
      });

      res.json({
        ok: true,
        ...view,
        tenant: { slug: ctx.site.slug, name: ctx.site.name || ctx.site.slug },
        // Lets the UI soften the link-health wording when the columns are absent.
        linksAvailable: !degraded,
        hubPath: '/ai-jobs/t/' + ctx.site.slug
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // Verification — the button that actually resolves links
  // -------------------------------------------------------------------------

  router.post('/tenant/blogger/links/verify', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return res.status(404).json({ error: 'Tenant not found' });

      const limit = intParam(req.body?.limit, VERIFY_DEFAULT, 1, VERIFY_MAX);
      const loaded = await withNoteSupport(async (hasNote) => {
        const columns = `id, title, referral_url, link_verdict, ${hasNote ? 'link_note, ' : ''}slug, status, external_id, source:opportunity_sources(slug, name)`;
        const { data, error } = await supabase
          .from('opportunities')
          .select(columns)
          .eq('tenant_id', ctx.site.id)
          .not('referral_url', 'is', null)
          // Unchecked first, then proven wrong, then confirmed: one click spends its
          // budget on the links nobody has looked at yet.
          .order('link_verdict', { ascending: true, nullsFirst: true })
          .limit(limit * 2);
        if (error) throw error;
        return { data: data || [], hasNote };
      });

      const { buildVerdictPatch, shouldSkipVerification } = await import('../utils/writerFlow.js');

      const candidates = loaded.data
        .filter((offer) => String(offer.referral_url || '').trim())
        .slice(0, limit);
      // Without the column there are no recorded decisions, so nothing is skipped.
      const skipped = loaded.hasNote ? candidates.filter(shouldSkipVerification) : [];
      const toCheck = candidates.filter((offer) => !shouldSkipVerification(offer) || !loaded.hasNote);

      if (!toCheck.length) {
        return res.json({
          ok: true,
          checked: 0,
          skipped: skipped.length,
          verdicts: { match: 0, mismatch: 0, unresolvable: 0 },
          changes: [],
          results: [],
          message: skipped.length
            ? `${skipped.length} link${skipped.length === 1 ? '' : 's'} already accepted by you — nothing to re-check.`
            : 'This tenant has no stored referral links yet. Capture links first.'
        });
      }

      const results = [];
      const queue = [...toCheck];
      const workers = Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
          const offer = queue.shift();
          const check = await verify({ url: offer.referral_url, expectedTitle: offer.title });
          const patch = buildVerdictPatch(check);
          // Written per row, immediately: a mid-run failure must not lose verdicts that
          // were already established (the same rule the capture path follows).
          const { error: writeError } = await supabase
            .from('opportunities')
            .update(patch)
            .eq('id', offer.id)
            .eq('tenant_id', ctx.site.id);
          results.push({
            id: offer.id,
            title: offer.title,
            referral_url: offer.referral_url,
            verdict: patch.link_verdict,
            reason: check?.reason || null,
            pointsAt: check?.resolvedTitle || null,
            changed: String(offer.link_verdict || '') !== patch.link_verdict,
            writeError: writeError?.message || null
          });
        }
      });
      await Promise.all(workers);

      const count = (verdict) => results.filter((row) => row.verdict === verdict).length;
      const summary = { match: count('match'), mismatch: count('mismatch'), unresolvable: count('unresolvable') };

      // The verification is itself a run, so the history line explains where these
      // verdicts came from. A missing runs table must not fail the verification.
      try {
        const run = await store.queue({ tenantId: ctx.site.id, kind: 'verify', requestedBy: 'tenant', detail: { limit } });
        if (run?.id) {
          await store.finish({
            runId: run.id,
            status: summary.mismatch > 0 ? 'partial' : 'succeeded',
            done: results.length,
            ok: summary.match,
            failed: summary.mismatch + summary.unresolvable,
            total: results.length,
            message: `${summary.match} verified · ${summary.mismatch} wrong · ${summary.unresolvable} unreachable`
          });
        }
      } catch { /* history is a nicety; the verdicts are the point */ }

      res.json({
        ok: summary.mismatch === 0,
        checked: results.length,
        skipped: skipped.length,
        verdicts: summary,
        // Only what changed, so the UI can say "3 links just turned out wrong" rather
        // than repeating everything it already knew.
        changes: results.filter((row) => row.changed),
        results
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // Resolving one link
  // -------------------------------------------------------------------------

  router.post('/tenant/blogger/links/:id/resolve', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return res.status(404).json({ error: 'Tenant not found' });

      const action = String(req.body?.action || '').toLowerCase();
      if (!['recheck', 'clear', 'accept'].includes(action)) {
        return res.status(400).json({ error: 'action must be recheck, clear or accept' });
      }

      const loaded = await withNoteSupport(async (hasNote) => {
        // Ask only for columns that exist: `null as link_note` would still be a reference
        // to the missing column in some drivers, and there is no need to gamble here.
        const columns = `id, title, referral_url, link_verdict, link_checked_at${hasNote ? ', link_note' : ''}`;
        const { data, error } = await supabase
          .from('opportunities')
          .select(columns)
          .eq('id', String(req.params.id || ''))
          .eq('tenant_id', ctx.site.id)
          .maybeSingle();
        if (error) throw error;
        return { offer: data, hasNote };
      });
      const offer = loaded.offer;
      if (!offer) return res.status(404).json({ error: 'Offer not found for this tenant' });
      if (offer.link_note === undefined) offer.link_note = null;
      if (!loaded.hasNote && action === 'accept') {
        return res.status(503).json({
          error: 'Accepting a link needs the run-tracking migration',
          hint: 'Apply migrations/2026-11-02_writer_flow_runs.sql to record link decisions.'
        });
      }

      const { buildVerdictPatch, buildClearPatch, buildAcceptPatch } = await import('../utils/writerFlow.js');
      let patch;
      let check = null;
      let pointsAt = null;

      if (action === 'recheck') {
        if (!String(offer.referral_url || '').trim()) {
          return res.status(400).json({ error: 'This offer has no referral link to check' });
        }
        check = await verify({ url: offer.referral_url, expectedTitle: offer.title });
        pointsAt = check?.resolvedTitle || null;
        // An explicit recheck is the tenant asking for the robot's opinion again, so the
        // earlier override is retired here — and only here.
        patch = { ...buildVerdictPatch(check), ...(loaded.hasNote ? { link_note: null } : {}) };
      } else if (action === 'clear') {
        patch = buildClearPatch({ pointsAt });
        if (!loaded.hasNote) delete patch.link_note;
      } else {
        patch = buildAcceptPatch();
      }

      const { data: updated, error: writeError } = await supabase
        .from('opportunities')
        .update(patch)
        .eq('id', offer.id)
        .eq('tenant_id', ctx.site.id)
        .select(`id, title, referral_url, link_verdict, link_checked_at${loaded.hasNote ? ', link_note' : ''}`)
        .maybeSingle();
      if (writeError) throw writeError;

      res.json({
        ok: true,
        action,
        offer: updated,
        // Where the link actually lands, when it is known: the tenant needs that to tell
        // "the marketplace renamed this role" from "this link is simply wrong".
        pointsAt,
        message: action === 'clear'
          ? 'Link removed. The offer now shows as missing a link, so a capture can fill it.'
          : action === 'accept'
            ? 'Marked as accepted. Automated verification will leave it alone from now on.'
            : `Checked — ${patch.link_verdict}${pointsAt ? ` (${pointsAt})` : ''}`
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // Queueing work for a runner
  // -------------------------------------------------------------------------

  router.post('/tenant/blogger/runs', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return res.status(404).json({ error: 'Tenant not found' });

      const kind = String(req.body?.kind || 'referrals').toLowerCase();
      if (!QUEUEABLE_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of ${QUEUEABLE_KINDS.join(', ')}` });
      }

      const { runs, available } = await loadRuns(ctx.site.id);
      if (!available) {
        return res.status(503).json({
          error: 'Run tracking is not set up yet',
          hint: 'Apply migrations/2026-11-02_writer_flow_runs.sql, then try again.'
        });
      }

      // The unique index is the real guard; this is the readable refusal in front of it,
      // so a tenant gets a sentence instead of a constraint violation.
      const gate = canQueue(runs, { kind, now: now() });
      if (!gate.ok) return res.status(409).json({ error: gate.message, run: gate.run || null });

      // `canQueue` lets a run through once its heartbeat stops, because a dead worker must not
      // mean "never capture again". The index does not know that: `status = 'running'` keeps
      // the (tenant, kind) slot until the row is closed. So close the abandoned rows first —
      // otherwise the insert raises 23505 and the tenant sees a 500 for a leftover row.
      // A queued row that no runner ever claimed is the same problem one step earlier, and it
      // is the common one for Turing: only Alphadome's runner can claim those.
      const abandoned = runs.filter((run) => (
        String(run.kind || '').toLowerCase() === kind &&
        isActiveStatus(run.status) &&
        (isStalled(run, now()) || isExpiredQueue(run, now()))
      ));
      for (const row of abandoned) {
        const expired = isExpiredQueue(row, now());
        await store.finish({
          runId: row.id,
          // A worker that died is a failure; a request nobody ever claimed is a cancellation.
          // Collapsing them would tell a tenant their capture failed when nothing ever ran.
          status: expired ? 'cancelled' : 'failed',
          done: row.done_items,
          ok: row.ok_items,
          failed: row.failed_items,
          total: row.total_items,
          message: expired
            ? 'No runner picked this up within 30 minutes, so it was cleared to let you start another.'
            : 'The runner stopped reporting, so this run was closed to let a new one start.',
          detail: expired ? { expired: true, createdAt: row.created_at || null } : { abandoned: true, lastHeartbeatAt: row.heartbeat_at || null }
        }).catch((error) => console.error(`[writer-flow] could not close run ${row.id}: ${error?.message || error}`));
        console.error(`[writer-flow] tenant=${ctx.site.slug} closed ${expired ? 'expired' : 'abandoned'} run ${row.id}`);
      }

      const detail = {
        limit: intParam(req.body?.limit, 50, 1, 300),
        skip: intParam(req.body?.skip, 0, 0, 5000),
        refresh: Boolean(req.body?.refresh)
      };

      let run = null;
      try {
        run = await store.queue({
          tenantId: ctx.site.id,
          kind,
          sourceSlug: req.body?.source ? String(req.body.source) : null,
          requestedBy: 'tenant',
          detail
        });
      } catch (error) {
        // A second tab (or a retry) queue the same instant the index fires. That is a
        // conflict, and calling it a 500 taught the tenant to distrust the button.
        if (String(error?.code || '') === '23505' || /uq_browser_actor_runs_active/.test(error?.message || '')) {
          console.error(`[writer-flow] tenant=${ctx.site.slug} queue refused by the active-run index`);
          return res.status(409).json({
            error: `${kindLabel(kind)} is already waiting or running for this tenant — give it a moment, then try again.`,
            reason: 'already_running'
          });
        }
        throw error;
      }

      // The worker command is in the response on purpose: the tenant has no browser, the
      // operator does. Handing over the exact line is more honest than a progress bar
      // that would never move.
      const script = kind === 'referrals'
        ? 'scripts/browser_actor_referrals.mjs'
        : kind === 'collect'
          ? 'scripts/browser_actor_collect.mjs'
          : 'scripts/browser_actor_import.mjs';
      const flags = [`--tenant ${ctx.site.slug}`, `--limit ${detail.limit}`, `--skip ${detail.skip}`];
      if (detail.refresh) flags.push('--refresh');
      flags.push('--apply');

      res.status(201).json({
        ok: true,
        run,
        label: kindLabel(kind),
        command: `node ${script} ${flags.join(' ')} --run-id ${run.id}`,
        message: `${kindLabel(kind)} queued. It starts when a runner picks it up.`
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/tenant/blogger/runs/:id/cancel', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return res.status(404).json({ error: 'Tenant not found' });
      const run = await store.cancel({ runId: String(req.params.id || ''), tenantId: ctx.site.id });
      if (!run) return res.status(404).json({ error: 'Run not found for this tenant' });
      res.json({ ok: true, run, message: describeRun(run, now()) });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

