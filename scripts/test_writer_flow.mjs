#!/usr/bin/env node

/**
 * Writer's Flow controls, verified without a database, a browser or the portal
 * (2026-11-02).
 *
 * The panel exists because a tenant could see outcomes but not work. That means the
 * suite has to prove four things, each of which fails silently otherwise:
 *
 *   1. **A run that died is not reported as running.** `status='running'` plus a stale
 *      heartbeat is a corpse; only the heartbeat tells you.
 *   2. **Two runners cannot claim one tenant.** The rule is enforced in the database,
 *      but the readable refusal in front of it must agree with it.
 *   3. **Partial is an outcome.** A capture that resolved 76 of 84 roles is not
 *      "succeeded", and rounding it up hides exactly the 8 a tenant must look at.
 *   4. **A human decision outranks the robot.** Re-running verification must not undo a
 *      link the tenant deliberately accepted.
 *
 * The store is tested against an in-memory table, so the payloads that reach Postgres
 * are asserted rather than assumed.
 *
 * Usage: npm run test:writer-flow
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createWriterFlowRouter } from '../routes/writerFlow.js';
import {
  RUN_STALL_MS,
  isActiveStatus,
  isExpiredQueue,
  isStalled,
  runProgress,
  deriveRunStatus,
  describeRun,
  canQueue,
  summarizeRuns,
  buildQueueRow,
  buildProgressPatch,
  buildFinishPatch,
  createRunStore,
  kindLabel,
  QUEUEABLE_KINDS
} from '../utils/browserActor/runs.js';
import {
  linkStateOf,
  shouldSkipVerification,
  buildVerdictPatch,
  buildClearPatch,
  buildAcceptPatch,
  linkQueue,
  buildPlatformFunnel,
  nextActions,
  writerFlowView,
  runsByPlatform,
  mergeRunWindows,
  COLLECTION_PLATFORMS
} from '../utils/writerFlow.js';
import { sanitizeOfferPatch } from '../utils/offerPatch.js';
import { sourceOf } from '../utils/coverage.js';

let pass = 0;
let fail = 0;
function ok(name, condition) {
  if (condition) { pass += 1; console.log(`PASS  ${name}`); } else { fail += 1; console.log(`FAIL  ${name}`); }
}
function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) console.log(`      got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  ok(name, same);
}

const NOW = Date.parse('2026-11-02T09:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// ---------------------------------------------------------------------------
// A run that died must not look like a run that is working
// ---------------------------------------------------------------------------

ok('a queued run is active', isActiveStatus('queued'));
ok('a running run is active', isActiveStatus('running'));
ok('a finished run is not active', !isActiveStatus('succeeded'));

const stalled = { status: 'running', heartbeat_at: ago(RUN_STALL_MS + 60_000) };
const fresh = { status: 'running', heartbeat_at: ago(5_000) };
const waiting = { status: 'queued', heartbeat_at: ago(RUN_STALL_MS + 60_000) };

ok('a run that stopped beating is stalled', isStalled(stalled, NOW));
ok('a fresh heartbeat is not stalled', !isStalled(fresh, NOW));
// A queued run has no worker to hear from yet. Calling that "stalled" would send the
// tenant hunting for a crashed process that never started.
ok('a queued run is waiting, never stalled', !isStalled(waiting, NOW));
ok('a finished run cannot stall', !isStalled({ status: 'succeeded', heartbeat_at: ago(RUN_STALL_MS * 10) }, NOW));

eq('progress is the fraction done', runProgress({ status: 'running', done_items: 3, total_items: 12 }, NOW).percent, 25);
eq('a finished run reads as complete even with no totals',
  runProgress({ status: 'succeeded', done_items: 0, total_items: 0 }, NOW).percent, 100);

// ---------------------------------------------------------------------------
// Partial is an outcome
// ---------------------------------------------------------------------------

eq('everything done is success', deriveRunStatus({ total: 5, done: 5, ok: 5, failed: 0 }), 'succeeded');
eq('some failures is partial, not success', deriveRunStatus({ total: 5, done: 5, ok: 4, failed: 1 }), 'partial');
eq('nothing at all is failure', deriveRunStatus({ total: 5, done: 0, ok: 0, failed: 0 }), 'failed');
eq('all failed is failure', deriveRunStatus({ total: 5, done: 5, ok: 0, failed: 5 }), 'failed');
eq('cancelled outranks the arithmetic', deriveRunStatus({ cancelled: true, total: 5, done: 5, ok: 5, failed: 0 }), 'cancelled');
eq('a crash with work behind it is partial', deriveRunStatus({ error: new Error('boom'), done: 3, ok: 3, failed: 0 }), 'partial');
eq('a crash with nothing behind it is failure', deriveRunStatus({ error: new Error('boom'), done: 0, ok: 0, failed: 0 }), 'failed');

ok('a queued run says it is waiting for a runner',
  /waiting for a runner/.test(describeRun({ kind: 'referrals', status: 'queued' }, NOW)));
ok('a stalled run says it stopped reporting',
  /stopped reporting/.test(describeRun({ kind: 'referrals', status: 'running', heartbeat_at: ago(RUN_STALL_MS + 60_000) }, NOW)));
ok('a live run reports its position',
  /running · 3\/10/.test(describeRun({ kind: 'referrals', status: 'running', done_items: 3, total_items: 10, heartbeat_at: ago(4_000) }, NOW)));

// ---------------------------------------------------------------------------
// One active run per tenant and kind
// ---------------------------------------------------------------------------

const activeReferrals = { id: 'r1', kind: 'referrals', status: 'running', heartbeat_at: ago(3_000) };
ok('a second capture is refused while one is live',
  !canQueue([activeReferrals], { kind: 'referrals', now: NOW }).ok);
ok('and the refusal says why',
  /already running/.test(canQueue([activeReferrals], { kind: 'referrals', now: NOW }).message));
ok('a different kind is still allowed', canQueue([activeReferrals], { kind: 'collect', now: NOW }).ok);
// `verify` runs inside the request, so queueing it would create a row nobody picks up.
ok('verification cannot be queued', !canQueue([], { kind: 'verify', now: NOW }).ok);
ok('a stalled run may be replaced',
  canQueue([{ id: 'r2', kind: 'referrals', status: 'running', heartbeat_at: ago(RUN_STALL_MS + 60_000) }], { kind: 'referrals', now: NOW }).ok);

const runSummary = summarizeRuns([
  { id: 'a', kind: 'referrals', status: 'running', heartbeat_at: ago(2_000), done_items: 1, total_items: 4 },
  { id: 'b', kind: 'collect', status: 'succeeded', finished_at: ago(86_400_000) }
], NOW);
eq('the summary counts live runs', runSummary.active, 1);
eq('the summary counts per kind', Object.keys(runSummary.latestByKind).length, 2);
ok('the headline describes the live run', /running/.test(runSummary.headline));
eq('no runs is said out loud', summarizeRuns([], NOW).total, 0);

// ---------------------------------------------------------------------------
// The payloads that actually reach Postgres
// ---------------------------------------------------------------------------

const queued = buildQueueRow({ tenantId: 't1', kind: 'Referrals', detail: { limit: 40 } });
eq('a queued row is scoped to the tenant', queued.tenant_id, 't1');
eq('the kind is normalised', queued.kind, 'referrals');
eq('a queued row starts queued, never running', queued.status, 'queued');
eq('the requested window becomes the total', queued.total_items, 40);

ok('every progress patch carries a heartbeat', Boolean(buildProgressPatch({ done: 1 }).heartbeat_at));
eq('a progress patch cannot go negative', buildProgressPatch({ done: -5 }).done_items, 0);

const closed = buildFinishPatch({ status: null, done: 5, ok: 4, failed: 1, total: 5 });
eq('a finish with no status derives one', closed.status, 'partial');
ok('a finished run has a finished_at', Boolean(closed.finished_at));

// ---------------------------------------------------------------------------
// The store, against an in-memory table
// ---------------------------------------------------------------------------

/**
 * Just enough of the Supabase query builder for the store: filters, an update payload,
 * and a thenable so `await builder` works.
 */
