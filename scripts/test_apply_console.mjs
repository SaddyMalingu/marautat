/**
 * Apply Console: the page, the args it may ask for, and the run registry (2026-11-14)
 *
 * No browser and no network: the registry takes an injected spawn, so the lifecycle (one run at a time, log
 * ring, honest end state, stop) is tested against a fake child. What the page can ask for is tested as data.
 *
 * Run: node scripts/test_apply_console.mjs
 */
import { EventEmitter } from 'node:events';
import {
  APPLY_MODES,
  WAIT_HUMAN_MAX_SECONDS,
  TYPING_WPM_MIN,
  TYPING_WPM_MAX,
  buildApplyArgs,
  createRunRegistry
} from '../routes/applyConsole.js';

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

// ─── What the page may ask for ────────────────────────────────────────────────────────────────
{
  const args = buildApplyArgs({ tenant: 'malingu-ventures' });
  ok('the runner is the tested one', args[0].endsWith('browser_actor_chatterapply.mjs'), args[0]);
  eq('the tenant is passed through', args.slice(1, 3), ['--tenant', 'malingu-ventures']);
  ok('fill mode asks for no mode flag', !args.includes('--map') && !args.includes('--dry-run'));

  const map = buildApplyArgs({ tenant: 'acme-co', mode: 'map' });
  ok('map mode asks for a map', map.includes('--map'));
  ok('and discover asks for discover', buildApplyArgs({ tenant: 'acme-co', mode: 'discover' }).includes('--discover'));
  ok('and dry-run asks for a dry run', buildApplyArgs({ tenant: 'acme-co', mode: 'dry-run' }).includes('--dry-run'));

  const waited = buildApplyArgs({ tenant: 'acme-co', waitHumanSeconds: 300, includeTyping: true, typingWpm: 78, open: true });
  eq('the wait is passed in seconds', waited.slice(waited.indexOf('--wait-human'), waited.indexOf('--wait-human') + 2), ['--wait-human', '300']);
  eq('typing carries its speed', waited.slice(waited.indexOf('--typing-wpm'), waited.indexOf('--typing-wpm') + 2), ['--typing-wpm', '78']);
  ok('and open is honoured', waited.includes('--open'));
  ok('without typing there is no typing flag', !buildApplyArgs({ tenant: 'acme-co' }).includes('--include-typing'));
}

{
  // Bounds: a page must not be able to ask for a ten-hour wait or a 900 WPM typist.
  const huge = buildApplyArgs({ tenant: 'acme-co', waitHumanSeconds: 99999, includeTyping: true, typingWpm: 900 });
  eq('the wait is clamped', huge[huge.indexOf('--wait-human') + 1], String(WAIT_HUMAN_MAX_SECONDS));
  eq('the speed is clamped', huge[huge.indexOf('--typing-wpm') + 1], String(TYPING_WPM_MAX));
  const tiny = buildApplyArgs({ tenant: 'acme-co', includeTyping: true, typingWpm: 1 });
  eq('and a too-slow typist is raised to the floor', tiny[tiny.indexOf('--typing-wpm') + 1], String(TYPING_WPM_MIN));
  ok('a negative wait becomes no wait', !buildApplyArgs({ tenant: 'acme-co', waitHumanSeconds: -5 }).includes('--wait-human'));
}

{
  // Refusals are explicit: a bad tenant or an invented mode must not become a default.
  const threw = (fn) => { try { fn(); return null; } catch (error) { return error.message; } };
  ok('a tenant is required', /tenant/.test(threw(() => buildApplyArgs({})) || ''));
  ok('a slug tenant is required', /tenant/.test(threw(() => buildApplyArgs({ tenant: 'not a slug!' })) || ''));
  ok('an unknown mode is refused', /mode must be one of/.test(threw(() => buildApplyArgs({ tenant: 'acme-co', mode: 'submit' })) || ''));
  eq('every advertised mode is accepted', APPLY_MODES.filter((mode) => !threw(() => buildApplyArgs({ tenant: 'acme-co', mode }))).length, APPLY_MODES.length);
}


