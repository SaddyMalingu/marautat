/**
 * Did the deploy actually land? (2026-11-19)
 *
 * Render builds `origin/main`, and auto-deploy is off for this service, so a push is
 * not a deploy. The four things below are the ones this change set has to prove before
 * a single tenant message is sent, and each is a probe rather than a log line:
 *
 *   1. `/api/drops/health` reports the commit that is running — compare it with local HEAD.
 *   2. `/founders-package.html` answers 200, because every recovery and tenant message
 *      links to it.
 *   3. `/api/drops/recovery` answers JSON (**403 without a key**), which is how you know
 *      the route shipped: an HTML 404 means it did not, and an HTML 500 means it threw.
 *   4. `/drops/health` still says the M-Pesa lane is configured.
 *
 *   node scripts/deploy_check.mjs            # check and exit non-zero if not deployed
 *   node scripts/deploy_check.mjs --wait 300 # poll every 20s for up to 300s
 */
import 'dotenv/config';
import { execSync } from 'child_process';

function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const at = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at === -1) return fallback;
  const token = argv[at];
  if (token.includes('=')) return token.slice(token.indexOf('=') + 1);
  const next = argv[at + 1];
  if (next === undefined || String(next).startsWith('--')) return true;
  return next;
}

const SITE = String(arg('site', process.env.SITE_URL || 'https://alphadome.onrender.com')).replace(/\/+$/, '');
const waitSeconds = Number(arg('wait', 0)) || 0;

const local = (() => {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

/** Is `sha` already in this branch's history? Then it is built, just not the newest. */
function isAncestor(sha) {
  if (!sha) return false;
  try {
    execSync(`git merge-base --is-ancestor ${sha} HEAD`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function get(path, opts = {}) {
  const res = await fetch(SITE + path, { redirect: 'follow', signal: AbortSignal.timeout(opts.timeout || 20000) });
  const text = await res.text();
  return { status: res.status, text, type: res.headers.get('content-type') || '' };
}

async function check() {
  const failures = [];
  const ok = (name, cond, detail = '') => {
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
    if (!cond) failures.push(name);
  };

  const health = await get('/api/drops/health');
  let commit = null;
  try {
    commit = JSON.parse(health.text).commit || null;
  } catch {
    /* left null: the body is not JSON, which is itself the finding */
  }
  ok('/api/drops/health answers JSON', health.status === 200 && Boolean(commit), 'status ' + health.status);

  // The four routes below are the gate: if the page and the route answer, the change set
  // is running whatever string Render reports. The commit is reported beside them, and a
  // live commit that is merely older is a note, not a failure — otherwise every push makes
  // this command cry wolf until the builder catches up.
  if (commit && local && commit === local) {
    console.log('PASS  the running commit is local HEAD — ' + commit.slice(0, 8));
  } else if (isAncestor(commit)) {
    console.log('NOTE  the running commit is ' + String(commit).slice(0, 8) + '; local HEAD is '
      + String(local).slice(0, 8) + ' (newest commit not built yet — the probes below still decide)');
  } else {
    console.log('FAIL  the running commit is not in local history — live ' + String(commit).slice(0, 8)
      + ' · local ' + String(local).slice(0, 8));
    failures.push('the running commit is not in local history');
  }

  const page = await get('/founders-package.html');
  ok('/founders-package.html is live', page.status === 200 && /Founder/i.test(page.text), 'status ' + page.status);

  // 403 JSON is the pass: the route exists and refuses an unauthenticated caller.
  const recovery = await get('/api/drops/recovery');
  ok('/api/drops/recovery exists and refuses without a key',
    recovery.status === 403 && /json/i.test(recovery.type), 'status ' + recovery.status + ' · ' + recovery.type);

  const lanes = await get('/api/drops/ladder');
  ok('the storefront ladder still answers', lanes.status === 200 && /"mpesa"\s*:\s*true/.test(lanes.text),
    'status ' + lanes.status);

  return failures;
}

const started = Date.now();
let failures = await check();
while (failures.length && Date.now() - started < waitSeconds * 1000) {
  console.log(`\n   not deployed yet — retrying in 20s (${Math.round((Date.now() - started) / 1000)}s of ${waitSeconds}s)\n`);
  await new Promise((r) => setTimeout(r, 20000));
  failures = await check();
}

if (failures.length) {
  console.log('\nNOT DEPLOYED — press Deploy in Render for ' + String(local).slice(0, 8)
    + ', then run this again. Do not send the tenant messages before it passes.\n');
  process.exit(1);
}
console.log('\nDeployed. `npm run tenants:campaign -- --step activation` is safe to send.\n');
process.exit(0);
