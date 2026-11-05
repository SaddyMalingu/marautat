/**
 * OneForma queue: the demo command (2026-11-05)
 *
 * Reads what the browser read, ranks it, and prints what to do next. Nothing here clicks.
 *
 *   node scripts/oneforma_queue.mjs --from certs.json            # certifications only
 *   node scripts/oneforma_queue.mjs --from snap.json             # {certifications: snap, projects: snap}
 *
 * A snapshot is exactly what `readTableExpr` returns from the certifications panel:
 * `{ ok, url, headers: [...], rows: [[...], ...] }`. So the file can be produced by the
 * worker (`scripts/browser_actor_*.mjs ... --setup-report` prints one) or saved by hand
 * from a page, which is how this is demoed without touching the live account.
 */
import fs from 'fs';
import path from 'path';
import { parseCertifications, parseProjects } from '../utils/browserActor/tasks/oneForma.js';
import { rankOneFormaQueue } from '../utils/oneFormaQueue.js';

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

const from = arg('from', null);
if (!from || from === true) {
  console.error('Usage: node scripts/oneforma_queue.mjs --from <snapshot.json> [--limit 5]');
  process.exit(2);
}

// A saved page or a Windows shell both arrive with a BOM; JSON.parse will not take it.
const raw = JSON.parse(fs.readFileSync(path.resolve(String(from)), 'utf8').replace(/^\uFEFF/, ''));
const certsSnapshot = raw.certifications || raw;
const jobsSnapshot = raw.projects || { ok: false, reason: 'not_captured' };

const certs = parseCertifications(certsSnapshot);
const jobs = parseProjects(jobsSnapshot);
const queue = rankOneFormaQueue({
  certifications: certs.certifications || [],
  projects: jobs.projects || [],
  limit: Number(arg('limit', 5))
});

console.log('\n-- OneForma queue ----------------------------------------------');
console.log(queue.headline);
console.log(`   ${queue.totals.certifications} certification(s), ${queue.totals.projects} project(s), ` +
  `${queue.totals.passed} already passed`);

for (const action of queue.actions) {
  console.log(`\n   [${action.kind}] ${action.title}   (${action.action}, score ${action.score})`);
  for (const reason of action.reasons) console.log('     because: ' + reason);
  for (const step of action.prep) console.log('     - ' + step);
}

if (!certs.ok) console.log(`\n   certifications unreadable: ${certs.reason}`);
if (!jobs.ok) console.log(`   projects not captured: ${jobs.reason}`);
if (queue.skipped.length) {
  console.log('\n   Skipped: ' + queue.skipped.map((s) => `${s.title || '(untitled)'} -> ${s.reason}`).join(', '));
}
console.log('\n   The agent stops before submit. The contributor presses it.\n');
