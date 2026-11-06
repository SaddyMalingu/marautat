/**
 * Watch the live blog grow (2026-11-06)
 *
 *   node scripts/watch_blog_growth.mjs                 # 20 minutes, poll every 60s
 *   node scripts/watch_blog_growth.mjs --minutes 40 --interval 30
 *
 * For testing a scheduled run without staring at two dashboards. It reads the public sitemap,
 * counts the blog URLs, and reports the moment the number changes — which is the only signal
 * that matters, because the sitemap is rebuilt from `blog_posts` and therefore never moves
 * unless pages were actually written.
 *
 * Prints the new slugs, so a run that wrote nine pages for the wrong offer is visible too.
 */
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const at = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at === -1) return fallback;
  const token = argv[at];
  if (token.includes('=')) return token.slice(token.indexOf('=') + 1);
  const next = argv[at + 1];
  if (next === undefined || String(next).startsWith('--')) return true;
  return next;
}

const SITE = String(arg('site', process.env.SITE_URL || 'https://alphadome.onrender.com')).replace(/\/$/, '');
const minutes = Number(arg('minutes', 20));
const intervalSec = Math.max(10, Number(arg('interval', 60)));
const deadline = Date.now() + minutes * 60000;

async function slugs() {
  const response = await fetch(SITE + '/sitemap.xml');
  if (!response.ok) throw new Error('sitemap HTTP ' + response.status);
  const xml = await response.text();
  return new Set([...xml.matchAll(/\/blog\/([a-z0-9-]+)\.html/g)].map((m) => m[1]));
}

const stamp = () => new Date().toISOString().slice(11, 19);

let baseline;
try {
  baseline = await slugs();
} catch (error) {
  console.error(`${stamp()} could not read the sitemap: ${error.message}`);
  process.exit(2);
}

console.log(`${stamp()} baseline: ${baseline.size} blog URLs`);
console.log(`watching ${SITE} for ${minutes} min, every ${intervalSec}s — Ctrl+C to stop\n`);

let ticks = 0;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
  ticks += 1;
  let now;
  try {
    now = await slugs();
  } catch (error) {
    console.log(`${stamp()} poll ${ticks}: ${error.message}`);
    continue;
  }
  const added = [...now].filter((s) => !baseline.has(s));
  const removed = [...baseline].filter((s) => !now.has(s));
  if (!added.length && !removed.length) {
    console.log(`${stamp()} poll ${ticks}: still ${now.size}`);
    continue;
  }
  console.log(`${stamp()} CHANGE: ${baseline.size} -> ${now.size} (+${added.length}, -${removed.length})`);
  for (const slug of added.slice(0, 20)) console.log('  + ' + slug);
  if (added.length > 20) console.log(`  … and ${added.length - 20} more`);
  for (const slug of removed.slice(0, 10)) console.log('  - ' + slug);
  // One change is the answer to "did the run work"; keep watching would just report noise.
  process.exit(0);
}

console.log(`\n${stamp()} no change after ${minutes} min (still ${baseline.size}).`);
console.log('Nothing was written. Check, in this order:');
console.log('  1. GitHub → Actions → was there a run in this window at all? (the scheduler can lag hours)');
console.log('  2. That run\'s "Trigger the Render Workflow" step — 404 means the task slug is wrong,');
console.log('     401 means the key is bad, "Nothing to do" means the secret is missing.');
console.log('  3. Render → alphadome-blog → Runs — did a task run start?');
console.log('  4. That run\'s result: planned 0 means no offer was eligible (all covered).');
process.exit(1);
