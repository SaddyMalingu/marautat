/**
 * Apply Console — trigger and watch the ChatterApply run from a page (2026-11-14)
 *
 * Driving the runner meant a terminal, a remembered command line and a log tailed in another window; a tenant
 * on the phone cannot do that. This is the smallest surface that turns "run this script" into "press Start,
 * watch it, stop it". It reuses `scripts/browser_actor_chatterapply.mjs` unchanged — one run path, whoever
 * starts it.
 *
 * Three choices, each from how the last week of runs actually failed:
 *
 *   1. **It never guesses an argument.** Mode, tenant, profile path and numeric bounds are validated here, so a
 *      page cannot ask for a mode that does not exist or a wait of ten hours.
 *   2. **One run at a time.** Two runs on one MoreLogin profile fight over the same tab and the loser reads the
 *      winner's screens — the bug that took a day to find. The second request gets 409, not a queue.
 *   3. **The log is the product.** Every line is kept in a ring buffer and streamed, because the questions this
 *      form asks ("** YOU: Are you 18+? **") are read from that text and the whole value is answering in time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';

/** What the page may ask for. Anything else is a 400, not a silent default. */
export const APPLY_MODES = Object.freeze(['fill', 'map', 'discover', 'dry-run']);

/** Bounds for the numbers the page sends. */
export const WAIT_HUMAN_MAX_SECONDS = 3600;
export const TYPING_WPM_MIN = 20;
export const TYPING_WPM_MAX = 200;
const LOG_RING_LINES = 4000;

/**
 * Build the runner's argv.
 *
 * Pure, so the page's options are tested without spawning anything. A waiting run is headful by construction
 * in the script itself: nobody answers a question on a window they cannot see.
 */
export function buildApplyArgs({
  tenant,
  mode = 'fill',
  profile = null,
  envId = null,
  waitHumanSeconds = 0,
  includeTyping = false,
  typingWpm = 70,
  open = false,
  url = null,
  out = null,
  close = false
} = {}) {
  if (!tenant || !/^[a-z0-9][a-z0-9-]{1,60}$/i.test(String(tenant))) {
    throw new Error('tenant must be a slug like malingu-ventures');
  }
  if (!APPLY_MODES.includes(mode)) throw new Error(`mode must be one of ${APPLY_MODES.join(', ')}`);
  const wait = Math.max(0, Math.min(WAIT_HUMAN_MAX_SECONDS, Number(waitHumanSeconds) || 0));
  const wpm = Math.max(TYPING_WPM_MIN, Math.min(TYPING_WPM_MAX, Number(typingWpm) || 70));

  const args = [path.join('scripts', 'browser_actor_chatterapply.mjs'), '--tenant', String(tenant)];
  if (profile) args.push('--profile', String(profile));
  if (envId) args.push('--env-id', String(envId));
  if (mode === 'map') args.push('--map');
  else if (mode === 'discover') args.push('--discover');
  else if (mode === 'dry-run') args.push('--dry-run');
  if (open) args.push('--open');
  if (close) args.push('--close');
  if (url) args.push('--url', String(url));
  if (wait > 0) args.push('--wait-human', String(wait));
  if (includeTyping) args.push('--include-typing', '--typing-wpm', String(wpm));
  if (out) args.push('--out', String(out));
  return args;
}


/**
 * The run registry: at most one live run, a ring buffer of its output, and an honest end state.
 *
 * `spawnRun` is injectable so tests drive it with a fake child and no browser.
 */
