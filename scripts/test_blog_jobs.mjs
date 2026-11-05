/**
 * Blog jobs: the two "optimise" buttons (2026-11-05)
 *
 * The buttons are only safe if three things hold, so those are what is tested:
 *   - a tenant job can never become a global one (no tenant id = no job, not "everyone's");
 *   - a second click does not start a competing walk;
 *   - progress is written as it goes, and a failed offer is recorded rather than swallowed.
 *
 * Everything runs against fakes: no Supabase, no AI keys, no nine-minute wait.
 */
import {
  buildJobRow,
  drainJob,
  startBlogJob,
  jobInFlight,
  resetRunningJobs,
  JOB_STATUS
} from '../utils/blogJobs.js';

let pass = 0;
let fail = 0;

function ok(name, condition, detail) {
  if (condition) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function offer(id, overrides = {}) {
  return { id, title: 'Role ' + id, slug: 'role-' + id, status: 'draft', referral_url: 'https://x/r', compensation_max: 40, deleted_at: null, ...overrides };
}

/** A job store and a generator that both record what happened, in order. */
function harness({ offers = [], posts = [], generate } = {}) {
  const updates = [];
  let created = 0;
  return {
    updates,
    get created() { return created; },
    deps: {
      create: async (row) => { created += 1; return { id: 'job-' + created, ...row }; },
      load: async () => ({ offers, posts }),
      generate: generate || (async () => ({ success: true, posts: [{ slug: 'p' }], mode: 'ai' })),
      update: async (id, patch) => { updates.push({ id, ...patch }); return {}; }
    }
  };
}

// ─── A tenant job is never a global job ────────────────────────────────────
{
  const row = buildJobRow({ scope: 'tenant', tenantId: 't1', limit: 3 });
  eq('a tenant row carries its tenant', row.tenant_id, 't1');
  eq('and starts queued', row.status, JOB_STATUS.queued);
  eq('with the requested limit', row.limit_offers, 3);

  const global = buildJobRow({ scope: 'global', limit: 5 });
  eq('a global row has no tenant', global.tenant_id, null);

  let threw = '';
  try { buildJobRow({ scope: 'tenant', tenantId: null }); } catch (e) { threw = e.message; }
  ok('a tenant job without a tenant is refused', /needs a tenant id/.test(threw), threw);

  threw = '';
  try { buildJobRow({ scope: 'everything' }); } catch (e) { threw = e.message; }
  ok('an unknown scope is refused', /tenant or global/.test(threw), threw);
}

// ─── The drain walks the plan and records every offer ──────────────────────
{
  const h = harness({ offers: [offer('o1'), offer('o2')] });
  const job = { id: 'job-1', limit_offers: 5, budget_ms: 0 };
  const result = await drainJob(job, h.deps);

  eq('both offers were generated', result.done, 2);
  eq('pages are counted across offers', result.pages, 2);
  eq('nothing failed', result.failed, 0);
  eq('the job ends done', result.ok, true);

  const statuses = h.updates.map((u) => u.status).filter(Boolean);
  eq('the job is marked running before the first offer', statuses[0], JOB_STATUS.running);
  eq('and done at the end', statuses[statuses.length - 1], JOB_STATUS.done);

  const progress = h.updates.filter((u) => u.done != null).map((u) => u.done);
  eq('progress is written after each offer', progress.join(','), '1,2');

  const planUpdate = h.updates.find((u) => u.plan);
  ok('the plan is stored so the portal can explain itself', Array.isArray(planUpdate.plan.runs));
  eq('the plan knows how many offers it queued', planUpdate.total, 2);
}

// An offer that already has a full journey is not regenerated — the plan owns that decision.
{
  const h = harness({
    offers: [offer('done'), offer('fresh')],
    posts: Array.from({ length: 9 }, (_, i) => ({ opportunity_id: 'done', slug: 'done-' + i, status: 'published' }))
  });
  const result = await drainJob({ id: 'job-2', limit_offers: 5 }, h.deps);
  eq('only the uncovered offer is generated', result.done, 1);
  eq('the covered one is reported as skipped', h.updates.find((u) => u.plan).plan.skipped[0].reason, 'covered');
}

// ─── Failure handling ──────────────────────────────────────────────────────
{
  const h = harness({
    offers: [offer('good'), offer('bad')],
    generate: async (id) => {
      if (id === 'bad') throw new Error('provider 429');
      return { success: true, posts: [{ slug: 'a' }], mode: 'ai' };
    }
  });
  const result = await drainJob({ id: 'job-3', limit_offers: 5 }, h.deps);
  eq('the healthy offer still ran', result.done, 2);
  eq('the failure is counted', result.failed, 1);
  eq('a partial failure is still "done", not "failed"', result.ok, true);
  const bad = result.results.find((r) => r.offerId === 'bad');
  eq('the failing offer is recorded with its reason', bad.error, 'provider 429');
  ok('and the reason reaches the row', /429/.test(JSON.stringify(h.updates.filter((u) => u.results).pop().results)));
}

{
  const h = harness({
    offers: [offer('a'), offer('b')],
    generate: async () => { throw new Error('no key configured'); }
  });
  const result = await drainJob({ id: 'job-4', limit_offers: 5 }, h.deps);
  eq('every offer failing is a failed job', result.ok, false);
  eq('both are counted', result.failed, 2);
  const last = h.updates[h.updates.length - 1];
  eq('the row says failed', last.status, JOB_STATUS.failed);
  ok('with a human count', /2 of 2/.test(last.error || ''), last.error);
}

// A generator that reports success:false without throwing must not be counted as a win.
{
  const h = harness({
    offers: [offer('silent')],
    generate: async () => ({ success: false, posts: [], error: 'nothing written' })
  });
  const result = await drainJob({ id: 'job-5', limit_offers: 5 }, h.deps);
  eq('a silent no-op is a failure', result.failed, 1);
  eq('and writes no pages', result.pages, 0);
}

// Nothing to do is not an error: the tenant should not see red for "already written".
{
  const h = harness({ offers: [], posts: [] });
  const result = await drainJob({ id: 'job-6', limit_offers: 5 }, h.deps);
  eq('an empty queue succeeds', result.ok, true);
  eq('with nothing done', result.done, 0);
  ok('and the planner explains why', /0 offer\(s\) queued/.test(result.summary), result.summary);
  eq('the job still terminates', h.updates[h.updates.length - 1].status, JOB_STATUS.done);
}

// ─── One drain per scope ───────────────────────────────────────────────────
{
  resetRunningJobs();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({
    offers: [offer('slow')],
    generate: async () => { await gate; return { success: true, posts: [{ slug: 'x' }] }; }
  });

  const first = await startBlogJob({ scope: 'tenant', tenantId: 't1', deps: h.deps });
  eq('the first click starts a job', first.busy, false);
  eq('in-flight is visible while it runs', jobInFlight('tenant', 't1'), true);

  const second = await startBlogJob({ scope: 'tenant', tenantId: 't1', deps: h.deps });
  eq('the second click does not start a competing walk', second.busy, true);
  eq('it returns the running job', second.job.id, first.job.id);
  eq('and creates no second row', h.created, 1);

  const otherTenant = await startBlogJob({ scope: 'tenant', tenantId: 't2', deps: h.deps });
  eq('a different tenant is not blocked', otherTenant.busy, false);

  release();
  await first.completion;
  await otherTenant.completion;
  eq('the scope is released when the drain finishes', jobInFlight('tenant', 't1'), false);
  resetRunningJobs();
}

{
  resetRunningJobs();
  const h = harness({ offers: [], posts: [] });
  const { completion } = await startBlogJob({ scope: 'global', deps: h.deps });
  await completion;
  eq('a global job needs no tenant', h.updates[0].status, JOB_STATUS.running);
  resetRunningJobs();
}

// A drain that throws before it can update must still leave a reason on the row.
{
  resetRunningJobs();
  const updates = [];
  const deps = {
    create: async (row) => ({ id: 'job-boom', ...row }),
    load: async () => { throw new Error('supabase unreachable'); },
    generate: async () => ({ success: true, posts: [] }),
    update: async (id, patch) => { updates.push(patch); return {}; }
  };
  const { completion } = await startBlogJob({ scope: 'global', deps });
  const outcome = await completion;
  eq('the failure is reported to the caller', outcome.ok, false);
  const last = updates[updates.length - 1];
  eq('the row is marked failed', last.status, JOB_STATUS.failed);
  ok('with the cause', /unreachable/.test(last.error || ''), last.error);
  eq('and the scope is released so a retry can run', jobInFlight('global'), false);
  resetRunningJobs();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

