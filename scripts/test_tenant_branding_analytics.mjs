// Qualification test for the tenant portal's three ownership changes (2026-10-27).
//
//   1. The header wears the client's own business name instead of "Tenant Portal".
//      The name already travelled from the discovery form into bot_tenants.client_name
//      and into every session payload; the page ignored it.
//   2. Bootstrap's `.text-muted` (#6c757d, 3.4:1 on this palette) was painting the
//      sentence under every section header, which is why two sections were reported
//      as almost invisible. The palette now owns that class and the muted tone itself
//      is measured against the three surfaces it can land on.
//   3. Analytics reports Writer's Flow per tenant — the same measures the owner sees
//      in /admin/ai-jobs, scoped to one client's offers, pages and page views.
//
// Static assertions plus a run of the pure render helpers, so a rewrite cannot
// satisfy the greps while breaking the screen.
//
//   node scripts/test_tenant_branding_analytics.mjs
import fs from 'fs';
import vm from 'vm';

const page = 'admin/tenant_dashboard.html';
const server = 'server.js';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

for (const file of [page, server]) {
  if (!fs.existsSync(file)) {
    console.log('FAIL  ' + file + ' exists');
    console.log('\n0 passed, 1 failed');
    process.exit(1);
  }
}

const html = fs.readFileSync(page, 'utf8');
const style = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || ['', ''])[1];
const js = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
const srv = fs.readFileSync(server, 'utf8');

// ---- 1. The header belongs to the client ----------------------------------
ok('the brand has its own element to write into',
  /<span class="topbar-brand-name" id="brandName">Tenant Portal<\/span>/.test(html));
ok('the brand is not hardcoded after the element',
  !/<\/span>Tenant Portal<\/span>\s*<span class="topbar-user"/.test(html));
ok('the brand is painted from the session name',
  /function tenantBrand\(\)[\s\S]{0,160}String\(S\.name \|\| ''\)\.trim\(\)/.test(js) &&
  /return name \|\| 'Tenant Portal';/.test(js));
ok('one function owns every place the name appears',
  /function applyBrand\(\)[\s\S]{0,900}brandEl\.textContent = brand/.test(js) &&
  /function applyBrand\(\)[\s\S]{0,900}loginTitle\.textContent = brand/.test(js));
ok('the sign-in card names the business too', /id="loginTitle"/.test(html) &&
  /document\.getElementById\('loginTitle'\)/.test(js));
ok('the browser tab names the business',
  /document\.title = label \? label \+ ' · ' \+ brand \+ ' \| Alphadome'/.test(js));
ok('both show paths repaint the identity',
  /function showLogin\(msg = ''\)[\s\S]{0,400}applyBrand\(\);/.test(js) &&
  /function showApp\(\)[\s\S]{0,300}applyBrand\(\);/.test(js));
ok('the name is written as text, not as markup',
  /brandEl\.textContent = brand/.test(js) && !/brandEl\.innerHTML/.test(js));
ok('the phone slot stops repeating the name',
  /userEl\.textContent = S\.name \? formatPhone\(S\.phone\)/.test(js));
