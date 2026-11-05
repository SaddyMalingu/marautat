/**
 * Blog workflow fan-out (2026-11-05)
 *
 * Proves the Render Workflow registration with a fake `task()` and a fake `ctx`, so the
 * parallel fan-out, the per-offer failure isolation and the "no images" decision are tested
 * without a Render deploy and without the SDK installed.
 */
import { registerBlogWorkflow, runBlogQueue, BLOG_TASK_NAMES } from '../workflows/blogWorkflow.js';

let pass = 0;
let fail = 0;

function ok(name, condition, detail) {
  if (condition) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

/** The Render SDK's `task({name}, fn)` shape, recorded instead of registered. */
function fakeTaskFactory(registry) {
  return (options, fn) => {
    const registered = { name: options.name, fn };
    registry.push(registered);
    return registered;
  };
}

function offer(id, overrides = {}) {
  return { id, title: 'Role ' + id, slug: 'role-' + id, status: 'draft', referral_url: 'https://x/r', compensation_max: 40, deleted_at: null, ...overrides };
}

/** A ctx whose chained run simply invokes the task function, as the Render runtime would. */
const ctxOf = () => ({ run: async (taskRef, arg) => taskRef.fn({}, arg) });

function build(deps) {
  return registerBlogWorkflow({ task: fakeTaskFactory([]), deps });
}

// ─── Registration ──────────────────────────────────────────────────────────
{
  const registry = [];
  const built = registerBlogWorkflow({
    task: fakeTaskFactory(registry),
    deps: { load: async () => ({ offers: [], posts: [] }), generateOffer: async () => ({ success: true, posts: [] }) }
  });
  eq('two tasks are registered', registry.length, 2);
  eq('the handler task is named for the API', registry[0].name, BLOG_TASK_NAMES.offer);
  eq('the queue task is named for the API', registry[1].name, BLOG_TASK_NAMES.queue);
  ok('both task handles come back', Boolean(built.blogOffer && built.blogQueue));
}

{
  let threw = '';
  try { registerBlogWorkflow({ task: null, deps: {} }); } catch (e) { threw = e.message; }
  ok('registration refuses to run without the SDK task factory', /task\(\)/.test(threw), threw);
  threw = '';
  try { registerBlogWorkflow({ task: () => ({}), deps: {} }); } catch (e) { threw = e.message; }
  ok('registration refuses to run without a generator', /generateOffer/.test(threw), threw);
}

// ─── Fan-out ───────────────────────────────────────────────────────────────
{
  const calls = [];
  const built = build({
    load: async () => ({ offers: [offer('o1'), offer('o2'), offer('o3')], posts: [] }),
    generateOffer: async (offerId) => {
      calls.push(offerId);
      return { success: true, posts: [{ slug: offerId + '-1' }], mode: 'ai' };
    }
  });
  const result = await built.blogQueue.fn(ctxOf(), { limit: 3 });
  eq('one chained run per planned offer', calls.length, 3);
  eq('every planned offer is generated once', new Set(calls).size, 3);
  eq('all three succeeded', result.succeeded, 3);
  eq('the run reports success', result.success, true);
  eq('pages are counted across offers', result.pages, 3);

// A dead provider on one offer must not cost the others their pages: the reason the fan-out
// catches per offer instead of letting Promise.all reject.
{
  const built = build({
    load: async () => ({ offers: [offer('good'), offer('bad')], posts: [] }),
    generateOffer: async (offerId) => {
      if (offerId === 'bad') throw new Error('provider 429 after retries');
      return { success: true, posts: [{ slug: 'a' }] };
    }
  });
  const result = await built.blogQueue.fn(ctxOf(), {});
  eq('the healthy offer still generated', result.succeeded, 1);
  eq('the failed offer is counted', result.failed, 1);
  eq('and the run is marked unsuccessful', result.success, false);
  const bad = result.results.find((r) => r.offerId === 'bad');
  ok('the failure carries the reason, not just a count', /429/.test(bad.error || ''), String(bad.error));
}

// A generator that returns success:false (nothing written) is a failure, not a quiet success —
// the exact bug the old nightly job had, where a dead AI key logged "success" with zero pages.
{
  const built = build({
    load: async () => ({ offers: [offer('silent')], posts: [] }),
    generateOffer: async () => ({ success: false, posts: [], error: 'no posts generated' })
  });
  const result = await built.blogQueue.fn(ctxOf(), {});
  eq('an empty generation run is red', result.failed, 1);
  eq('and writes no pages', result.pages, 0);
}

// ─── Bounds and refusals are the planner's ─────────────────────────────────
{
  const calls = [];
  const built = build({
    load: async () => ({
      offers: [offer('done'), offer('deleted', { deleted_at: '2026-11-01T00:00:00Z' }), offer('a'), offer('b'), offer('c')],
      // 'done' already has a full journey, so it must not be regenerated.
      posts: Array.from({ length: 9 }, (_, i) => ({ opportunity_id: 'done', slug: 'done-' + i, status: 'published' }))
    }),
    generateOffer: async (offerId) => { calls.push(offerId); return { success: true, posts: [] }; }
  });
  const result = await built.blogQueue.fn(ctxOf(), { limit: 2 });
  eq('the limit bounds the fan-out', calls.length, 2);
  eq('the covered offer is not regenerated', calls.includes('done'), false);
  eq('the deleted offer is not generated', calls.includes('deleted'), false);
  eq('the planner reports what it skipped', result.skipped, 2);
}

{
  const built = build({ load: async () => ({ offers: [], posts: [] }), generateOffer: async () => ({ success: true, posts: [] }) });
  const result = await built.blogQueue.fn({ run: async () => { throw new Error('must not run'); } }, {});
  eq('an empty tenant runs nothing', result.planned, 0);
  eq('and is not reported as a failure', result.success, true);
  ok('the reason is the planner summary', /0 offer\(s\) queued/.test(result.summary), result.summary);
}

// The runner is exported on its own, so a host other than Render can drive the fan-out.
{
  const result = await runBlogQueue(
    { run: async () => ({ success: true, posts: [{ slug: 'x' }] }) },
    { limit: 1 },
    { load: async () => ({ offers: [offer('solo')], posts: [] }), blogOffer: { name: 'blogOffer' } }
  );
  eq('the runner works without the SDK', result.succeeded, 1);
  eq('and reports one page', result.pages, 1);
}

// ─── The site nudge ────────────────────────────────────────────────────────
// A generated page lives in `blog_posts`; the web service serves `public/blog` from its own
// disk. If the run does not tell the site to re-read the database, the page exists and 404s
// until the next deploy — so the nudge is part of the contract, not a nicety.
{
  let refreshed = 0;
  const built = registerBlogWorkflow({
    task: fakeTaskFactory([]),
    deps: {
      load: async () => ({ offers: [offer('o1')], posts: [] }),
      generateOffer: async () => ({ success: true, posts: [{ slug: 'a' }] }),
      refreshSite: async () => { refreshed++; return { ok: true, restored: 9 }; }
    }
  });
  const result = await built.blogQueue.fn(ctxOf(), {});
  eq('the site is asked to re-read after pages were written', refreshed, 1);
  eq('the outcome is reported back to the caller', result.refresh.restored, 9);
}

{
  let refreshed = 0;
  const built = registerBlogWorkflow({
    task: fakeTaskFactory([]),
    deps: {
      load: async () => ({ offers: [], posts: [] }),
      generateOffer: async () => ({ success: true, posts: [] }),
      refreshSite: async () => { refreshed++; return { ok: true }; }
    }
  });
  await built.blogQueue.fn(ctxOf(), {});
  eq('nothing written means nothing to refresh', refreshed, 0);
}

{
  const built = registerBlogWorkflow({
    task: fakeTaskFactory([]),
    deps: {
      load: async () => ({ offers: [offer('o1')], posts: [] }),
      generateOffer: async () => ({ success: true, posts: [{ slug: 'a' }] }),
      refreshSite: async () => { throw new Error('restore endpoint 502'); }
    }
  });
  const result = await built.blogQueue.fn(ctxOf(), {});
  // The pages are already committed to the database; a failed nudge must not turn a good run red.
  eq('a failed nudge does not fail the run', result.success, true);
  eq('but it is reported', result.refresh.ok, false);
  ok('with the reason', /502/.test(result.refresh.error || ''), result.refresh.error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);


}
