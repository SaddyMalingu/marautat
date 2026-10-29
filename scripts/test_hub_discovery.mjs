// Regression test for hub discoverability (2026-10-29).
//
// The tenant hub (/ai-jobs/t/<slug>) is the page a client pays for and hands
// out. Probing production showed it was reachable — 200 — but advertised
// nowhere: /sitemap.xml carried 316 urls, 299 of them blog posts and zero hubs,
// and /ai-jobs listed no hub at all. A crawler could only find a hub if somebody
// shared the link, which is not a traffic engine.
//
// This checks that both paths exist, that they cannot advertise a 404 when the
// multi-tenant flag is off, and that a business name cannot inject markup.
//
//   node scripts/test_hub_discovery.mjs
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const sitemap = fs.readFileSync('routes/sitemap.js', 'utf8');
const aiJobs = fs.readFileSync('routes/aiJobs.js', 'utf8');
const service = fs.readFileSync('utils/aiJobsService.js', 'utf8');
const views = fs.readFileSync('utils/aiJobsViews.js', 'utf8');

// ---- 1. The sitemap advertises every hub ---------------------------------
ok('the sitemap can list tenants at all', /getActiveSiteTenants/.test(sitemap));
ok('it imports the query rather than inventing one',
  /import \{[^}]*getActiveSiteTenants[^}]*\} from '\.\.\/utils\/aiJobsService\.js'/.test(sitemap));
ok('it imports the offers query for hub offer pages', /getOffersByTenant/.test(sitemap));
ok('each hub is advertised', /<loc>\$\{SITE_URL\}\/ai-jobs\/t\/\$\{tenant\.slug\}<\/loc>/.test(sitemap));
ok('the offers on the hub are advertised too',
  /<loc>\$\{SITE_URL\}\/ai-jobs\/t\/\$\{tenant\.slug\}\/o\/\$\{offer\.slug\}<\/loc>/.test(sitemap));
ok('a slugless row cannot produce a broken url',
  /if \(!tenant\.slug\) continue;/.test(sitemap) && /if \(!offer\.slug\) continue;/.test(sitemap));

// The important one: a sitemap that lists /ai-jobs/t/* on a host where the flag
// is off would feed crawlers a wall of 404s. Match the emitted url, not the
// comment above it.
const flagAt = sitemap.indexOf('process.env.AI_JOBS_MULTITENANT');
const hubAt = sitemap.indexOf('${SITE_URL}/ai-jobs/t/${tenant.slug}');
ok('hub urls are gated by the same flag as the routes', flagAt > -1 && hubAt > flagAt, `flag=${flagAt} hub=${hubAt}`);
ok('a missing site_tenants table cannot 500 the sitemap',
  /catch \(e\) \{\s*\n\s*console\.warn\('\[Sitemap\] tenant hubs unavailable:'/.test(sitemap));
ok('the blog pages are still in the sitemap', /<loc>\$\{SITE_URL\}\/blog\/\$\{slug\}\.html<\/loc>/.test(sitemap));
ok('the legacy Mercor urls are untouched', /<loc>\$\{SITE_URL\}\/ai-jobs\/mercor\/opportunity\/\$\{opp\.slug\}<\/loc>/.test(sitemap));

// ---- 2. The service can answer "which tenants are there?" -----------------
ok('getActiveSiteTenants exists', /async function getActiveSiteTenants\(/.test(service));
ok('it only returns active tenants', /async function getActiveSiteTenants\([\s\S]{0,320}\.eq\('is_active', true\)/.test(service));
ok('it is exported', /getActiveSiteTenants,/.test(service));
ok('a failed lookup returns an empty list, not an exception',
  /async function getActiveSiteTenants\([\s\S]{0,420}return \[\];/.test(service));

// ---- 3. The landing page is a way in, not a dead end ----------------------
ok('the landing render accepts the tenants', /function renderAiJobsLanding\(categories, sources, tenants\)/.test(views));
ok('it links each hub', /href="\/ai-jobs\/t\/\$\{encodeURIComponent\(t\.slug\)\}"/.test(views));
ok('the landing route passes them', /renderAiJobsLanding\(categories, sources, tenants\)/.test(aiJobs));
ok('it fetches them only when the flag is on', /const tenants = MULTITENANT \? await getActiveSiteTenants\(\) : \[\];/.test(aiJobs));
ok('the landing route imports the query', /const tenants = MULTITENANT[\s\S]{0,10}/.test(aiJobs) && /getActiveSiteTenants/.test(aiJobs));
ok('a tenant name cannot inject markup', /const esc = \(v\) => String\(v == null \? '' : v\)/.test(views) &&
  /esc\(t\.name \|\| t\.slug\)/.test(views));

// ---- 4. Run the renderer instead of trusting the greps -------------------
const { renderAiJobsLanding } = await import(new URL('../utils/aiJobsViews.js', import.meta.url).href);

const withHubs = renderAiJobsLanding([], [], [
  { id: '1', slug: 'malingu-ventures', name: 'Malingu Ventures' },
  { id: '2', slug: 'acme', name: 'Acme <script>alert(1)</script> & Sons' },
]);
ok('a hub link is rendered', withHubs.includes('/ai-jobs/t/malingu-ventures'));
ok('both hubs are rendered', withHubs.includes('/ai-jobs/t/acme'));
ok('the section has a heading', /Businesses on Alphadome/.test(withHubs));
ok('the malicious name is escaped', !/<script>alert\(1\)<\/script>/.test(withHubs) && withHubs.includes('&lt;script&gt;'));
ok('an ampersand is escaped', withHubs.includes('&amp; Sons'));
ok('a slug is url-encoded', renderAiJobsLanding([], [], [{ slug: 'a b', name: 'AB' }]).includes('/ai-jobs/t/a%20b'));

const noHubs = renderAiJobsLanding([{ slug: 'writing', name: 'Writing' }], [], []);
ok('with no tenants the section is absent', !/Businesses on Alphadome/.test(noHubs));
ok('the existing Mercor section survives', noHubs.includes('/ai-jobs/mercor') || noHubs.includes('/ai-jobs/mercor/writing'));
const calledWithoutTenants = renderAiJobsLanding([], []);
ok('an old two-argument call still renders', /AI Jobs &amp; Remote|AI Jobs/.test(calledWithoutTenants) && calledWithoutTenants.length > 500);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
