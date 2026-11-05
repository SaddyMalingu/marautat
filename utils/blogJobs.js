/**
 * Background blog jobs (2026-11-05)
 *
 * The tenant portal and the owner dashboard each have one button: "optimise my assets" and
 * "optimise every asset". Both are the same job with a different scope, and both must be
 * **asynchronous**, because the work cannot fit in an HTTP request:
 *
 *   nine angles per offer × up to 90 s per offer = minutes, not seconds
 *
 * So the button creates a row in `blog_jobs`, answers immediately, and polls for progress while
 * this module drains the plan one offer at a time. Three properties are deliberate:
 *
 *   1. **One drain per scope.** A second click returns the job already running instead of
 *      starting a competing walk. On a rate-limited tier, two walks make each other slower and
 *      both look broken.
 *   2. **Progress is written after every offer**, so a paused or killed process still leaves an
 *      honest count — the old nightly job's failure was reporting success with zero pages.
 *   3. **A failed offer does not stop the queue.** It is recorded and the drain continues; the
 *      tenant paid for the others.
 *
 * The generator is injected (`deps.generate`), so the whole lifecycle is tested without
 * Supabase, AI keys or a nine-minute wait — see `scripts/test_blog_jobs.mjs`.
 */
import { planBlogQueue } from './blogQueue.js';

export const JOB_STATUS = Object.freeze({
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled'
});

/** One drain at a time per scope+tenant. */
const running = new Map();

function jobKey(scope, tenantId) {
  return scope === 'tenant' ? `tenant:${tenantId}` : 'global';
}

/** The row shape written before any work starts. */
export function buildJobRow({ scope, tenantId = null, requestedBy = null, limit = 5, budgetMs = 0, now = new Date() } = {}) {
  if (scope !== 'tenant' && scope !== 'global') throw new Error('scope must be tenant or global');
  // A tenant job without a tenant would silently become a global run. That is the one mistake
  // in this module with a blast radius, so it stops the call.
  if (scope === 'tenant' && !tenantId) throw new Error('a tenant job needs a tenant id');
  return {
    scope,
    tenant_id: scope === 'tenant' ? tenantId : null,
    status: JOB_STATUS.queued,
    total: 0,
    done: 0,
    failed: 0,
    pages: 0,
    limit_offers: Number(limit) || 0,
    budget_ms: Number(budgetMs) || 0,
    plan: null,
    results: [],
    error: null,
    requested_by: requestedBy,
    created_at: now.toISOString(),
    started_at: null,
    completed_at: null
  };
}

/**
 * Drain a planned job, one offer at a time.
 *
 * @param {{id: any, limit_offers?: number, budget_ms?: number}} job
 * @param {{load: Function, generate: Function, update: Function, perOfferMs?: number}} deps
 * @returns {Promise<{ok: boolean, done: number, failed: number, pages: number,
 *                    results: object[], summary: string}>}
 */
export async function drainJob(job, deps, { onProgress } = {}) {
  const limit = Number(job.limit_offers || 0);
  const budgetMs = Number(job.budget_ms || 0);

  const { offers = [], posts = [] } = await deps.load();
  const plan = planBlogQueue({
    offers,
    posts,
    limit: limit > 0 ? limit : 5,
    budgetMs,
    perOfferMs: Number(deps.perOfferMs || 90000)
  });

  await deps.update(job.id, {
    status: JOB_STATUS.running,
    started_at: new Date().toISOString(),
    // The plan is stored, not just counted: the portal can then say *why* an offer was skipped
    // (already covered / deleted / no referral link) instead of showing a bare number.
    plan: {
      runs: plan.runs.map((run) => ({ offerId: run.offerId, title: run.title, ready: run.ready, missing: run.missing })),
      skipped: plan.skipped,
      deferred: plan.deferred.length,
      needsLink: plan.needsLink,
      summary: plan.summary
    },
    total: plan.runs.length
  });

  const results = [];
  let pages = 0;
  let failed = 0;

  for (const run of plan.runs) {
    let entry;
    try {
      const result = await deps.generate(run.offerId);
      const written = Array.isArray(result?.posts) ? result.posts.length : 0;
      pages += written;
      if (!result?.success) failed += 1;
      entry = {
        offerId: run.offerId,
        title: run.title,
        ok: Boolean(result?.success),
        pages: written,
        mode: result?.mode || null,
        error: result?.success ? null : (result?.error || 'no posts written')
      };
    } catch (error) {
      failed += 1;
      // Recorded even when it throws: a half-written offer must not vanish from the report, or
      // the tenant sees "done" over a hole.
      entry = { offerId: run.offerId, title: run.title, ok: false, pages: 0, mode: null, error: error.message };
    }
    results.push(entry);
    await deps.update(job.id, { done: results.length, failed, pages, results });
    if (typeof onProgress === 'function') onProgress({ job, entry, done: results.length, total: plan.runs.length });
  }

  const ok = results.length === 0 ? true : failed < results.length;
  await deps.update(job.id, {
    status: ok ? JOB_STATUS.done : JOB_STATUS.failed,
    completed_at: new Date().toISOString(),
    error: ok ? null : `${failed} of ${results.length} offer(s) produced no pages`
  });

  return {
    ok,
    done: results.length,
    failed,
    pages,
    results,
    // Nothing to do is not a failure: a tenant whose offers all have full journeys should see
    // "everything is already written", not a red toast.
    summary: plan.summary
  };
}

/**
 * Create the job row and start draining it.
 *
 * Returns as soon as the row exists — the HTTP handler answers 202 with the id. `completion` is
 * the drain promise: the server ignores it, tests await it.
 *
 * @param {{scope: string, tenantId?: string|null, requestedBy?: string|null, limit?: number,
 *          budgetMs?: number, deps: {create: Function, load: Function, generate: Function,
 *          update: Function}}} options
 */
export async function startBlogJob(options = {}) {
  const { scope, tenantId = null, deps } = options;
  if (!deps || typeof deps.create !== 'function') throw new Error('startBlogJob needs deps.create');

  const key = jobKey(scope, tenantId);
  const existing = running.get(key);
  if (existing) return { busy: true, job: existing, completion: Promise.resolve(null) };

  const job = await deps.create(buildJobRow(options));
  running.set(key, job);

  const completion = drainJob(job, deps)
    .catch(async (error) => {
      // A throw here is a bug or an outage, not a slow provider. Record it so the portal shows a
      // reason instead of a job stuck at 'running' forever.
      try {
        await deps.update(job.id, {
          status: JOB_STATUS.failed,
          error: error.message,
          completed_at: new Date().toISOString()
        });
      } catch (e) { /* the row is already unusable; nothing better to do */ }
      return { ok: false, error: error.message };
    })
    .finally(() => running.delete(key));

  return { busy: false, job, completion };
}

/** Test seam: forget any in-flight drains (never used on a production path). */
export function resetRunningJobs() {
  running.clear();
}

/** Is a drain in progress for this scope right now? */
export function jobInFlight(scope, tenantId = null) {
  return running.has(jobKey(scope, tenantId));
}