function fakeTable(seed = []) {
  const state = { rows: seed.map((row) => ({ ...row })) };

  const builder = (mode, payload) => {
    const filters = [];
    // A filter is either an equality or a set membership (`in`), because the panel now asks
    // for capture kinds only — verification runs would otherwise bury them.
    const matches = (row) => filters.every(([col, val]) => (
      Array.isArray(val) ? val.includes(row[col]) : row[col] === val
    ));
    const apply = () => {
      if (mode === 'insert') {
        const created = { id: `run-${state.rows.length + 1}`, created_at: new Date(NOW).toISOString(), ...payload };
        state.rows.push(created);
        return { data: created, error: null };
      }
      if (mode === 'update') {
        const touched = state.rows.filter(matches);
        touched.forEach((row) => Object.assign(row, payload));
        return { data: touched, error: null };
      }
      return { data: state.rows.filter(matches), error: null };
    };
    const api = {
      select: () => api,
      order: () => api,
      limit: () => api,
      eq: (col, val) => { filters.push([col, val]); return api; },
      in: (col, values) => { filters.push([col, Array.isArray(values) ? values : [values]]); return api; },
      // `maybeSingle` resolves to one row or null — never to an array. Returning an array
      // here is what makes an empty match look like a successful one, which in the real
      // client would turn a cross-tenant cancel into a silent no-op that reports 200.
      maybeSingle: () => {
        const result = apply();
        const rows = Array.isArray(result.data) ? result.data : [result.data];
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      then: (resolve, reject) => Promise.resolve(apply()).then(resolve, reject)
    };
    return api;
  };

  return {
    rows: state.rows,
    from: () => ({
      insert: (row) => builder('insert', row),
      select: () => builder('select'),
      update: (patch) => builder('update', patch)
    })
  };
}

const db = fakeTable();
const store = createRunStore({ table: () => db.from('browser_actor_runs'), now: () => NOW });

const created = await store.queue({ tenantId: 't1', kind: 'referrals', requestedBy: 'tenant', detail: { limit: 6 } });
eq('queue writes a queued row', created.status, 'queued');
eq('queue keeps the tenant', created.tenant_id, 't1');
ok('queue returns an id', Boolean(created.id));

const claimed = await store.claim({ runId: created.id });
eq('claiming marks the run running', claimed.status, 'running');
ok('claiming records when it started', Boolean(claimed.started_at));

await store.progress({ runId: created.id, done: 2, ok: 2, failed: 0, total: 6 });
const afterProgress = db.rows.find((row) => row.id === created.id);
eq('progress updates the counters', afterProgress.done_items, 2);
// The heartbeat is stamped with the real clock, not the test clock — that is the point
// of it, so the assertion is "recent", not "equal".
ok('progress refreshes the heartbeat',
  Number.isFinite(Date.parse(afterProgress.heartbeat_at)) && Date.now() - Date.parse(afterProgress.heartbeat_at) < 60_000);

const finished = await store.finish({ runId: created.id, done: 6, ok: 5, failed: 1, total: 6 });
eq('finish derives partial from the counts', finished.status, 'partial');
ok('finish closes the run', Boolean(finished.finished_at));

const foreign = await store.cancel({ runId: created.id, tenantId: 'someone-else' });
eq("cancelling another tenant's run finds nothing", foreign, null);
const own = await store.cancel({ runId: created.id, tenantId: 't1' });
eq('cancelling your own run works', own && own.status, 'cancelled');

// ---------------------------------------------------------------------------
// Link states — unknown is never healthy
// ---------------------------------------------------------------------------

eq('a link with no url is missing', linkStateOf({ referral_url: null }), 'missing');
eq('a link nobody checked is unchecked, not fine', linkStateOf({ referral_url: 'https://x.test/r/a' }), 'unchecked');
eq('a verified link is verified', linkStateOf({ referral_url: 'https://x.test/r/a', link_verdict: 'match' }), 'verified');
eq('a link pointing elsewhere is wrong', linkStateOf({ referral_url: 'https://x.test/r/a', link_verdict: 'mismatch' }), 'wrong');

ok('an accepted link is protected from re-verification',
  shouldSkipVerification({ link_note: 'accepted by tenant' }));
// Clearing removes the link, so there is nothing left for the verifier to protect.
ok('a cleared link is not protected — it is gone',
  !shouldSkipVerification({ link_note: 'cleared by tenant: pointed at Other Role' }));

eq('an unknown verdict is recorded as unresolvable',
  buildVerdictPatch({ verdict: 'probably-fine' }, new Date(NOW)).link_verdict, 'unresolvable');

const cleared = buildClearPatch({ pointsAt: 'Strategic Project Lead – Software Engineering', now: new Date(NOW) });
eq('clearing drops the url', cleared.referral_url, null);
eq('clearing drops the old verdict', cleared.link_verdict, null);
// The reason outlives the link: it is the only record of why a working URL disappeared.
ok('clearing keeps the reason it was cleared',
  /pointed at Strategic Project Lead/.test(cleared.link_note));

const accepted = buildAcceptPatch({ now: new Date(NOW) });
eq('accepting marks the link verified', accepted.link_verdict, 'match');
ok('and records that a human decided', /accepted by tenant/.test(accepted.link_note));

// ---------------------------------------------------------------------------
// The queue the tenant actually works through
// ---------------------------------------------------------------------------

const queueOffers = [
  { id: '1', title: 'Zeta role', referral_url: 'https://work.turing.com/r/z', link_verdict: 'match', slug: 't-turing-zeta' },
  { id: '2', title: 'Alpha role', referral_url: 'https://work.turing.com/r/a', link_verdict: 'mismatch', slug: 't-turing-alpha' },
  { id: '3', title: 'Beta role', referral_url: 'https://work.turing.com/r/b', slug: 't-turing-beta' },
  { id: '4', title: 'Gamma role', referral_url: null, slug: 't-turing-gamma' }
];
const queuedLinks = linkQueue(queueOffers, { limit: 10 });
eq('the queue drops the verified ones', queuedLinks.length, 3);
eq('and leads with the wrong link', queuedLinks[0].state, 'wrong');
eq('then the unchecked ones', queuedLinks[1].state, 'unchecked');
eq('and last the missing ones', queuedLinks[2].state, 'missing');
eq('the queue can be capped', linkQueue(queueOffers, { limit: 1 }).length, 1);

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

const funnel = buildPlatformFunnel([
  { id: '1', status: 'published', referral_url: 'https://work.turing.com/r/a', link_verdict: 'match', slug: 't-turing-a' },
  { id: '2', status: 'draft', referral_url: 'https://work.turing.com/r/b', slug: 't-turing-b' },
  { id: '3', status: 'published', referral_url: null, slug: 't-turing-c' }
]);
eq('one marketplace is one row', funnel.length, 1);
eq('captured counts everything', funnel[0].captured, 3);
eq('live counts only published', funnel[0].live, 2);
eq('drafts are counted separately', funnel[0].draft, 1);
eq('linked counts the offers with a url', funnel[0].linked, 2);
eq('missing is the drop-off', funnel[0].missing, 1);
eq('verified is the one proven link', funnel[0].verified, 1);
// 1 of 3 proven: 33%, not "looks fine".
eq('the earning share is verified over captured', funnel[0].verifiedShare, 33);

// ---------------------------------------------------------------------------
// What to do next
// ---------------------------------------------------------------------------

const actions = nextActions({
  coverage: { wrong: 2, missingReferral: 8, uncheckedLinks: 10, drafts: 20, verified: 60 },
  platforms: [],
  runs: { total: 3, stalled: 0 },
  links: { thin: 4 }
});
eq('wrong links lead the list', actions[0].key, 'wrong_links');
eq('and they are the critical one', actions[0].severity, 'critical');
ok('the list offers the verify action', actions.some((a) => a.key === 'verify_links' && a.action.type === 'verify'));
ok('thin descriptions queue a refresh',
  actions.some((a) => a.key === 'thin_descriptions' && a.action.detail?.refresh === true));
// Severity order is the promise that the top row is the one costing money.
const severities = actions.map((a) => ['critical', 'high', 'medium', 'low'].indexOf(a.severity));
ok('the list is sorted by severity', severities.every((v, i) => i === 0 || severities[i - 1] <= v));
eq('a healthy tenant gets no actions',
  nextActions({ coverage: { wrong: 0, missingReferral: 0, uncheckedLinks: 0, drafts: 0, verified: 10 }, runs: { total: 1 }, links: { thin: 0 } }).length, 0);
ok('a stalled run is surfaced',
  nextActions({ coverage: {}, runs: { total: 2, stalled: 1 }, links: {} }).some((a) => a.key === 'stalled_run'));

// ---------------------------------------------------------------------------
// The whole panel payload
// ---------------------------------------------------------------------------

const view = writerFlowView({
  offers: queueOffers,
  runs: [{ id: 'r9', kind: 'referrals', status: 'running', done_items: 2, total_items: 8, heartbeat_at: ago(3_000) }],
  identity: { configured: true, mapped: true, label: '***1234' },
  now: NOW
});
eq('the view reports link counts', view.links.counts.wrong, 1);
eq('the view carries the queue', view.links.queue.length, 3);
eq('the view carries the identity through', view.identity.mapped, true);
eq('the view reports one live run', view.runs.active, 1);
ok('the view explains the run', /running/.test(view.runs.headline));

const degraded = writerFlowView({ offers: [], runs: [], runsAvailable: false, now: NOW });
// "Unavailable" and "none yet" are different facts; saying the wrong one hides a broken
// deployment behind a friendly zero.
ok('a missing runs table is stated, not counted as zero runs',
  /unavailable/.test(degraded.runs.headline));

// ---------------------------------------------------------------------------
// A tenant cannot verify their own links by patching the row
// ---------------------------------------------------------------------------

const patchAttempt = sanitizeOfferPatch({ link_verdict: 'match', link_note: 'accepted by tenant', link_checked_at: new Date(NOW).toISOString(), title: 'Renamed' });
eq('link_verdict is not patchable', patchAttempt.patch.link_verdict, undefined);
eq('link_note is not patchable', patchAttempt.patch.link_note, undefined);
eq('link_checked_at is not patchable', patchAttempt.patch.link_checked_at, undefined);
eq('the rest of the patch still applies', patchAttempt.patch.title, 'Renamed');
ok('and the refusal is reported back', patchAttempt.ignored.includes('link_verdict'));

// ---------------------------------------------------------------------------
// The wiring exists (a panel nobody mounts is a mockup)
// ---------------------------------------------------------------------------

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const serverSource = read('server.js');
const dashboardSource = read('admin/tenant_dashboard.html');
const migrationSource = read('migrations/2026-11-02_writer_flow_runs.sql');
const cliSource = read('scripts/browser_actor_referrals.mjs');

ok('the router is mounted in the server', serverSource.includes('createWriterFlowRouter({'));
ok('the panel asks for the per-tenant view', dashboardSource.includes("'/tenant/blogger/writer-flow'"));
ok('the verify button exists in the portal', dashboardSource.includes('data-wfact="verify"'));
ok('the resolve flow exists in the portal', dashboardSource.includes('/resolve'));
ok('the portal can queue a run', dashboardSource.includes("data-wfact=\"queue\""));
// Polling must stop when nothing is live, or a tenant who leaves the tab open hammers
// the database all afternoon.
ok('polling is time-boxed to live runs', /r\.data\.runs\.active/.test(dashboardSource));
ok('one live run per tenant and kind is enforced in the database',
  /uq_browser_actor_runs_active/.test(migrationSource) && /WHERE status IN \('queued', 'running'\)/.test(migrationSource));
ok('the runner can pick up a queued run', cliSource.includes("flag('run-id')") && cliSource.includes('startRunTracking'));
ok('a crashed runner closes its run as failed', /status: 'failed'/.test(cliSource));

// ---------------------------------------------------------------------------
// The endpoints, over real HTTP — because the deliverable is a button
// ---------------------------------------------------------------------------

/**
 * Supabase-shaped fake: filters, insert, update, and `maybeSingle` that resolves to one
 * row or null. Enough for the router's real queries, and no database in sight.
 */
function fakeDb({ offers = [], runs = [], signals = [] } = {}) {
  const tables = {
    opportunities: offers.map((row) => ({ ...row })),
    browser_actor_runs: runs.map((row) => ({ ...row })),
    // Listening lives in its own table since 2026-11-04. The panel reads it on every load, so a
    // fake that does not know it makes the whole panel endpoint look broken.
    social_signals: signals.map((row) => ({ ...row }))
  };
  const from = (name) => {
    const rows = tables[name] || (tables[name] = []);
    const mk = (mode, payload) => {
      const filters = [];
      const match = (row) => filters.every(([col, kind, val]) => {
        if (kind === 'eq') return row[col] === val;
        if (kind === 'in') return Array.isArray(val) ? val.includes(row[col]) : false;
        if (kind === 'gte') return Number(row[col]) >= Number(val);
        if (kind === 'neq') return row[col] !== val;
        if (kind === 'is') return val === null ? row[col] === null || row[col] === undefined : row[col] === val;
        if (kind === 'notnull') return row[col] !== null && row[col] !== undefined;
        return true;
      });
      const apply = () => {
        if (mode === 'insert') {
          const created = { id: `run-${rows.length + 1}`, created_at: new Date().toISOString(), ...payload };
          rows.push(created);
          return { data: created, error: null };
        }
        if (mode === 'update') {
          const hits = rows.filter(match);
          hits.forEach((row) => Object.assign(row, payload));
          return { data: hits, error: null };
        }
        return { data: rows.filter(match), error: null };
      };
      const api = {
        select: () => api,
        order: () => api,
        limit: () => api,
        eq: (col, val) => { filters.push([col, 'eq', val]); return api; },
        // The panel now asks for capture kinds only, so the fake must understand `in`.
        in: (col, values) => { filters.push([col, 'in', Array.isArray(values) ? values : [values]]); return api; },
        // And since 2026-11-04 it reads the listening digest, which filters by score and status.
        gte: (col, val) => { filters.push([col, 'gte', val]); return api; },
        neq: (col, val) => { filters.push([col, 'neq', val]); return api; },
        is: (col, val) => { filters.push([col, 'is', val]); return api; },
        not: (col, _op, val) => { filters.push([col, 'notnull', val]); return api; },
        maybeSingle: () => {
          const result = apply();
          const list = Array.isArray(result.data) ? result.data : [result.data];
          return Promise.resolve({ data: list[0] || null, error: null });
        },
        then: (resolve, reject) => Promise.resolve(apply()).then(resolve, reject)
      };
      return api;
    };
    return { insert: (row) => mk('insert', row), select: () => mk('select'), update: (patch) => mk('update', patch) };
  };
  return { from, tables };
}

const routeOffers = [
  { id: 'o1', title: 'Project Lead - AI Training', slug: 't-turing-o1', status: 'published', tenant_id: 't1', external_id: 'turing:o1', referral_url: 'https://work.turing.com/r/good', link_verdict: null, link_note: null, deleted_at: null },
  { id: 'o2', title: 'Medical Expert - Dermatology', slug: 't-turing-o2', status: 'draft', tenant_id: 't1', external_id: 'turing:o2', referral_url: 'https://work.turing.com/r/bad', link_verdict: null, link_note: null, deleted_at: null },
  { id: 'o3', title: 'Accepted Role', slug: 't-turing-o3', status: 'published', tenant_id: 't1', external_id: 'turing:o3', referral_url: 'https://work.turing.com/r/accepted', link_verdict: 'match', link_note: 'accepted by tenant', deleted_at: null },
  { id: 'o4', title: 'No link yet', slug: 't-turing-o4', status: 'draft', tenant_id: 't1', external_id: 'turing:o4', referral_url: null, link_verdict: null, link_note: null, deleted_at: null }
];

const routeDb = fakeDb({ offers: routeOffers, runs: [] });
const verifyCalls = [];
const app = express();
app.use(express.json());
app.use('/', createWriterFlowRouter({
  tenantSessionAuth: (req, _res, next) => next(),
  tenantSiteFromSession: async () => ({ site: { id: 't1', slug: 'malingu-ventures', name: 'Malingu Ventures' } }),
  supabase: routeDb,
  verify: async ({ url }) => {
    verifyCalls.push(url);
    if (url.endsWith('/r/good')) return { verdict: 'match', reason: 'title_match', resolvedTitle: 'Project Lead - AI Training' };
    return { verdict: 'mismatch', reason: 'title_mismatch', resolvedTitle: 'Strategic Project Lead – Software Engineering' };
  }
}));
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (url) => {
  const res = await fetch(base + url);
  return { status: res.status, body: await res.json() };
};
const post = async (url, payload) => {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return { status: res.status, body: await res.json() };
};

const viewRes = await get('/tenant/blogger/writer-flow');
eq('the panel endpoint answers', viewRes.status, 200);
ok('and it reports the listening state, even before anything is captured',
  viewRes.body.listening && viewRes.body.listening.available === true && Array.isArray(viewRes.body.listening.items));
eq("and it is scoped to the session's tenant", viewRes.body.tenant.slug, 'malingu-ventures');
eq('it reports the funnel', viewRes.body.platforms[0].captured, 4);
eq('it reports the unverified links', viewRes.body.links.counts.unchecked, 2);
eq('it reports the offer with no link', viewRes.body.links.counts.missing, 1);

const verifyRes = await post('/tenant/blogger/links/verify', {});
eq('the verify button returns 200', verifyRes.status, 200);
eq('it checked the two unchecked links', verifyRes.body.checked, 2);
eq('it confirmed one', verifyRes.body.verdicts.match, 1);
eq('it caught the wrong one', verifyRes.body.verdicts.mismatch, 1);
// The tenant already accepted o3; a robot must not overrule a human decision.
ok('it left the accepted link alone', !verifyCalls.some((url) => url.endsWith('/r/accepted')));
eq('the wrong link was written to the row',
  routeDb.tables.opportunities.find((row) => row.id === 'o2').link_verdict, 'mismatch');
ok('the verdict records where the link really lands',
  /Strategic Project Lead/.test(verifyRes.body.results.find((row) => row.id === 'o2').pointsAt || ''));

const clearRes = await post('/tenant/blogger/links/o2/resolve', { action: 'clear' });
eq('clearing a wrong link succeeds', clearRes.status, 200);
eq('and leaves the offer with no link', clearRes.body.offer.referral_url, null);
ok('while keeping the reason it was cleared', /cleared by tenant/.test(clearRes.body.offer.link_note || ''));

const acceptRes = await post('/tenant/blogger/links/o1/resolve', { action: 'accept' });
eq('accepting marks it verified', acceptRes.body.offer.link_verdict, 'match');
ok('and records the human decision', /accepted by tenant/.test(acceptRes.body.offer.link_note || ''));

const badAction = await post('/tenant/blogger/links/o1/resolve', { action: 'publish' });
eq('an unknown action is refused', badAction.status, 400);
const missingLink = await post('/tenant/blogger/links/o4/resolve', { action: 'recheck' });
eq('rechecking an offer with no link is refused', missingLink.status, 400);
const foreignLink = await post('/tenant/blogger/links/o99/resolve', { action: 'recheck' });
eq("another tenant's offer cannot be resolved", foreignLink.status, 404);

const queueRes = await post('/tenant/blogger/runs', { kind: 'referrals', limit: 40 });
eq('queueing a capture returns 201', queueRes.status, 201);
eq('and the run starts queued', queueRes.body.run.status, 'queued');
ok('and the response says how a runner picks it up', /--run-id/.test(queueRes.body.command || ''));
const queueAgain = await post('/tenant/blogger/runs', { kind: 'referrals' });
eq('a second capture is refused while one is queued', queueAgain.status, 409);
const queueVerify = await post('/tenant/blogger/runs', { kind: 'verify' });
eq('verification cannot be queued as a run', queueVerify.status, 400);

// The Listening card's buttons send exactly this, so the route is the thing to test rather than
// the markup: a `listen` run must be accepted, must record the network it targets (the worker
// dispatches on that), and must refuse a network no runner can read.
const queueListen = await post('/tenant/blogger/runs', { kind: 'listen', platform: 'x', limit: 3 });
eq('listening can be queued from the panel', queueListen.status, 201);
eq('as its own kind, not a capture', queueListen.body.run.kind, 'listen');
eq('with the chosen network recorded, so the worker picks the right site',
  queueListen.body.run.detail.platform, 'x');
eq('and the runs it starts are searches, not roles', queueListen.body.run.detail.limit, 3);
ok('the command it prints names the network and has no --apply',
  /browser_actor_social_listen\.mjs/.test(queueListen.body.command || '')
  && /--platform x/.test(queueListen.body.command || '')
  && !/--apply/.test(queueListen.body.command || ''));
const cancelListen = await post(`/tenant/blogger/runs/${queueListen.body.run.id}/cancel`, {});
eq('and it can be cancelled like any other run', cancelListen.body.run.status, 'cancelled');

const unknownNetwork = await post('/tenant/blogger/runs', { kind: 'listen', platform: 'myspace' });
eq('a network no runner can read is refused', unknownNetwork.status, 400);
ok('naming the ones that work', /linkedin, x, facebook, reddit, youtube/.test(unknownNetwork.body.error || ''));

const foreignCancel = await post('/tenant/blogger/runs/not-mine/cancel', {});
eq('cancelling an unknown run is a 404', foreignCancel.status, 404);
const cancelRes = await post(`/tenant/blogger/runs/${queueRes.body.run.id}/cancel`, {});
eq('cancelling your own queued run works', cancelRes.body.run.status, 'cancelled');

const afterQueue = await get('/tenant/blogger/writer-flow');
ok('the panel now shows run history',
  Array.isArray(afterQueue.body.runs.recent) && afterQueue.body.runs.recent.length >= 1);
// The fake table hands rows back unsorted, so assert on presence rather than on order:
// the ordering itself is Postgres's job (`order by created_at desc`) and is asserted by
// the store's query, not by this fake.
ok('the cancelled run is in the history',
  (afterQueue.body.runs.recent || []).some((run) => run.status === 'cancelled'));


await new Promise((resolve) => server.close(resolve));

// ---------------------------------------------------------------------------
// The deployment state that exists right now: migration not applied yet
// ---------------------------------------------------------------------------

// A database without `link_note` must not take the panel down — it must say what it
// cannot do and keep doing what it can.
const degradedDb = fakeDb({ offers: routeOffers.map(({ link_note, ...rest }) => rest), runs: [] });
const picky = {
  from(name) {
    const base = degradedDb.from(name);
    return {
      ...base,
      select(columns) {
        if (String(columns).includes('link_note')) {
          const error = new Error('column opportunities.link_note does not exist');
          error.code = '42703';
          const failing = {
            eq: () => failing,
            is: () => failing,
            not: () => failing,
            order: () => failing,
            limit: () => failing,
            maybeSingle: () => Promise.resolve({ data: null, error }),
            select: () => failing,
            then: (resolve) => resolve({ data: null, error })
          };
          return failing;
        }
        return base.select(columns);
      }
    };
  }
};

const degradedApp = express();
degradedApp.use(express.json());
degradedApp.use('/', createWriterFlowRouter({
  tenantSessionAuth: (req, _res, next) => next(),
  tenantSiteFromSession: async () => ({ site: { id: 't1', slug: 'malingu-ventures', name: 'Malingu Ventures' } }),
  supabase: picky,
  verify: async () => ({ verdict: 'match', reason: 'title_match', resolvedTitle: 'x' })
}));
const degradedServer = http.createServer(degradedApp);
await new Promise((resolve) => degradedServer.listen(0, '127.0.0.1', resolve));
const degradedBase = `http://127.0.0.1:${degradedServer.address().port}`;

const degradedView = await (await fetch(degradedBase + '/tenant/blogger/writer-flow')).json();
ok('the panel still renders without the migration', degradedView.ok === true);
eq('and says link health is unavailable', degradedView.linksAvailable, false);

const degradedVerify = await fetch(degradedBase + '/tenant/blogger/links/verify', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
});
const degradedVerifyBody = await degradedVerify.json();
eq('verification still runs without the migration', degradedVerify.status, 200);
ok('and still checks the links', degradedVerifyBody.checked >= 1);

