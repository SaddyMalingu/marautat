/**
 * Blog queue as a Render Workflow (2026-11-05)
 *
 * Render Workflows run *functions* across many instances with automatic per-step retries, and
 * a run may last up to two hours (default) rather than the ninety seconds a tenant's HTTP
 * request allows. That is the one thing a workflow buys this repo that a cron job cannot:
 * `BLOG_RUN_BUDGET_MS` exists only because generation happens inside a request, and every
 * angle it truncates is a page that falls back to composed-from-the-offer copy. Here each
 * offer gets its own task run, so the budget can be spent per offer and a stalled provider
 * retries instead of silently degrading.
 *
 * The SDK is **injected** (`task`) rather than imported. Two reasons, both practical:
 *   - `@renderinc/sdk` is not a dependency of this app, and adding it without regenerating
 *     `package-lock.json` would break `npm ci` in the existing GitHub Action.
 *   - the decision logic stays testable offline: `scripts/test_blog_workflow.mjs` registers
 *     these tasks with a fake `task` and a fake `ctx`, so the fan-out is proven without a
 *     Render deploy.
 *
 * Nothing here writes files. A workflow's filesystem is discarded when the run ends, and the
 * durable copy of a page is its `blog_posts` row (`restoreFromDB()` rebuilds `public/blog`
 * from it on boot). Images are therefore turned off: `genImage()` writes PNGs to
 * `public/images/blog/` and returns a `/images/blog/<slug>.png` URL that no boot ever
 * restores, so a workflow-generated thumbnail would be a guaranteed 404 on the live site.
 */
import { planBlogQueue } from '../utils/blogQueue.js';

export const BLOG_TASK_NAMES = Object.freeze({ queue: 'blogQueue', offer: 'blogOffer' });

/**
 * The queue task: plan, then fan out one chained run per offer.
 *
 * `ctx.run` is what makes the offers parallel and individually retryable. A failure is caught
 * per offer rather than aborting the whole queue — one dead provider key must not cost the
 * other nineteen offers their pages.
 *
 * @param {{run: Function}} ctx
 * @param {{limit?: number, budgetMs?: number, perOfferMs?: number}} input
 * @param {{load: Function, blogOffer: any, generateOffer?: Function}} deps
 */
export async function runBlogQueue(ctx, input = {}, deps = {}) {
  const { offers = [], posts = [] } = await deps.load();
  const plan = planBlogQueue({
    offers,
    posts,
    limit: Number(input.limit == null ? 3 : input.limit),
    budgetMs: Number(input.budgetMs || 0),
    perOfferMs: Number(input.perOfferMs || 90000)
  });

  if (!plan.runs.length) {
    return {
      success: true,
      planned: 0,
      succeeded: 0,
      failed: 0,
      summary: plan.summary,
      skipped: plan.skipped.length,
      results: []
    };
  }

  const settled = await Promise.all(plan.runs.map(async (run) => {
    try {
      const result = await ctx.run(deps.blogOffer, run.offerId);
      const posts = Array.isArray(result?.posts) ? result.posts.length : 0;
      return {
        offerId: run.offerId,
        title: run.title,
        ok: Boolean(result?.success),
        pages: posts,
        mode: result?.mode || null,
        error: result?.success ? null : (result?.error || 'no posts')
      };
    } catch (error) {
      // A chained run that throws is a task that exhausted its retries. Report it; keep going.
      return { offerId: run.offerId, title: run.title, ok: false, pages: 0, mode: null, error: error.message };
    }
  }));

  const succeeded = settled.filter((r) => r.ok).length;
  return {
    // `success` is false when any offer failed, so a workflow run is visibly red rather than
    // reporting a clean run that quietly wrote nothing — the failure mode the old nightly job
    // had, where a dead AI key produced "success" with zero pages.
    success: settled.length === succeeded,
    planned: plan.runs.length,
    succeeded,
    failed: settled.length - succeeded,
    pages: settled.reduce((sum, r) => sum + r.pages, 0),
    skipped: plan.skipped.length,
    deferred: plan.deferred.length,
    needsLink: plan.needsLink,
    summary: plan.summary,
    results: settled
  };
}

/**
 * Register both tasks with the workflow service.
 *
 * `refreshSite` is optional and matters more than it looks: a page generated here lands in
 * `blog_posts`, but the web service serves `/blog/:slug` from `public/blog` on **its own**
 * disk and only rebuilds that directory at boot. Without a nudge, the page exists and 404s
 * until the next deploy. So the run ends by asking the site to re-read the database
 * (`POST /admin/restore-blogs`), which rebuilds every file, the index, and the sitemap.
 *
 * @param {{task: Function, deps: {load: Function, generateOffer: Function,
 *          refreshSite?: Function}}} config
 * @returns {{blogOffer: any, blogQueue: any}}
 */
export function registerBlogWorkflow({ task, deps }) {
  if (typeof task !== 'function') throw new Error('registerBlogWorkflow needs the Render task() factory');
  if (typeof deps?.generateOffer !== 'function') throw new Error('registerBlogWorkflow needs deps.generateOffer');

  const blogOffer = task({ name: BLOG_TASK_NAMES.offer }, async function blogOffer(ctx, offerId) {
    return deps.generateOffer(offerId);
  });

  const blogQueue = task({ name: BLOG_TASK_NAMES.queue }, async function blogQueue(ctx, input) {
    const result = await runBlogQueue(ctx, input, { load: deps.load, blogOffer });
    if (typeof deps.refreshSite === 'function' && result.pages > 0) {
      // Never let the nudge fail the run: the pages are already committed to the database,
      // and a restart would pick them up anyway.
      try {
        result.refresh = await deps.refreshSite();
      } catch (error) {
        result.refresh = { ok: false, error: error.message };
      }
    }
    return result;
  });

  return { blogOffer, blogQueue };
}
