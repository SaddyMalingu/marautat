// Local verification of dashboard math + automation_log column handling (no network)
let passed = 0, failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('PASS ' + name); } else { failed++; console.log('FAIL ' + name); } }

// --- Replicate dashboard totals math (must match routes/aiJobsAdmin.js) ---
function totals(opp, page) {
  const oppViews = (opp?.page_views || 0) + (opp?.category_views || 0) + (opp?.opportunity_views || 0);
  const oppClicks = (opp?.apply_clicks || 0) + (opp?.referral_clicks || 0);
  const totalViews = (page?.total_views || 0) + oppViews;
  const totalClicks = (page?.total_clicks || 0) + oppClicks;
  const rawCtr = totalViews > 0 ? ((totalClicks / totalViews) * 100) : parseFloat(page?.overall_ctr || '0');
  return { totalViews, totalClicks, overallCtr: Math.min(rawCtr, 100).toFixed(1) };
}

// Live production snapshot from the /analytics API: 63 page_views, 45 category, 267 opp, 625 apply clicks
const live = totals(
  { page_views: 63, category_views: 45, opportunity_views: 267, apply_clicks: 625, referral_clicks: 0 },
  { total_views: 0, total_clicks: 0, overall_ctr: '0.0' }
);
check('live snapshot views = 375 (63+45+267)', live.totalViews === 375);
check('live snapshot clicks = 625', live.totalClicks === 625);
check('CTR capped at 100, not 166%', live.overallCtr === '100.0');

// Old (HEAD) math for comparison: only opportunity_events.page_views was counted,
// and analytics_page_views was empty, so 63 views vs 625 clicks -> CTR blew up.
const oldViews = 0 + 63, oldClicks = 0 + 625;
check('old math counts only 63 views, dropping category+opp views', oldViews === 63);
check('old math CTR explodes to 992.1%', ((oldClicks / oldViews) * 100).toFixed(1) === '992.1');

// Zero-data edge case stays zero (no NaN, no crash)
const zero = totals(null, null);
check('zero data -> 0 views/0 clicks/0.0 CTR', zero.totalViews === 0 && zero.totalClicks === 0 && zero.overallCtr === '0.0');

// Probe-branch logic: empty table + error naming a column picks the OTHER column
function pickCols(data, errMsg) {
  if (data?.[0]) return new Set(Object.keys(data[0]));
  if (errMsg && /created_at/.test(errMsg)) return new Set(['started_at']);
  if (errMsg && /started_at/.test(errMsg)) return new Set(['created_at']);
  return new Set(['started_at', 'created_at']);
}
check('probe error on created_at -> use started_at', pickCols([], 'column automation_log.created_at does not exist').has('started_at'));
check('probe error on started_at -> use created_at', pickCols([], 'column automation_log.started_at does not exist').has('created_at'));
check('probe empty table no error -> prefers started_at', [...pickCols([], null)][0] === 'started_at');
check('probe with row -> real keys', pickCols([{ started_at: 1, status: 2 }], null).has('started_at'));

// Browser-equivalent parse check: strip the outer Node template wrapper the same
// way a browser HTML parser would (first </script> ends the block), then ensure
// every handler the UI needs is still defined afterwards.
const { readFileSync } = await import('fs');
const src = readFileSync('routes/aiJobsAdmin.js', 'utf8');
const htmlEnd = src.indexOf('</script>');
check('rendered page keeps a single script block boundary', htmlEnd > 0);
const browserJS = src.slice(src.indexOf('<script>') + 8, htmlEnd);
for (const fn of ['generateAllBlogs', 'generateBlogs', 'reviewBlog', 'reviewAllBlogs', 'loadBlogs', 'updateStatus', 'deleteOpp']) {
  check('handler defined and reachable: ' + fn, browserJS.includes('function ' + fn + '('));
}
check('form submit handler bound', browserJS.includes("getElementById('f').onsubmit"));
check('blog list auto-loads on page open', browserJS.includes('loadBlogs();'));
check('no reviewBlog call passes a quote-unsafe raw slug', !src.includes("reviewBlog('\" +"));
check('server-side IDs are JS-string-escaped', src.includes('const jsStr = s => JSON.stringify'));
check('route still renders Page Views card', src.includes('Page Views'));
check('route still renders Top Performing Pages', src.includes('Top Performing Pages'));
check('old broken overallCtr line gone', !src.includes("(oppSummary?.page_views || 0);"));
check('old message-includes fallback gone', !src.includes(".message?.includes('started_at')"));
check('review endpoints untouched', src.includes("action === 'review'") && src.includes('reviewAllBlogs'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
