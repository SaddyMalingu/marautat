/**
 * Blog queue runner (2026-11-05)
 *
 * The decision lives in `utils/blogQueue.js`; this only feeds it and acts on the answer.
 * Two modes, because the two callers are different:
 *
 *   - `--from plan.json` reads offers and pages from a file. No database, no keys, no
 *     network — which is how the queue can be demonstrated and regressed on a laptop,
 *     and how a sandbox can be handed a frozen slice of reality.
 *   - default reads Supabase with the service-role key, then `--apply` walks the plan and
 *     calls the existing generator once per offer (`generateBlogPostsForOpportunity`).
 *     Nothing is generated without `--apply`; the default is a plan you can read first,
 *     matching `browser_actor_import.mjs`.
 *
 * It is deliberately sequential. The generator already holds a per-offer lock and the AI
 * tier is rate-limited per minute, so two offers in parallel would only throttle each
 * other — and the tenant's job would take longer than doing them one at a time.
 */
import fs from 'fs';
import path from 'path';
import { planBlogQueue } from '../utils/blogQueue.js';
import { requireSupabaseEnv } from '../utils/supabaseEnv.js';
import { withCause } from '../utils/fetchCause.js';

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const at = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at === -1) return fallback;
  const token = argv[at];
  if (token.includes('=')) return token.slice(token.indexOf('=') + 1);
  // `--from plan.json` is the form people actually type; treating a bare flag as
  // `true` turned the file path into the string "true" and opened `.../true`.
  const next = argv[at + 1];
  if (next === undefined || String(next).startsWith('--')) return true;
  return next;
}

const limit = Number(arg('limit', 5));
const budgetMs = Number(arg('budget-ms', process.env.BLOG_QUEUE_BUDGET_MS || 0));
const perOfferMs = Number(arg('per-offer-ms', process.env.BLOG_RUN_BUDGET_MS || 90000));
const apply = Boolean(arg('apply', false));
const from = arg('from', null);

async function load() {
  if (from) {
    // Windows shells write a UTF-8 BOM by default (`Out-File -Encoding utf8`), and
    // JSON.parse rejects it with a character nobody can see in the error message.
    const raw = JSON.parse(fs.readFileSync(path.resolve(String(from)), 'utf8').replace(/^\uFEFF/, ''));
    return { offers: raw.offers || [], posts: raw.posts || [], tenant: raw.tenant || null };
  }
  // Checked before the client is built, so a misconfigured service says which variable is wrong
  // instead of failing at the socket with "fetch failed" (2026-11-13, the Render cron job).
  const { url, key } = requireSupabaseEnv();
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(url, key);
  const tenantId = arg('tenant', process.env.BLOG_QUEUE_TENANT_ID || null);
  let offersQuery = sb.from('opportunities')
    .select('id, title, slug, status, referral_url, compensation_max, description, deleted_at, tenant_id, source:opportunity_sources(slug)')
    .is('deleted_at', null);
  if (tenantId) offersQuery = offersQuery.eq('tenant_id', tenantId);
  // `withCause` matters here: supabase-js turns a transport failure into `TypeError: fetch failed`
  // and hides the reason on `error.cause`. Without it a Render log says nothing at all, which is
  // exactly what happened on 2026-11-13.
  const { data: offers, error } = await withCause(() => offersQuery, 'reading offers');
  if (error) throw new Error('reading offers: ' + error.message);
  const ids = (offers || []).map((o) => o.id);
  let posts = [];
  if (ids.length) {
    const { data, error: postErr } = await withCause(
      () => sb.from('blog_posts').select('opportunity_id, slug, status').in('opportunity_id', ids),
      'reading blog_posts'
    );
    // A host without `opportunity_id` on blog_posts cannot report coverage; that is
    // unknown, not "every offer is unwritten", so say so rather than queue everything.
    if (postErr) {
      throw new Error('reading blog_posts: ' + postErr.message +
        ' — coverage is unknown, refusing to plan' +
        // The schema-cache message means the table/column is missing, which is a migration
        // problem; anything else here is the connection the guard above should have caught.
        (/schema cache|does not exist/i.test(postErr.message)
          ? ' (apply the migrations in migrations/ — blog_posts.opportunity_id is missing)'
          : ' (the request reached Supabase and was refused, so the URL is right and the key or the network is not)'));
    }
    posts = data || [];
  }
  return { offers: offers || [], posts, tenant: tenantId };
}

const { offers, posts } = await load();
const plan = planBlogQueue({ offers, posts, limit, budgetMs, perOfferMs });

console.log('\n-- Blog queue ------------------------------------------------------');
console.log(plan.summary);
for (const run of plan.runs) {
  console.log(`  > ${run.title}  [${run.status}]  ${run.livePages}/${run.livePages + run.missing} pages` +
    `  |  ${run.ready ? 'earns' : 'NO LINK'}  |  ${run.source || 'no source'}`);
  for (const reason of run.reasons) console.log('      ' + reason);
}
if (plan.needsLink.length) {
  console.log(`\n  ${plan.needsLink.length} queued offer(s) have no referral link - the pages will not earn until one is added:`);
  for (const title of plan.needsLink) console.log('    - ' + title);
}
if (plan.skipped.length) {
  console.log('\n  Skipped: ' + plan.skipped.map((s) => `${s.title || '(untitled)'} -> ${s.reason}`).join(', '));
}
if (plan.deferred.length) {
  console.log('  Deferred: ' + plan.deferred.map((d) => `${d.title} -> ${d.reason}`).join(', '));
}

if (!apply) {
  console.log('\nPlan only. Re-run with --apply to generate.');
  process.exit(0);
}
if (from) {
  console.log('\n--apply needs a database; --from is a plan-only mode.');
  process.exit(2);
}

const { generateBlogPostsForOpportunity } = await import('./blogManager.js');
let written = 0;
for (const run of plan.runs) {
  const started = Date.now();
  const result = await generateBlogPostsForOpportunity(run.offerId);
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result && result.success) {
    written += result.posts.length;
    console.log(`  ✓ ${run.title}: ${result.posts.length} page(s), mode=${result.mode}, ${seconds}s`);
  } else {
    console.log(`  ✗ ${run.title}: ${result?.error || 'no posts'} (${seconds}s)`);
  }
}
console.log(`\nDone: ${written} page(s) across ${plan.runs.length} offer(s).`);