// ---- 2. Muted copy is legible on every surface it can land on -------------
// WCAG 2.1 contrast, computed from the palette rather than eyeballed.
const hex2rgb = (h) => {
  const s = h.replace('#', '').trim();
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const lum = (hex) => {
  const [r, g, b] = hex2rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const palette = (name) => {
  const m = style.match(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{3,8})'));
  return m ? m[1] : null;
};
const muted = palette('text-muted');
ok('the muted tone is a literal colour we can measure', !!muted, String(muted));
for (const surface of ['bg-main', 'bg-card', 'bg-sidebar']) {
  const bg = palette(surface);
  const ratio = muted && bg ? contrast(muted, bg) : 0;
  ok('muted text clears AA (4.5:1) on --' + surface, ratio >= 4.5,
    ratio.toFixed(2) + ':1 — ' + muted + ' on ' + bg);
}
ok('the muted tone is still quieter than body copy',
  muted && palette('text-light') && contrast(palette('text-light'), palette('bg-card')) > contrast(muted, palette('bg-card')), muted);
ok('the page takes .text-muted back from Bootstrap',
  /\.text-muted, \.text-body-secondary, \.text-secondary, \.form-text \{ color: var\(--text-muted\) !important; \}/.test(style));
ok('the override is declared after the palette it reads',
  style.indexOf('--text-muted:') < style.indexOf('.text-muted, .text-body-secondary'));
ok('the override loads after the Bootstrap stylesheet',
  html.indexOf('bootstrap.min.css') > -1 && html.indexOf('bootstrap.min.css') < html.indexOf('.text-muted, .text-body-secondary'));
ok('form placeholders are themed as well',
  /\.form-control::placeholder[^{]*\{ color: var\(--text-muted\); opacity: 1; \}/.test(style));
ok('the reported Scan to Pay sentence is covered by that class',
  /<p class="text-muted"[^>]*>\s*Collect payments for your products and offers/.test(html));
ok("the reported Writer's Flow sentence is covered too",
  /<p class="text-muted"[^>]*>\s*Every page this engine writes for you uses this voice/.test(html));
// ---- 3. Writer's Flow analytics, scoped to one tenant ---------------------
const wfRoute = srv.slice(srv.indexOf('app.get("/tenant/writers-flow/analytics"'));
const wfRouteEnd = wfRoute.indexOf('\n});');
const route = wfRouteEnd > -1 ? wfRoute.slice(0, wfRouteEnd) : wfRoute;
ok('the tenant endpoint exists and is session-gated',
  /app\.get\("\/tenant\/writers-flow\/analytics", tenantSessionAuth, async \(req, res\)/.test(srv));
ok('the tenant is resolved from the session, not from a query string',
  /const ctx = await tenantSiteFromSession\(req\);/.test(route) && !/req\.query\.(phone|tenant)/.test(route));
ok('offers are filtered by the tenant id',
  /\.from\("opportunities"\)[\s\S]{0,200}\.eq\("tenant_id", site\.id\)/.test(route));
ok('pages come from the offers that tenant owns',
  /\.from\("blog_posts"\)[\s\S]{0,200}\.in\("opportunity_id", offerIds\)/.test(route));
ok('traffic is looked up by the page paths those slugs produce',
  /byPath\["\/blog\/" \+ p\.slug\]/.test(route) && /\.in\("page_path", slice\)/.test(route));
ok('a path that is not one of the tenant pages is ignored',
  /const page = byPath\[v\.page_path\];\s*\n\s*if \(!page\) return;/.test(route) &&
  /const page = byPath\[c\.page_path\];\s*\n\s*if \(!page\) return;/.test(route));
ok('the IN list is batched so PostgREST cannot reject it',
  /for \(let i = 0; i < paths\.length; i \+= 100\)/.test(route));
ok('a deployment without the analytics tables degrades instead of 500ing',
  /"42P01", "42703"/.test(route) && /note = note \|\|/.test(route));
ok('the period is bounded',
  /Math\.min\(Math\.max\(parseInt\(req\.query\.days, 10\) \|\| 30, 1\), 365\)/.test(route));
for (const key of ['totals', 'pages: stripped', 'offers: offersOut', 'recent:', 'series:', 'top_countries:', 'public_path:']) {
  ok('the response carries ' + key.replace(':', ''), route.indexOf(key) > -1);
}
ok('page content never leaves the server',
  /const stripped = pages\.map\(\(p\) => \(\{/.test(route) && !/content: p\.content/.test(route) &&
  /\.select\("slug, title, status, created_at, opportunity_id, content"\)/.test(route));
ok('the section actually calls it',
  /apiJson\('\/tenant\/writers-flow\/analytics'\)/.test(js));
ok('the section renders it',
  /\$\{wfAnalyticsHtml\(wf && wf\.ok \? wf\.data : null\)\}/.test(js));
ok('a failed load says so instead of showing zeros',
  /Writer's Flow analytics could not be loaded just now/.test(js));
ok('an empty account gets a way forward',
  /No pages yet/.test(js) && /onclick="go\('writers-flow'\)"/.test(js));
ok('the table reports views, clicks and CTR',
  /<th class="text-center">Views<\/th><th class="text-center">Clicks<\/th><th class="text-center">CTR<\/th>/.test(js));
ok('the Analytics nav row still routes to renderAnalytics',
  /data-sec="analytics"/.test(html) && /analytics:renderAnalytics/.test(js));
ok('the conversation analytics above it are untouched',
  /apiJson\('\/tenant\/analytics'\)/.test(js) && /apiJson\('\/tenant\/attribution'\)/.test(js) &&
  /Messages[^<]{0,14}Last 7 Days/.test(js) && /Cohort Retention/.test(js));

// ---- 5. Traffic that was never counted (2026-10-29) ----------------------
// Two gaps made the CTR figure meaningless: trackClick() had no caller at all,
// so analytics_clicks was empty and every tenant's CTR was 0.0% by construction;
// and hub traffic (/ai-jobs/t/<slug>) was written only to opportunity_events,
// which this portal does not read. Both are now written, and a zero that means
// "not measurable" says so instead of reading as "nobody clicked".
const aiJobs = fs.readFileSync('routes/aiJobs.js', 'utf8');
const analytics = fs.readFileSync('utils/analytics.js', 'utf8');

ok('the apply route records the click, not just the offer event',
  /router\.get\('\/apply\/:id'[\s\S]*?trackClick\(pagePathFromReferrer\(req, '\/ai-jobs\/apply'\), 'apply', req\)/.test(aiJobs));
ok('the click is written before the redirect, so it cannot be skipped',
  aiJobs.indexOf("trackClick(pagePathFromReferrer(req, '/ai-jobs/apply'), 'apply', req)") <
  aiJobs.indexOf("res.redirect(302, dest)"));
ok('an unattributable click is never credited to a tenant page',
  /pagePathFromReferrer\(req, '\/ai-jobs\/apply'\)/.test(aiJobs) &&
  !/trackClick\('\/blog\//.test(aiJobs));
ok('the click is non-blocking', /trackClick\([\s\S]{0,90}\)\.catch\(\(\) => \{\}\)/.test(aiJobs));
ok('all three tenant hub routes record their view',
  (aiJobs.match(/trackHubView\(req\);/g) || []).length === 3);
ok('the hub view uses the real path, so the offer and category pages count too',
  /req\.originalUrl \|\| req\.url[\s\S]{0,80}split\('\?'\)\[0\]\.replace\(\/\\\.html\$\/, ''\)/.test(aiJobs));
ok('hub tracking is behind the same multi-tenant flag as the routes',
  aiJobs.indexOf("if (MULTITENANT) {") < aiJobs.indexOf('trackHubView(req);'));
ok('the referrer parser only accepts our own host',
  /url\.hostname\.toLowerCase\(\) !== host\) return fallback/.test(analytics));
ok('the referrer parser only accepts the two shapes we publish',
  /\/\^\\\/blog\\\/\[A-Za-z0-9_-\]\+/.test(analytics) && /\/\^\\\/ai-jobs\\\/t\\\//.test(analytics));
ok('the tenant endpoint reports the hub separately', /hub,\s+clicks_note: clicksNote,/.test(route));
ok('the hub query is prefix-matched and wildcard-proof',
  /\.like\("page_path", hub\.path \+ "%"\)/.test(route) &&
  /const hubSlug = String\(site\.slug \|\| ""\)\.replace\(\/\[\^A-Za-z0-9-\]\/g, ""\)/.test(route));
ok('a zero CTR explains itself', /clicks_note: clicksNote/.test(route) &&
  /totalViews > 0 && totalClicks === 0/.test(route) && /even if readers clicked it/.test(route));
ok('the section shows the hub cards', /Hub views|Hub CTR/.test(js) && /Hub clicks/.test(js));
ok('the section renders the explanation', /\$\{clicksNote\}/.test(js) && /\$\{hubCards\}/.test(js));
ok('hub figures stay out of the page totals', !/t\.views = .*hub/.test(js) &&
  /const hubCards = hub \?/.test(js));

// The parser itself, executed rather than grepped.
const { pagePathFromReferrer } = await import(new URL('../utils/analytics.js', import.meta.url).href);
const sameHost = 'alphadome.onrender.com';
const req = (referer, host = sameHost) => ({ headers: { host, referer } });
ok('a blog page attributes to its own path', pagePathFromReferrer(req(`https://${sameHost}/blog/chief-of-staff-awareness-1.html`)) === '/blog/chief-of-staff-awareness-1');
ok('the hub attributes to the hub path', pagePathFromReferrer(req(`https://${sameHost}/ai-jobs/t/acme`)) === '/ai-jobs/t/acme');
ok('a hub offer page keeps its full path', pagePathFromReferrer(req(`https://${sameHost}/ai-jobs/t/acme/o/widget`)) === '/ai-jobs/t/acme/o/widget');
ok('a query string does not confuse it', pagePathFromReferrer(req(`https://${sameHost}/ai-jobs/t/acme?utm_source=x`)) === '/ai-jobs/t/acme');
ok('another site cannot claim a page', pagePathFromReferrer(req('https://www.google.com/blog/someone-else'), 'fallback') === 'fallback');
ok('no referrer falls back', pagePathFromReferrer({ headers: {} }, 'fallback') === 'fallback');
ok('an unparseable referrer falls back', pagePathFromReferrer(req('not a url'), 'fallback') === 'fallback');
ok('the blog index is not a page', pagePathFromReferrer(req(`https://${sameHost}/blog`), 'fallback') === 'fallback');
ok('an .html request is normalised the same way the counter uses',
  pagePathFromReferrer(req(`https://${sameHost}/blog/x.html`)) === pagePathFromReferrer(req(`https://${sameHost}/blog/x`)));

// ---- 4. Two branding regressions that belong with section 1 ---------------
ok("the voice explainer's wording is unchanged (test:tenant-voice depends on it)",
  /assigned to your business/.test(html) && /chosen by you/.test(html));

ok('a long business name cannot push the controls off a phone',
  /\.topbar-brand-name \{[^}]*text-overflow: ellipsis/.test(style) &&
  /\.topbar-brand-name \{[^}]*white-space: nowrap/.test(style) &&
  /\.topbar-brand \{[^}]*min-width: 0/.test(style));
// Measured regression: once the header carried a real business name, the shell's
// `1fr` track grew to the header's min-content and the document scrolled sideways
// at 360px (431px of content against a 360px viewport). `minmax(0, 1fr)` is what
// holds it at the viewport.
ok('the shell track cannot be widened by the header',
  /@media \(max-width: 1023px\) \{ \.app-shell \{ grid-template-columns: minmax\(0, 1fr\); \} \}/.test(style));
ok('no bare 1fr is left in the drawer breakpoint',
  !/@media \(max-width: 1023px\) \{ \.app-shell \{ grid-template-columns: 1fr; \} \}/.test(style));
ok('phones drop the phone number so the name gets the room',
  /@media \(max-width: 479px\) \{\s*\.topbar-user \{ display: none; \}/.test(style));
ok('phones drop the word "Logout", keeping the icon and its label',
  /\.topbar-logout \.logout-label \{ display: none; \}/.test(style) &&
  /id="logoutBtn" aria-label="Log out"/.test(html) &&
  /<span class="logout-label ms-1">Logout<\/span>/.test(html));


// ---- 6. Run the helpers; do not just grep them ----------------------------
// Same trick the shell suite uses: a DOM small enough to reason about. The
// functions are lifted out by brace matching so the rest of the page (boot(),
// fetch calls, listeners) never has to run.
function grabFunction(name, source) {
  const start = source.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return null;
}
const escFn = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmtDateFn = (d) => (d ? new Date(d).toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' }) : '-');

const nodes = {};
const makeNode = () => ({ textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, parentElement: { setAttribute() {} } });
['brandName', 'loginTitle', 'topUser'].forEach((id) => { nodes[id] = makeNode(); });
const fakeDoc = { getElementById: (id) => nodes[id] || null, title: '' };
const ctx = vm.createContext({
  document: fakeDoc, console,
  S: { name: 'Malingu Ventures', phone: '254743780542' },
  esc: escFn, fmtDate: fmtDateFn,
});

let helperError = null;
try {
  for (const fn of ['tenantBrand', 'formatPhone', 'applyBrand', 'wfAnalyticsHtml', 'wfTrafficHtml']) {
    const src = grabFunction(fn, js);
    if (!src) throw new Error('could not lift ' + fn + ' out of the page');
    new vm.Script(src, { filename: fn + '.js' }).runInContext(ctx);
  }
} catch (err) { helperError = err.message; }
ok('the identity and analytics helpers can be executed', helperError === null, helperError || '');

if (helperError === null) {
  ctx.applyBrand();
  ok("applyBrand paints the client's business name into the header",
    nodes.brandName.textContent === 'Malingu Ventures', nodes.brandName.textContent);
  ok('the header keeps a title attribute so a truncated name is still readable',
    nodes.brandName.attrs.title === 'Malingu Ventures', String(nodes.brandName.attrs.title));
  ok('the sign-in card wears the same name', nodes.loginTitle.textContent === 'Malingu Ventures');
  ok('the phone is formatted for the small slot',
    nodes.topUser.textContent === '+254 743 780 542', nodes.topUser.textContent);
  ok('the tab title is the business, not the product',
    fakeDoc.title === 'Malingu Ventures | Alphadome', fakeDoc.title);
  ok('a local-format phone becomes a readable number',
    ctx.formatPhone('0712345678') === '+254 712 345 678', ctx.formatPhone('0712345678'));
  ok('an unexpected phone is left alone', ctx.formatPhone('n/a') === 'n/a');

  ctx.S.name = '';
  ok('with no name on the session the fallback is still honest', ctx.tenantBrand() === 'Tenant Portal');
  ctx.S.name = 'joska Sportiff Academy';
  ok('a second tenant gets their own name (nothing is hardcoded)',
    (ctx.applyBrand(), nodes.brandName.textContent === 'joska Sportiff Academy'), nodes.brandName.textContent);

  const failed = ctx.wfAnalyticsHtml(null);
  ok('a failed analytics load is explained, not zeroed', /could not be loaded just now/.test(failed));
  ok('the explanation does not invent numbers', !/stat-value/.test(failed));

  const empty = ctx.wfAnalyticsHtml({
    period_days: 30, totals: { pages: 0, views: 0, clicks: 0, ctr: '0.0' },
    pages: [], offers: [], series: [], recent: [], note: null,
  });
  ok('an account with no pages gets the call to action',
    /No pages yet/.test(empty) && /go\('writers-flow'\)/.test(empty));
  ok('the empty state names the client it is counting for', /joska Sportiff Academy/.test(empty));

  const full = ctx.wfAnalyticsHtml({
    period_days: 30,
    totals: { pages: 3, published: 2, words: 2400, avg_words: 800, views: 41, clicks: 7, ctr: '17.1', offers: 1, pages_this_week: 3 },
    pages: [{ slug: 'a', title: 'Acoustic Guitar Guide', status: 'published', created_at: '2026-10-20T10:00:00Z', words: 800, views: 30, clicks: 5, ctr: '16.7', url: '/blog/a.html' }],
    offers: [{ id: '1', title: 'Acoustic Guitar', slug: 'acoustic', offer_type: 'product', status: 'published', pages: 3, views: 41, clicks: 7 }],
    series: [{ date: '2026-10-20', views: 10, clicks: 2 }],
    recent: [{ slug: 'a', title: 'Acoustic Guitar Guide', created_at: '2026-10-20T10:00:00Z' }],
    note: null,
  });
  ok('the real numbers reach the screen', /41/.test(full) && /17\.1%/.test(full) && /2,400/.test(full));
  ok('the page table lists the tenant page with its link',
    /Acoustic Guitar Guide/.test(full) && /href="\/blog\/a\.html"/.test(full));
  ok('the offer rollup is rendered', /By offer/.test(full) && /Acoustic Guitar/.test(full));
  ok('the 14-day chart is drawn from the series',
    /Page views .* last 14 days/.test(full) && /width:100%/.test(full));
  ok("the Writer's Flow shortcut survives when there is data", /go\('writers-flow'\)/.test(full));
  ok('the block names the client it belongs to', /joska Sportiff Academy/.test(full));
  ok('a hostile page title is escaped, not executed', (() => {
    const out = ctx.wfAnalyticsHtml({
      period_days: 30, totals: {}, offers: [], series: [], recent: [], note: null,
      pages: [{ slug: 'x', title: '<img src=x onerror=alert(1)>', words: 1, views: 0, clicks: 0, ctr: '0.0', url: '/blog/x.html' }],
    });
    return !/<img/.test(out) && /&lt;img/.test(out);
  })());
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