// ─── The registry: one run at a time, a log that survives, an honest end ─────────────────────
const fakeChild = () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.kill = () => { child.killed = true; };
  return child;
};

{
  const children = [];
  const registry = createRunRegistry({
    spawnRun: ({ onLine }) => {
      const child = fakeChild();
      children.push({ child, onLine });
      return child;
    }
  });

  const first = registry.start({ mode: 'fill', tenant: 'malingu-ventures', args: ['x'], logPath: 'tmp/a.log' });
  ok('a run starts', Boolean(first.run?.id), JSON.stringify(first));
  eq('and is running', first.run.status, 'running');
  eq('and is the active run', registry.active, first.run.id);

  const second = registry.start({ mode: 'fill', tenant: 'malingu-ventures', args: ['x'], logPath: 'tmp/b.log' });
  eq('a second run is refused, not queued', second.refused, 'run_in_progress');
  eq('naming the run that is in the way', second.activeId, first.run.id);

  children[0].onLine('  human-needed step 2 —  ** YOU: Are you 18+? → Yes (waiting 600s) **');
  children[0].onLine('  human-answered step 2 —  (you answered, 4s)');
  const seen = registry.get(first.run.id);
  ok('the log is kept', seen.lines.some((l) => /\*\* YOU:/.test(l)), seen.lines.length);
  ok('and answered lines too', seen.lines.some((l) => /human-answered/.test(l)));

  const streamed = [];
  let ended = false;
  registry.subscribe(first.run.id, (line) => { if (line === null) ended = true; else streamed.push(line); });
  children[0].onLine('  decide step 15 [english_test] — handoff');
  eq('a subscriber receives new lines', streamed.length, 1);
  ok('and has not been told the run ended', !ended);

  children[0].child.emit('exit', 0, null);
  eq('the run ends as done', registry.get(first.run.id).status, 'done');
  eq('with its exit code', registry.get(first.run.id).exitCode, 0);
  ok('and the subscriber is closed out', ended);
  eq('and nothing is active', registry.active, null);

  const third = registry.start({ mode: 'map', tenant: 'malingu-ventures', args: ['x'], logPath: 'tmp/c.log' });
  ok('a new run is allowed once the first ends', Boolean(third.run?.id));
}

{
  // A non-zero exit is a failure, and a stop is recorded as a stop — not as either of those.
  const children = [];
  const registry = createRunRegistry({
    spawnRun: () => { const child = fakeChild(); children.push(child); return child; }
  });
  const failed = registry.start({ mode: 'fill', tenant: 'acme-co', args: [], logPath: 'tmp/d.log' });
  children[0].emit('exit', 1, null);
  eq('a bad exit is a failure', registry.get(failed.run.id).status, 'failed');

  const stopped = registry.start({ mode: 'fill', tenant: 'acme-co', args: [], logPath: 'tmp/e.log' });
  ok('stop is accepted for a live run', registry.stop(stopped.run.id).ok);
  children[1].emit('exit', null, 'SIGTERM');
  eq('and recorded as stopped, not failed', registry.get(stopped.run.id).status, 'stopped');
  eq('stopping an unknown run is honest', registry.stop('nope').reason, 'not_found');
  eq('and a finished run cannot be stopped again', registry.stop(stopped.run.id).reason, 'not_running');
}

{
  // A spawn that throws must leave the registry usable, with the failure in the log.
  const registry = createRunRegistry({ spawnRun: () => { throw new Error('no node here'); } });
  const broken = registry.start({ mode: 'fill', tenant: 'acme-co', args: [], logPath: 'tmp/f.log' });
  eq('a failed spawn is a failed run', registry.get(broken.run.id).status, 'failed');
  ok('with the reason in its log', registry.get(broken.run.id).lines.some((l) => /no node here/.test(l)));
  eq('and the slot is free again', registry.active, null);
}

{
  // The ring is bounded: a long run must not grow the server's memory with its own log.
  const registry = createRunRegistry({
    ringLines: 3,
    spawnRun: ({ onLine }) => {
      const child = fakeChild();
      queueMicrotask(() => [1, 2, 3, 4, 5].forEach((n) => onLine(`line ${n}`)));
      return child;
    }
  });
  const run = registry.start({ mode: 'fill', tenant: 'acme-co', args: [], logPath: 'tmp/g.log' });
  await new Promise((r) => setTimeout(r, 10));
  eq('only the last lines are kept', registry.get(run.run.id).lines, ['line 3', 'line 4', 'line 5']);
}

