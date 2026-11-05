/**
 * Trigger the blog queue workflow (2026-11-05)
 *
 *   $env:RENDER_API_KEY = 'rnd_...'          # PowerShell
 *   node scripts/trigger_blog_queue.mjs
 *   node scripts/trigger_blog_queue.mjs --limit 3 --wait
 *
 * Exists because the obvious `curl -X POST` does not work on Windows: PowerShell aliases
 * `curl` to Invoke-WebRequest, which rejects `-X` and mangles the JSON body. A five-line Node
 * script behaves the same on every machine and can poll the run afterwards.
 *
 * The task slug is `<workflow-slug>/<task-name>`. Ours is `alphadome-blog/blogQueue` — the
 * workflow was created as `alphadome-blog` (service wfl-dbm4ea56e07s73b49qn0). Override with
 * `--task` or the BLOG_WORKFLOW_TASK environment variable if it is ever renamed. A wrong slug
 * answers 404, which reads like an auth problem but is not.
 */
const API = 'https://api.render.com/v1';

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const at = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at === -1) return fallback;
  const token = argv[at];
  if (token.includes('=')) return token.slice(token.indexOf('=') + 1);
  const next = argv[at + 1];
  if (next === undefined || String(next).startsWith('--')) return true;
  return next;
}

const key = process.env.RENDER_API_KEY;
const task = String(arg('task', process.env.BLOG_WORKFLOW_TASK || 'alphadome-blog/blogQueue'));
const limit = Number(arg('limit', 3));
const wait = Boolean(arg('wait', false));

if (!key) {
  console.error('RENDER_API_KEY is not set. Create one at https://dashboard.render.com/u/settings#api-keys');
  console.error('PowerShell:  $env:RENDER_API_KEY = \'rnd_...\'');
  console.error('bash:        export RENDER_API_KEY=rnd_...');
  process.exit(2);
}

async function call(path, init = {}) {
  const response = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch (e) { /* keep the text */ }
  return { ok: response.ok, status: response.status, json, body };
}

const started = await call('/task-runs', {
  method: 'POST',
  // `input` is always an array of positional arguments: the queue's options object is one element.
  body: JSON.stringify({ task, input: [{ limit }] })
});

if (!started.ok) {
  console.error(`Trigger failed: ${started.status}`);
  console.error(started.body.slice(0, 800));
  if (started.status === 404) {
    console.error('\n404 = the task slug does not match the deployed workflow.');
    console.error('Check Workflow Slug in the dashboard, or pass --task <slug>/blogQueue.');
  }
  if (started.status === 401 || started.status === 403) {
    console.error('\n401/403 = the key is wrong, revoked, or lacks access to this workspace.');
  }
  process.exit(1);
}

const run = started.json || {};
const runId = run.id || run.taskRun?.id || null;
console.log(`Triggered ${task} with limit=${limit}`);
console.log(`  run id : ${runId || '(not returned — check the dashboard)'}`);
console.log(`  status : ${run.status || run.taskRun?.status || 'unknown'}`);

if (!wait || !runId) {
  console.log('\nWatch it in the dashboard: Workflows → alphadome-blog → Runs.');
  console.log('A healthy run shows 1 parent + one chained child per planned offer.');
  process.exit(0);
}

// Poll until the run reaches a terminal state. The endpoint is the documented one; if a host
// answers 404 for it we say so and stop rather than polling forever.
const terminal = new Set(['succeeded', 'failed', 'canceled', 'cancelled']);
for (let attempt = 1; attempt <= 60; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 10000));
  const poll = await call('/task-runs/' + encodeURIComponent(runId));
  if (poll.status === 404) {
    console.log('\nThis workspace does not expose the run-polling endpoint; watch the dashboard instead.');
    process.exit(0);
  }
  if (!poll.ok) { console.log(`  poll ${attempt}: HTTP ${poll.status}`); continue; }
  const status = poll.json?.status || poll.json?.taskRun?.status;
  console.log(`  poll ${attempt}: ${status}`);
  if (terminal.has(String(status))) {
    const result = poll.json?.results || poll.json?.taskRun?.results || null;
    if (result) console.log('\nResult:\n' + JSON.stringify(result, null, 2));
    process.exit(String(status) === 'succeeded' ? 0 : 1);
  }
}

console.error('\nStill running after 10 minutes; check the dashboard.');
process.exit(1);
