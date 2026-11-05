/**
 * DEPRECATED 2026-11-05 â€” use `node scripts/blog_queue.mjs` instead.
 *
 * This was the first generator: four fixed templates per offer, its own HTML, and it wrote
 * files without ever writing a `blog_posts` row. That last part is why it had to go â€”
 * `restoreFromDB()` rebuilds `public/blog` from the database on every boot, so pages this
 * script produced evaporated on the next deploy while the index kept linking to them.
 *
 * It also filtered `.eq('status', 'published')`, and every offer captured from Turing,
 * micro1 and the rest is written as `status: 'draft'` (see `utils/browserActor/offersImport.js`),
 * so it could never see the offers the collector had just captured â€” the whole reason it ran.
 *
 * The real generator is `scripts/blogManager.js`: nine angles per offer, one voice, quality
 * scoring, AI with a composed fallback, and a `blog_posts` row per page. The batch decision
 * (which offer next, how many fit in the budget) is `utils/blogQueue.js`.
 *
 *   node scripts/blog_queue.mjs                  # what would run
 *   node scripts/blog_queue.mjs --apply          # generate, one offer at a time
 *   node scripts/blog_queue.mjs --from export.json   # plan from a saved export, no DB
 */
console.error('generateBlogPosts.js is retired. Use: node scripts/blog_queue.mjs [--apply]');
console.error('Why: it bypassed blog_posts (pages vanished on redeploy) and filtered status=published,');
console.error('so it never saw the draft-status offers captured from Turing/micro1.');
process.exit(2);