// ─── The router over real HTTP: the page, the key, the refusal, the stream, the stop ─────────
{
  const express = (await import('express')).default;
  const { createApplyConsoleRouter } = await import('../routes/applyConsole.js');
  const http = await import('node:http');
  const { EventEmitter } = await import('node:events');

  process.env.ADMIN_KEY = 'test-admin-key';

  const children = [];
  const registry = createRunRegistry({
    spawnRun: ({ onLine }) => {
      const child = new EventEmitter();
      child.pid = 999001;
      children.push({ child, onLine });
      return child;
    }
  });

  const app = express();
  app.use(express.json());
  app.use(createApplyConsoleRouter({ root: process.cwd(), registry }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = { 'x-admin-key': 'test-admin-key' };

  const page = await fetch(`${base}/admin/apply`);
  const pageText = await page.text();
  eq('the page is served', page.status, 200);
  ok('and it is the console', /Apply Console/.test(pageText) && /id="start"/.test(pageText));
  ok('with a stop control too', /id="stop"/.test(pageText));

  eq('without a key the list is refused', (await fetch(`${base}/admin/apply/runs`)).status, 401);
  eq('and starting is refused', (await fetch(`${base}/admin/apply/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant: 'acme-co' })
  })).status, 401);

  const badMode = await fetch(`${base}/admin/apply/runs`, {
    method: 'POST', headers: { ...key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: 'acme-co', mode: 'submit-the-form' })
  });
  eq('an invented mode is a 400', badMode.status, 400);
  ok('naming the modes that exist', /mode must be one of/.test((await badMode.json()).error));

  const started = await fetch(`${base}/admin/apply/runs`, {
    method: 'POST', headers: { ...key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: 'malingu-ventures', mode: 'fill', waitHumanSeconds: 120, includeTyping: true, typingWpm: 78 })
  });
  const startedBody = await started.json();
  eq('a good request is accepted', started.status, 202);
  ok('with a run id', Boolean(startedBody.run?.id), JSON.stringify(startedBody));
  ok('and the args are the tested runner’s', Array.isArray(startedBody.run.args) && startedBody.run.args.includes('--wait-human'));

  const again = await fetch(`${base}/admin/apply/runs`, {
    method: 'POST', headers: { ...key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: 'malingu-ventures' })
  });
  eq('a second run while one is live is a 409', again.status, 409);

  // The stream must deliver the buffered tail and then live lines.
  const controller = new AbortController();
  const streamRes = await fetch(`${base}/admin/apply/runs/${startedBody.run.id}/stream?key=test-admin-key`, { signal: controller.signal });
  eq('the stream opens', streamRes.status, 200);
  eq('as server-sent events', streamRes.headers.get('content-type'), 'text/event-stream');
  children[0].onLine('  human-needed step 2 —  ** YOU: Are you 18+? → Yes (waiting 120s) **');
  const reader = streamRes.body.getReader();
  let chunk = '';
  const readUntil = async (needle) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !chunk.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      chunk += new TextDecoder().decode(value);
    }
    return chunk.includes(needle);
  };
  ok('the prompt reaches the page', await readUntil('human-needed'), chunk.slice(0, 300));
  controller.abort();

  const stopRes = await fetch(`${base}/admin/apply/runs/${startedBody.run.id}/stop`, { method: 'POST', headers: key });
  eq('stop is accepted', stopRes.status, 200);
  eq('stopping an unknown run is a 404', (await fetch(`${base}/admin/apply/runs/nope/stop`, { method: 'POST', headers: key })).status, 404);

  const listed = await (await fetch(`${base}/admin/apply/runs`, { headers: key })).json();
  eq('the run list shows it', listed.runs.length, 1);
  eq('marking it as the active one', listed.active, startedBody.run.id);

  await new Promise((r) => server.close(r));
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
}
console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
