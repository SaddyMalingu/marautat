/**
 * /apply — the tenant page, the answers it may send, and the run row it queues (2026-11-14)
 *
 * No database and no browser: the table is a fake that answers the query shapes `createRunStore` uses, and the
 * tenant lookup is a function. What is being proved is the boundary — which answers survive, which are refused,
 * which run the page may see, and what happens when two tenants exist at once.
 *
 * Run: node scripts/test_apply_portal.mjs
 */
import express from 'express';
import http from 'node:http';
import {
  ANSWER_KEYS,
  APPLY_KIND,
  APPLY_MODES,
  MAX_LOG_LINES,
  appendLogLine,
  applyRunView,
  buildApplyDetail,
  sanitizeAnswers
} from '../utils/applyRuns.js';
import { createApplyPortalRouter, isApplyRunActive } from '../routes/applyPortal.js';
import { answersFileName, buildApplyChildArgs, classifyApplyLine, summarizeApplyLine } from '../utils/browserActor/applyDispatch.js';
import { buildProgressPatch } from '../utils/browserActor/runs.js';

let pass = 0;
const failures = [];
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else failures.push(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const ok = (label, condition, detail = '') => {
  if (condition) pass += 1;
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const GOOD_ANSWERS = {
  fullName: 'David Saddy Malingu',
  discordUsername: 'SaddyMalingu',
  country: 'Kenya',
  email: 'saddymalingu@gmail.com',
  phone: '+254743780542',
  hasExperience: 'No',
  source: 'Reddit',
  referral: 'u/Silver-Tax-2158',
  deskPhoto: 'C:/Users/HP/Downloads/IMG_20211123_161036_205.jpg'
};

// ─── Answers: what the page may send ──────────────────────────────────────────────────────────
{
  const { answers, rejected } = sanitizeAnswers({ ...GOOD_ANSWERS, emial: 'typo@example.com', __proto__: 'x' });
  eq('known answers survive', answers.fullName, 'David Saddy Malingu');
  ok('an unknown key is reported, not silently kept', rejected.includes('emial'), rejected);
  ok('and it is not in the answers', !('emial' in answers));
  eq('whitespace is collapsed', sanitizeAnswers({ fullName: '  David   Saddy  ' }).answers.fullName, 'David Saddy');
  eq('empty values are dropped', sanitizeAnswers({ email: '   ' }).answers.email, undefined);
  eq('every key the runner knows is accepted', ANSWER_KEYS.filter((key) => !sanitizeAnswers({ [key]: 'x' }).answers[key]).length, 0);

  // The five writing answers (steps 16-20) are prose: 300 characters would cut a real answer in half.
  const long = 'a'.repeat(900);
  eq('a written answer keeps a full paragraph', sanitizeAnswers({ salesProcess: long }).answers.salesProcess.length, 900);
  eq('while a name stays short', sanitizeAnswers({ fullName: long }).answers.fullName.length, 300);
  ok('and the writing answers are keys the runner knows',
    ['subscriberAgency', 'salesProcess', 'captionShower', 'captionStrip', 'captionExplicit']
      .every((key) => ANSWER_KEYS.includes(key)));
}

{
  const good = buildApplyDetail({ mode: 'fill', waitHumanSeconds: 600, typingWpm: 78, answers: GOOD_ANSWERS });
  eq('a good request has no errors', good.errors, []);
  eq('and names the platform the worker filters on', good.detail.platform, 'chatterapply');
  eq('the wait is kept', good.detail.waitHumanSeconds, 600);
  ok('the typing speed is kept', good.detail.typingWpm === 78);
  eq('the answers travel with the run', good.detail.answers.email, 'saddymalingu@gmail.com');

  const huge = buildApplyDetail({ waitHumanSeconds: 99999, typingWpm: 400, answers: GOOD_ANSWERS });
  eq('the wait is clamped to an hour', huge.detail.waitHumanSeconds, 3600);
  eq('the speed is clamped', huge.detail.typingWpm, 200);

  ok('an unknown mode is refused', buildApplyDetail({ mode: 'submit', answers: GOOD_ANSWERS }).errors.some((e) => /mode must be/.test(e)));
  ok('every advertised mode is accepted',
    APPLY_MODES.every((mode) => !buildApplyDetail({ mode, answers: GOOD_ANSWERS }).errors.some((e) => /mode/.test(e))));
  ok('a missing name is named', buildApplyDetail({ answers: { ...GOOD_ANSWERS, fullName: '' } }).errors.some((e) => /fullName/.test(e)));
  ok('a missing desk photo is named', buildApplyDetail({ answers: { ...GOOD_ANSWERS, deskPhoto: '' } }).errors.some((e) => /deskPhoto/.test(e)));
  ok('no answers at all is refused', buildApplyDetail({}).errors.length > 0);
}

// ─── The log and the view ─────────────────────────────────────────────────────────────────────
{
  let detail = {};
  detail = appendLogLine(detail, '  decide step 3 [personal] — fill');
  detail = appendLogLine(detail, '  human-needed step 8 —  ** YOU: Have you worked with OnlyFans before? → No **');
  eq('lines accumulate', detail.log.length, 2);
  const again = appendLogLine(detail, detail.log[1]);
  eq('a repeated line is not stored twice', again.log.length, 2);

  let bounded = {};
  for (let i = 0; i < MAX_LOG_LINES + 25; i += 1) bounded = appendLogLine(bounded, `line ${i}`);
  eq('the log is bounded', bounded.log.length, MAX_LOG_LINES);
  eq('keeping the newest', bounded.log[bounded.log.length - 1], `line ${MAX_LOG_LINES + 24}`);

  const long = appendLogLine({}, 'x'.repeat(2000));
  ok('one enormous line is capped', long.log[0].length <= 400, long.log[0].length);

  const view = applyRunView({
    id: 'run-1',
    status: 'running',
    detail: { mode: 'fill', answers: GOOD_ANSWERS, log: ['start', '  human-needed step 8 —  ** YOU: Are you 18+? → Yes **'] },
    done_items: 4, ok_items: 4, failed_items: 0, total_items: 21
  });
  eq('the view says what it is doing', view.mode, 'fill');
  eq('and surfaces the prompt on its own', view.prompt.includes('Are you 18+?'), true);
  ok('without echoing the answers back', !JSON.stringify(view.log).includes('saddymalingu@gmail.com'));
  eq('but the page is told which answers it has', view.answersSet.includes('fullName'), true);
  ok('an absent run is null', applyRunView(null) === null);
  ok('active means queued or running', isApplyRunActive({ status: 'queued' }) && isApplyRunActive({ status: 'running' }));
  ok('and finished is not active', !isApplyRunActive({ status: 'succeeded' }));
}


// ─── The routes, over real HTTP, against a fake table ─────────────────────────────────────────
/** Just enough of a Supabase query builder for what `createRunStore` actually calls. */
function fakeTableFactory() {
  const rows = [];
  let seq = 0;
  const matches = (row, filters) => filters.every(([col, value, isIn]) => (
    isIn ? value.map(String).includes(String(row[col])) : String(row[col]) === String(value)
  ));
  return () => {
    const state = { mode: 'select', payload: null, filters: [], limit: null };
    const q = {
      select() { return q; },
      insert(row) { state.mode = 'insert'; state.payload = row; return q; },
      update(patch) { state.mode = 'update'; state.payload = patch; return q; },
      eq(col, value) { state.filters.push([col, value]); return q; },
      in(col, values) { state.filters.push([col, values, true]); return q; },
      order() { return q; },
      limit(n) { state.limit = n; return q; },
      async maybeSingle() {
        const result = await q._run();
        return { data: Array.isArray(result.data) ? (result.data[0] || null) : result.data, error: null };
      },
      then(resolve, reject) { q._run().then(resolve, reject); },
      async _run() {
        if (state.mode === 'insert') {
          seq += 1;
          const row = { id: `run-${seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...state.payload };
          rows.push(row);
          return { data: [row], error: null };
        }
        const hit = rows.filter((row) => matches(row, state.filters));
        if (state.mode === 'update') {
          for (const row of hit) Object.assign(row, state.payload);
          return { data: hit, error: null };
        }
        const sorted = hit.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return { data: state.limit ? sorted.slice(0, state.limit) : sorted, error: null };
      }
    };
    return q;
  };
}


{
  process.env.ADMIN_KEY = 'operator-key';
  process.env.TENANT_DASHBOARD_PASS = 'tenant-key';

  const tenants = {
    'malingu-ventures': { id: 'tenant-a', slug: 'malingu-ventures' },
    'other-tenant': { id: 'tenant-b', slug: 'other-tenant' }
  };
  const app = express();
  app.use(express.json());
  app.use(createApplyPortalRouter({
    root: process.cwd(),
    table: fakeTableFactory(),
    resolveTenant: async (slug) => tenants[slug] || null
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const asTenant = { 'Content-Type': 'application/json', 'x-tenant-key': 'tenant-key' };
  const post = (path, body, headers = asTenant) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  const page = await fetch(`${base}/apply`);
  const pageText = await page.text();
  eq('the page is served', page.status, 200);
  ok('and it is the tenant page', /ChatterApply/.test(pageText) && /id="queue"/.test(pageText));
  ok('with the answers it collects', /id="deskPhoto"/.test(pageText) && /id="hasExperience"/.test(pageText));

  eq('no key is refused', (await fetch(`${base}/api/apply/runs?tenant=malingu-ventures`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })).status, 401);
  eq('a wrong key is refused',
    (await post('/api/apply/runs?tenant=malingu-ventures', {}, { 'Content-Type': 'application/json', 'x-tenant-key': 'nope' })).status, 401);
  eq('a tenant that does not exist is not created',
    (await post('/api/apply/runs?tenant=ghost', { answers: GOOD_ANSWERS })).status, 404);

  const thin = await post('/api/apply/runs?tenant=malingu-ventures', { answers: { fullName: 'David' } });
  eq('an incomplete application is refused', thin.status, 400);
  ok('naming the desk photo before a browser is opened', /deskPhoto/.test((await thin.json()).error));

  const queued = await post('/api/apply/runs?tenant=malingu-ventures', {
    mode: 'fill', waitHumanSeconds: 600, answers: GOOD_ANSWERS
  });
  const queuedBody = await queued.json();
  eq('a complete request is queued', queued.status, 202);
  eq('as a fill run', queuedBody.run.mode, 'fill');
  ok('and the tenant is told what happens next', /worker/.test(queuedBody.note || ''));

  const second = await post('/api/apply/runs?tenant=malingu-ventures', { answers: GOOD_ANSWERS });
  eq('a second run while one is queued is refused', second.status, 409);
  ok('naming the run in the way', Boolean((await second.json()).active?.id));

  const listed = await (await fetch(`${base}/api/apply/runs?tenant=malingu-ventures`, { headers: asTenant })).json();
  eq('the tenant sees their run', listed.runs.length, 1);
  eq('and it is the active one', listed.active.status, 'queued');
  eq('with the answers summarised', listed.active.answersSet.includes('email'), true);
  ok('but the email itself is not echoed back', !JSON.stringify(listed).includes('saddymalingu@gmail.com'));

  const others = await (await fetch(`${base}/api/apply/runs?tenant=other-tenant`, { headers: asTenant })).json();
  eq('another tenant sees nothing of it', others.runs.length, 0);
  eq('and cannot cancel it', (await post(`/api/apply/runs/${listed.active.id}/cancel?tenant=other-tenant`, {})).status, 404);

  const cancelled = await post(`/api/apply/runs/${listed.active.id}/cancel?tenant=malingu-ventures`, {});
  eq('the owner can cancel it', cancelled.status, 200);
  eq('and it ends as cancelled', (await cancelled.json()).run.status, 'cancelled');
  eq('cancelling twice is refused',
    (await post(`/api/apply/runs/${listed.active.id}/cancel?tenant=malingu-ventures`, {})).status, 409);

  eq('and the slot is free again', (await post('/api/apply/runs?tenant=malingu-ventures', { answers: GOOD_ANSWERS })).status, 202);
  eq('the kind is the one this suite assumes', APPLY_KIND, 'apply');

  await new Promise((r) => server.close(r));
}

// ─── What the worker does with a queued run ───────────────────────────────────────────────────
{
  const args = buildApplyChildArgs({
    tenantSlug: 'malingu-ventures',
    answersPath: 'C:/w/.apply-answers-run1.json',
    detail: { waitHumanSeconds: 600, includeTyping: true, typingWpm: 78, open: true }
  });
  ok('the runner is the documented script', args[0].endsWith('browser_actor_chatterapply.mjs'), args[0]);
  eq('the tenant is passed', args.slice(1, 3), ['--tenant', 'malingu-ventures']);
  eq('the answers file is the profile', args.slice(3, 5), ['--profile', 'C:/w/.apply-answers-run1.json']);
  eq('the wait is passed', args.slice(args.indexOf('--wait-human'), args.indexOf('--wait-human') + 2), ['--wait-human', '600']);
  eq('typing is claimed with its speed', args.slice(args.indexOf('--typing-wpm'), args.indexOf('--typing-wpm') + 2), ['--typing-wpm', '78']);
  ok('and the fresh start is honoured', args.includes('--open'));

  const quiet = buildApplyChildArgs({ tenantSlug: 'acme-co', answersPath: 'a.json', detail: {} });
  ok('no wait means no wait flag', !quiet.includes('--wait-human'));
  ok('and typing is not claimed', !quiet.includes('--include-typing'));
  const threw = (fn) => { try { fn(); return null; } catch (error) { return error.message; } };
  ok('a run without a tenant is refused', /tenant/.test(threw(() => buildApplyChildArgs({ answersPath: 'a.json' })) || ''));
  ok('a run without answers is refused', /answers/.test(threw(() => buildApplyChildArgs({ tenantSlug: 'acme-co' })) || ''));

  eq('the answers file is named per run', answersFileName('run-1'), '.apply-answers-run-1.json');
  eq('and a hostile run id cannot escape the folder', answersFileName('../../etc/passwd'), '.apply-answers-etcpasswd.json');
}

{
  // The worker relays what the child prints; the portal stores it as the run's log.
  const prompt = '  human-needed step 2 —  ** YOU: Are you 18+? → Yes (waiting 600s) **';
  ok('a prompt is recognised', classifyApplyLine(prompt).isPrompt);
  ok('an advance is counted as progress', classifyApplyLine('  advance —  "Next →"').advanced);
  ok('a fill is recognised', classifyApplyLine('  fill step 3 —  (+1)').filled);
  ok('an upload too', classifyApplyLine('  upload step 12 —  (1/1 attached)').uploaded);
  ok('a stop is a failure line', classifyApplyLine('Stopped: no_next_button').failed);
  eq('the summary keeps the prompt whole', summarizeApplyLine(prompt).includes('Are you 18+?'), true);
  eq('a blank line has no summary', summarizeApplyLine('   '), null);

  const detail = (await import('../utils/applyRuns.js')).appendLogLine({ mode: 'fill' }, prompt);
  const patch = buildProgressPatch({ message: prompt, detail });
  ok('the progress patch carries the log', Array.isArray(patch.detail.log) && patch.detail.log.length === 1);
  ok('and keeps the latest message too', patch.message.includes('Are you 18+?'));
  ok('a plain progress patch carries no detail', buildProgressPatch({ done: 1 }).detail === undefined);
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
}
console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