export function createRunRegistry({ spawnRun, now = () => Date.now(), ringLines = LOG_RING_LINES } = {}) {
  if (typeof spawnRun !== 'function') throw new TypeError('createRunRegistry needs a spawnRun() function');
  const runs = new Map();
  let activeId = null;

  const push = (run, line) => {
    run.lines.push(line);
    if (run.lines.length > ringLines) run.lines.splice(0, run.lines.length - ringLines);
    for (const send of run.listeners) {
      try { send(line); } catch { /* a closed stream must not stop the run */ }
    }
  };

  const summary = (run) => ({
    id: run.id, status: run.status, mode: run.mode, tenant: run.tenant,
    startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.exitCode,
    args: run.args, logPath: run.logPath, lines: run.lines.slice(-400)
  });

  return {
    get active() { return activeId; },
    list() {
      return [...runs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((r) => ({
          id: r.id, status: r.status, mode: r.mode, tenant: r.tenant,
          startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode, lines: r.lines.length
        }));
    },
    get(id) {
      const run = runs.get(id);
      return run ? summary(run) : null;
    },
    start({ mode, tenant, args, logPath }) {
      if (activeId) return { refused: 'run_in_progress', activeId };
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const run = {
        id, mode, tenant, args, logPath, status: 'running',
        startedAt: now(), endedAt: null, exitCode: null,
        lines: [], listeners: new Set(), child: null
      };
      runs.set(id, run);
      activeId = id;

      const finish = (code, signal) => {
        if (run.status === 'done' || run.status === 'failed' || run.status === 'stopped') return;
        run.status = signal || run.status === 'stopping' ? 'stopped' : (code === 0 ? 'done' : 'failed');
        run.exitCode = code ?? null;
        run.endedAt = now();
        if (activeId === id) activeId = null;
        push(run, `— run ${run.status} (exit ${code ?? 'n/a'}${signal ? `, ${signal}` : ''}) —`);
        for (const send of run.listeners) { try { send(null); } catch { /* closed */ } }
        run.listeners.clear();
      };

      let child;
      try {
        child = spawnRun({ args, logPath, onLine: (line) => push(run, line) });
      } catch (error) {
        push(run, `failed to start: ${error.message}`);
        finish(1, null);
        return { run: summary(run) };
      }
      run.child = child;
      if (child && typeof child.on === 'function') {
        child.on('exit', finish);
        child.on('error', (error) => { push(run, `process error: ${error.message}`); finish(1, null); });
      }
      return { run: summary(run) };
    },
    subscribe(id, send) {
      const run = runs.get(id);
      if (!run) return null;
      run.listeners.add(send);
      return () => run.listeners.delete(send);
    },
    stop(id) {
      const run = runs.get(id);
      if (!run) return { ok: false, reason: 'not_found' };
      if (run.status !== 'running') return { ok: false, reason: 'not_running' };
      run.status = 'stopping';
      push(run, '— stop requested —');
      // A browser driver has grandchildren (the browser); on Windows a gentle signal does not reach them.
      try {
        if (process.platform === 'win32' && run.child?.pid) {
          spawn('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          run.child?.kill('SIGTERM');
        }
      } catch { /* the exit handler still records the end */ }
      return { ok: true };
    }
  };
}

/** The child process the registry really uses: its own log file, both streams into the ring. */
export function defaultSpawnRun({ cwd = process.cwd() } = {}) {
  return ({ args, logPath, onLine }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const read = (chunk) => {
      const text = String(chunk);
      try { fs.writeSync(log, text); } catch { /* a full disk must not hide the run */ }
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('exit', () => { try { fs.closeSync(log); } catch { /* already closed */ } });
    return child;
  };
}

/**
 * The router. Fail-closed on the admin key exactly like the other admin surfaces: an unset key never accepts.
 */
export function createApplyConsoleRouter({
  root = process.cwd(),
  registry = null,
  spawnRun = null,
  pageDir = path.join(root, 'admin')
} = {}) {
  const runs = registry || createRunRegistry({ spawnRun: spawnRun || defaultSpawnRun({ cwd: root }) });
  const router = express.Router();

  const keyOk = (req) => {
    const supplied = req.get('x-admin-key') || req.query.key;
    const accepted = [process.env.ADMIN_KEY, process.env.ADMIN_PASS].filter(Boolean);
    return Boolean(supplied) && accepted.length > 0 && accepted.includes(String(supplied));
  };
  const guard = (req, res, next) => (keyOk(req) ? next() : res.status(401).json({ error: 'Unauthorized' }));

  // The page itself holds no data, so it is served without a key; every call it makes needs one.
  router.get('/admin/apply', (req, res) => res.sendFile(path.join(pageDir, 'apply_console.html')));

  router.get('/admin/apply/runs', guard, (req, res) => res.json({ runs: runs.list(), active: runs.active }));

  router.post('/admin/apply/runs', guard, (req, res) => {
    const body = req.body || {};
    let args;
    try {
      args = buildApplyArgs(body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const logPath = path.join(root, 'tmp_chatterapply', `console-${Date.now().toString(36)}.log`);
    const started = runs.start({ mode: body.mode || 'fill', tenant: String(body.tenant), args, logPath });
    if (started.refused) {
      return res.status(409).json({ error: 'a run is already in progress', activeId: started.activeId });
    }
    return res.status(202).json({ run: started.run, logPath });
  });

  router.get('/admin/apply/runs/:id', guard, (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'no such run' });
    return res.json({ run });
  });

  // Server-sent events: the log as it happens, so a prompt is visible the second the runner asks it.
  router.get('/admin/apply/runs/:id/stream', guard, (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'no such run' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: tail\ndata: ${JSON.stringify(run.lines.slice(-200))}\n\n`);
    if (run.status !== 'running') {
      res.write('event: end\ndata: {}\n\n');
      return res.end();
    }
    const stop = runs.subscribe(req.params.id, (line) => {
      if (line === null) { res.write('event: end\ndata: {}\n\n'); return res.end(); }
      res.write(`data: ${JSON.stringify(line)}\n\n`);
      return undefined;
    });
    if (!stop) return res.end();
    req.on('close', () => stop());
    return undefined;
  });

  router.post('/admin/apply/runs/:id/stop', guard, (req, res) => {
    const result = runs.stop(req.params.id);
    if (result.reason === 'not_found') return res.status(404).json(result);
    if (result.reason === 'not_running') return res.status(409).json(result);
    return res.json(result);
  });

  return router;
}

export default createApplyConsoleRouter;