const degradedAccept = await fetch(degradedBase + '/tenant/blogger/links/o1/resolve', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept' })
});
const degradedAcceptBody = await degradedAccept.json();
// Refusing with an instruction beats a 500 and a stack trace.
eq('accepting is refused with an instruction', degradedAccept.status, 503);
ok('and the instruction names the file to apply',
  /2026-11-02_writer_flow_runs\.sql/.test(degradedAcceptBody.hint || ''));

await new Promise((resolve) => degradedServer.close(resolve));

// ---------------------------------------------------------------------------
// A stuck run must not turn Capture now into a 500
// ---------------------------------------------------------------------------

function routerFor(db) {
  const routerApp = express();
  routerApp.use(express.json());
  routerApp.use('/', createWriterFlowRouter({
    tenantSessionAuth: (req, _res, next) => next(),
    tenantSiteFromSession: async () => ({ site: { id: 't1', slug: 'malingu-ventures', name: 'Malingu Ventures' } }),
    supabase: db,
    verify: async () => ({ verdict: 'match', reason: 'title_match', resolvedTitle: 'x' })
  }));
  return routerApp;
}

async function withServer(db) {
  const routerApp = routerFor(db);
  const httpServer = http.createServer(routerApp);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${httpServer.address().port}`,
    close: () => new Promise((resolve) => httpServer.close(resolve))
  };
}

{
  // Observed in production: POST /tenant/blogger/runs → 500 "duplicate key value violates
  // unique constraint uq_browser_actor_runs_active". `canQueue` ignores a run whose heartbeat
  // stopped, but the partial index does not, so the insert hit a row nobody was watching.
  const staleDb = fakeDb({
    runs: [{
      id: 'run-stuck',
      tenant_id: 't1',
      kind: 'referrals',
      status: 'running',
      started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      heartbeat_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      done_items: 4, ok_items: 3, failed_items: 1, total_items: 12
    }]
  });
  const server = await withServer(staleDb);
  try {
    const res = await fetch(server.base + '/tenant/blogger/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'referrals' })
    });
    eq('an abandoned run does not block a new capture', res.status, 201);
    const stuck = staleDb.tables.browser_actor_runs.find((row) => row.id === 'run-stuck');
    eq('and the abandoned run is closed as failed', stuck?.status, 'failed');
    ok('with a message that explains it', /stopped reporting/.test(stuck?.message || ''));
    eq('and a fresh run is queued', staleDb.tables.browser_actor_runs.filter((row) => row.status === 'queued').length, 1);
  } finally {
    await server.close();
  }
}

{
  // Two tabs, or a retry, landing on the index at the same moment.
  const conflictDb = fakeDb({ runs: [] });
  const originalFrom = conflictDb.from;
  conflictDb.from = (name) => {
    const api = originalFrom(name);
    if (name !== 'browser_actor_runs') return api;
    return {
      ...api,
      insert: () => {
        throw Object.assign(new Error('duplicate key value violates unique constraint "uq_browser_actor_runs_active"'), { code: '23505' });
      }
    };
  };
  const server = await withServer(conflictDb);
  try {
    const res = await fetch(server.base + '/tenant/blogger/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'referrals' })
    });
    const body = await res.json();
    eq('a duplicate-key race is a 409, not a 500', res.status, 409);
    eq('and is reported as already running', body.reason, 'already_running');
    ok('with a sentence, not a constraint name', /try again/i.test(body.error || '') && !/uq_browser_actor/.test(body.error || ''));
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Micro1 and Turing are different jobs, so the panel must not blur them
// ---------------------------------------------------------------------------
//
// Both used to be buttons in one row, which meant a tenant could not tell which button
// needed their worker running, which one spent a MoreLogin start, or which one had failed.
// These assertions hold the split: each marketplace gets its own bucket, its own current run
// and its own history, and a legacy row with no `platform` still lands in Turing.

{
  const runs = [
    // Newest first, the order the store returns.
    { id: 'r3', kind: 'referrals', status: 'running', detail: { platform: 'micro1' }, started_at: ago(60_000), heartbeat_at: ago(10_000), created_at: ago(60_000), done_items: 3, total_items: 12 },
    { id: 'r2', kind: 'referrals', status: 'succeeded', detail: { platform: 'micro1' }, created_at: ago(3_600_000), finished_at: ago(3_000_000), done_items: 12, total_items: 12 },
    { id: 'r1', kind: 'referrals', status: 'failed', created_at: ago(7_200_000), finished_at: ago(7_000_000), done_items: 4, total_items: 12 }
  ];
  const grouped = runsByPlatform(runs, NOW);
  eq('a micro1 run is grouped under micro1', grouped.micro1.last.id, 'r3');
  eq('and the run in flight is reported as the current one', grouped.micro1.current.id, 'r3');
  eq('a row with no platform stays Turing — the legacy writer-flow shape', grouped.turing.last.id, 'r1');
  eq('so Turing shows its own last outcome', grouped.turing.last.status, 'failed');
  eq('and Turing has nothing running', grouped.turing.active, false);
  eq('a micro1 run never leaks into the Turing count', grouped.turing.total, 1);
  eq('the two marketplaces the panel knows about', COLLECTION_PLATFORMS.map((p) => p.slug), ['turing', 'micro1']);

  // A micro1 row whose heartbeat stopped is stalled, which is a different sentence from
  // "running" and the reason the card cannot just print the status column.
  const stalledRow = {
    id: 'r9', kind: 'referrals', status: 'running', detail: { platform: 'micro1' },
    started_at: ago(RUN_STALL_MS + 120_000), heartbeat_at: ago(RUN_STALL_MS + 60_000)
  };
  eq('a micro1 capture that stopped reporting is stalled, not running',
    runsByPlatform([stalledRow], NOW).micro1.stalled, 1);

  eq('an empty history says so per marketplace rather than inventing a run',
    runsByPlatform([], NOW).micro1.last, null);

  // Switching marketplace must never need a cancel first. A run nobody claimed holds the
  // (tenant, kind) slot in the database for ever, so it expires instead — long enough for a
  // worker window to open, short enough that the next click works.
  const staleQueue = (mins) => [{
    id: 'q1', kind: 'referrals', status: 'queued', created_at: new Date(NOW - mins * 60_000).toISOString()
  }];
  eq('a queued run older than 30 minutes has expired', isExpiredQueue(staleQueue(31)[0], NOW), true);
  eq('a fresh queued run has not', isExpiredQueue(staleQueue(5)[0], NOW), false);
  eq('a running run is never "expired queue" (it has a heartbeat to judge by)',
    isExpiredQueue({ status: 'running', created_at: new Date(NOW - 90 * 60_000).toISOString() }, NOW), false);
  eq('so an expired request does not refuse a new one',
    canQueue(staleQueue(31), { kind: 'referrals', now: NOW }).ok, true);
  eq('while a live request still does',
    canQueue(staleQueue(5), { kind: 'referrals', now: NOW }).reason, 'already_active');

  // The live bug this closes: a Turing run waiting for the operator held the `referrals` slot,
  // so the tenant's own Micro1 capture was refused as "already waiting" — for a marketplace
  // nothing was running in. Separate kinds, separate slots.
  const waitingTuring = [{ id: 'r-t', kind: 'referrals', status: 'queued', created_at: ago(600_000), total_items: 120 }];
  eq('a queued Turing run does not block a Micro1 capture', canQueue(waitingTuring, { kind: 'micro1', now: NOW }).ok, true);
  eq('but it does block a second Turing run',
    canQueue(waitingTuring, { kind: 'referrals', now: NOW }).reason, 'already_active');
  const waitingMicro1 = [{ id: 'r-m', kind: 'micro1', status: 'queued', created_at: ago(30_000), detail: { platform: 'micro1' } }];
  eq('and a queued Micro1 capture does not block Turing', canQueue(waitingMicro1, { kind: 'referrals', now: NOW }).ok, true);
  eq('while a second Micro1 capture waits its turn',
    canQueue(waitingMicro1, { kind: 'micro1', now: NOW }).reason, 'already_active');
  ok('micro1 is a known run kind with a label of its own', kindLabel('micro1') === 'Capture Micro1 links');
  ok('and it is not tenant-queueable through the writer-flow route', !QUEUEABLE_KINDS.includes('micro1'));

  // The panel reads two windows: newest-of-any-kind, and newest capture runs. Without the
  // second, a tenant who checks links a few times pushes their capture out of view and the
  // card says "never run" minutes after a successful capture — live, 3 Nov.
  const verifyNoise = Array.from({ length: 20 }, (_, i) => ({
    id: `v-${i}`, kind: 'verify', status: 'succeeded', created_at: new Date(NOW - i * 1000).toISOString()
  }));
  const buriedCapture = { id: 'cap-1', kind: 'collect', status: 'succeeded', detail: { platform: 'micro1' }, created_at: ago(10 * 60_000) };
  const merged = mergeRunWindows(verifyNoise, [buriedCapture]);
  eq('the merge keeps the capture that the newest-20 window lost', merged.some((r) => r.id === 'cap-1'), true);
  eq('and does not duplicate a row present in both windows',
    mergeRunWindows([buriedCapture], [buriedCapture]).length, 1);
  eq('so the Micro1 card can name its last run', runsByPlatform(merged, NOW).micro1.last.id, 'cap-1');

  const view = writerFlowView({ offers: [], runs, now: NOW });
  ok('the panel payload carries both marketplaces', Boolean(view.runs.byPlatform?.micro1 && view.runs.byPlatform?.turing));
  eq('and the current micro1 counters reach the card', view.runs.byPlatform.micro1.current.done, 3);

  // The panel is where the distinction has to be visible, so assert the markup, not just
  // the payload: two cards, one button set each, and no shared "both" row left behind.
  const dash = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'admin', 'tenant_dashboard.html'), 'utf8');
  ok('Collection control renders one card per marketplace',
    /function wfPlatformCardHtml/.test(dash)
    && /wfPlatformCardHtml\(d, \{ slug: 'turing'/.test(dash)
    && /wfPlatformCardHtml\(d, \{ slug: 'micro1'/.test(dash));
  ok('the Micro1 card is the one that drives the tenant browser',
    /data-wfact="capture"[^>]*>Capture Micro1 links/.test(dash));
  ok('the Turing card keeps its two runners', /data-wfact="queue" data-kind="referrals" data-refresh="0"/.test(dash)
    && /data-wfact="queue" data-kind="referrals" data-refresh="1"/.test(dash));
  ok('each card says how it runs, because that is what differs',
    /Reads Micro1 through <strong>your own browser<\/strong>/.test(dash)
    && /one marketplace at a time/.test(dash));
  ok('the old shared "both queue a Turing run" row is gone', !/Both queue a Turing run/.test(dash));

  // A marketplace filter on Your Offers. The rule that decides "which marketplace" must be the
  // same one the Collection funnel uses, or the table and the funnel will disagree the first
  // time an offer is attributed by evidence instead of by slug convention.
  ok('Your Offers has a marketplace filter', /id="wfFilterSource"/.test(dash)
    && /<option value="all">All marketplaces<\/option>/.test(dash));
  ok('and filters on the slug the server attached, not a re-derived guess',
    /String\(o\.source_slug \|\| 'unsourced'\) !== s\.source/.test(dash));
  ok('the options are built from the offers themselves', /sourceSelect\.innerHTML = '<option value="all">All marketplaces/.test(dash));
  ok('Unattributed sorts last, because it is a to-do, not a marketplace',
    /\(a\[0\] === 'unsourced' \? 1 : 0\)/.test(dash));
  const serverSrc = read('server.js');
  ok('the server attaches that slug with the funnel\'s own rule', /sourceOf\(o\)/.test(serverSrc)
    && /source_slug: source\.slug/.test(serverSrc));

  // And the rule itself, on the three shapes that exist in the database today.
  eq('a Micro1 capture is attributed by its slug', sourceOf({ slug: 'malingu-ventures-micro1-kicad-pcb-design-specialist' }).slug, 'micro1');
  eq('a Turing capture likewise', sourceOf({ slug: 'malingu-ventures-turing-ai-quality-analyst-english' }).slug, 'turing');
  eq('a hand-made offer with no evidence stays Unattributed', sourceOf({ slug: 'air-traffic-controller' }).slug, 'unsourced');
  eq('and a joined source row wins over the slug', sourceOf({ slug: 'whatever', source: { slug: 'mercor', name: 'Mercor' } }).slug, 'mercor');

  // A delegated click handler must know every action its own markup renders. On 2026-11-03 the
  // Micro1 card's `data-wfact="capture"` button lived in the control panel while only the
  // access panel handled `capture`, so the click sent no request, showed no error, and the
  // tenant reasonably concluded the feature was broken. Silence is the bug.
  //
  // Two actions are handled without a `=== '<action>'` comparison and are listed on purpose:
  //   worker-download — an <a href> that downloads the bundle; the browser does the work.
  //   leads           — the else branch of the campaigns handler (anything that is not "run"
  //                     shows that campaign's leads).
  const structurAllyHandled = new Set(['worker-download', 'leads']);
  const actions = [...new Set([...dash.matchAll(/data-wfact="([a-z][a-z-]*)"/g)].map((m) => m[1]))];
  const unhandled = actions.filter((act) => !structurAllyHandled.has(act) && !dash.includes(`=== '${act}'`));
  ok('every button action the panel renders is handled somewhere', unhandled.length === 0);
  if (unhandled.length) console.error(`      unhandled: ${unhandled.join(', ')}`);
  ok('and the Micro1 card specifically reaches the capture handler',
    /else if \(act === 'capture'\) wfCaptureNow\(btn\)/.test(dash));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);






