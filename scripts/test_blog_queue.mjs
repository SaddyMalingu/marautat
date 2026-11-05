/**
 * Blog queue planner (2026-11-05)
 *
 * The planner is the only thing standing between "the collector captured 40 roles" and
 * "a sandbox spent forty minutes of AI quota". So the tests are about the decisions, not
 * the shape: which offer goes first, what counts as already done, and what happens when
 * the budget cannot cover the queue.
 */
import { planBlogQueue, PAGES_PER_OFFER } from '../utils/blogQueue.js';

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
  return {
    id,
    title: 'Role ' + id,
    slug: 'role-' + id,
    status: 'draft',
    referral_url: null,
    compensation_max: null,
    description: null,
    deleted_at: null,
    source: { slug: 'turing' },
    ...overrides
  };
}

function pagesFor(offerId, count, status = 'published') {
  return Array.from({ length: count }, (_, i) => ({
    opportunity_id: offerId,
    slug: 'role-' + offerId + '-' + i,
    status
  }));
}

// ─── What counts as covered ────────────────────────────────────────────────
{
  const plan = planBlogQueue({
    offers: [offer('done'), offer('partial'), offer('fresh')],
    posts: [...pagesFor('done', PAGES_PER_OFFER), ...pagesFor('partial', 4)]
  });
  eq('a full journey is skipped as covered', plan.skipped.filter((s) => s.reason === 'covered').length, 1);
  eq('a half-written offer still queues', plan.runs.some((r) => r.offerId === 'partial'), true);
  const partial = plan.runs.find((r) => r.offerId === 'partial');
  eq('the plan says how many pages are live', partial.livePages, 4);
  eq('and how many are missing', partial.missing, 5);
  eq('an untouched offer asks for a whole journey', plan.runs.find((r) => r.offerId === 'fresh').pages, 9);
}

// A draft row is not a page a reader can reach. Treating it as coverage retires an
// offer that has nothing public, which is exactly what a failed run leaves behind.
{
  const plan = planBlogQueue({
    offers: [offer('drafts-only')],
    posts: pagesFor('drafts-only', PAGES_PER_OFFER, 'draft')
  });

// ─── Ordering: what earns first ────────────────────────────────────────────
{
  const plan = planBlogQueue({
    offers: [
      offer('a', { title: 'No Link Role', compensation_max: 20 }),
      offer('b', { title: 'Linked Role', compensation_max: 20, referral_url: 'https://turing.com/r/x' }),
      offer('c', { title: 'Linked Rich Role', compensation_max: 120, referral_url: 'https://turing.com/r/y' })
    ]
  });
  eq('a monetisable offer outranks one with no link', plan.runs[0].offerId, 'c');
  ok('the no-link offer sorts last', plan.runs[plan.runs.length - 1].offerId === 'a',
    plan.runs.map((r) => r.offerId).join(','));
  eq('needsLink names the offers that earn nothing yet', plan.needsLink.length, 1);
  ok('the reason is carried, not just the rank',
    plan.runs[plan.runs.length - 1].reasons.some((r) => /no referral link/i.test(r)));
}

// ─── Refusals ──────────────────────────────────────────────────────────────
{
  const plan = planBlogQueue({
    offers: [
      offer('gone', { deleted_at: '2026-11-01T00:00:00Z' }),
      offer('blank', { title: '' }),
      offer('noid', { id: null })
    ]
  });
  eq('a soft-deleted offer is never generated', plan.skipped.filter((s) => s.reason === 'deleted').length, 1);
  eq('a titleless offer is refused rather than written from its slug', plan.skipped.filter((s) => s.reason === 'untitled').length, 1);
  eq('an offer with no id cannot be written against', plan.skipped.filter((s) => s.reason === 'no_id').length, 1);
  eq('so nothing at all is queued', plan.runs.length, 0);
}

// ─── Bounds ────────────────────────────────────────────────────────────────
{
  const eight = Array.from({ length: 8 }, (_, i) => offer('o' + i, { referral_url: 'https://x/r' }));
  const plan = planBlogQueue({ offers: eight, limit: 3 });
  eq('the limit is honoured', plan.runs.length, 3);
  eq('overflow is deferred, not forgotten', plan.deferred.length, 5);
  ok('deferred entries say why they moved', plan.deferred.every((d) => d.reason === 'limit'),
    JSON.stringify(plan.deferred.map((d) => d.reason)));
  eq('totals count everything that was considered', plan.totals.eligible, 8);
}

{
  const plan = planBlogQueue({
    offers: Array.from({ length: 5 }, (_, i) => offer('b' + i, { referral_url: 'https://x/r' })),
    limit: 5,
    budgetMs: 200000,
    perOfferMs: 90000
  });
  eq('a budget of 200s fits two 90s offers', plan.runs.length, 2);
  eq('the rest are deferred for budget', plan.deferred.filter((d) => d.reason === 'budget').length, 3);
  eq('the estimate is the work actually admitted', plan.estimateMs, 180000);
}

{
  const plan = planBlogQueue({
    offers: [offer('one', { referral_url: 'https://x/r' })],
    budgetMs: 30000,
    perOfferMs: 90000
  });
  eq('a budget too small for one offer admits nothing', plan.runs.length, 0);
  eq('and says so instead of starting', plan.deferred[0].reason, 'budget');
}

// ─── The summary a panel can print ────────────────────────────────────────
{
  const plan = planBlogQueue({
    offers: [offer('s1', { referral_url: 'https://x/r' }), offer('s2')],
    posts: pagesFor('s1', 2)
  });
  ok('the summary counts offers and live pages', /2 offer\(s\) queued, 2 page\(s\) live/.test(plan.summary), plan.summary);
  ok('the summary mentions the time it will take', /min of generation/.test(plan.summary), plan.summary);
}

{
  const plan = planBlogQueue({ offers: [], posts: [] });
  eq('an empty tenant plans nothing', plan.runs.length, 0);
  eq('and says nothing is queued', plan.totals.planned, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

  eq('nine draft pages are not coverage', plan.runs.length, 1);
  eq('draft pages are not counted as live', plan.totals.livePages, 0);
  eq('the whole journey is still owed', plan.runs[0].missing, 9);
}
