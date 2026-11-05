/**
 * DEPRECATED 2026-11-05 â€” the nightly job now runs `scripts/blog_queue.mjs`.
 *
 * This was the scheduled writer. It was the only automation actually running (GitHub Actions,
 * 02:00 UTC) and it produced almost nothing, for two reasons worth keeping written down:
 *
 *   1. It selected `.eq('status', 'published')` from `opportunities`, and every offer the
 *      collector captures from Turing, micro1 and the rest is `status: 'draft'` by design
 *      (`utils/browserActor/offersImport.js`). The nightly run therefore never saw captured
 *      offers â€” the same blind spot `generateAllBlogs` has.
 *   2. Its only writer was one fixed HuggingFace model behind `HF_API_KEY`. When that key was
 *      absent or the model was retired, `ai()` returned null, the loop `continue`d, and the job
 *      logged `success` with `posts_generated: 0`. A green tick over zero output for weeks is
 *      the worst kind of automation.
 *
 * `scripts/blog_queue.mjs` replaces it: coverage is computed from `blog_posts`, drafts do not
 * count as done, offers are ordered by revenue (a verified referral link first), the run is
 * bounded, and any failure is reported as a failure. Pages come from
 * `scripts/blogManager.js`, which walks nine angles with a voice, a quality pass, and a
 * composed fallback instead of one model and one prompt.
 *
 * Kept as a stub rather than deleted so an old crontab entry, a bookmark or a half-remembered
 * `node scripts/smartAutomation.js` fails loudly here instead of writing template pages nobody
 * asked for.
 */
console.error('smartAutomation.js is retired. The scheduled path is now:');
console.error('  node scripts/blog_queue.mjs --apply --limit 3');
console.error('Why: it filtered status=published (captured offers are draft) and reported success');
console.error('with zero posts whenever its single HuggingFace model returned nothing.');
process.exit(2);
