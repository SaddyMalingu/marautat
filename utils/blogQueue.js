/**
 * Captured offers -> a blog generation queue (2026-11-05)
 *
 * The generator already exists: `scripts/blogManager.js` walks a nine-angle journey
 * for one offer and writes nine pages (`public/blog/<slug>.html` plus a `blog_posts`
 * row each, restored to disk on boot by `restoreFromDB`). What does not exist is the
 * thing that decides **which offer next**, so today the only path is a human clicking
 * Optimize once per offer inside a 90 s request.
 *
 * This module is that decision, and nothing else. It is pure: offers + existing pages
 * in, an ordered run plan out. No database, no AI, no filesystem. That is deliberate —
 * the plan is what a Render sandbox (or the operator's machine) executes, so it must
 * be readable and testable before anything spends a token.
 *
 * Three rules come straight from how the offers were created:
 *
 *   1. **A draft page is not coverage.** `blog_posts.status` is 'draft' for verifier
 *      artifacts and for anything a run demoted; only a non-draft row is a page the
 *      public can actually reach. Counting drafts as done would silently retire an
 *      offer that has nothing live.
 *   2. **An offer with no referral link earns nothing.** It is still worth writing
 *      (the page can be finished before the link exists — see `offersImport.js`), but
 *      it must not outrank an offer that can be monetised today, and the plan says so
 *      in `needsLink` so the panel can nag about it.
 *   3. **The queue is bounded.** Nine AI angles take up to `BLOG_RUN_BUDGET_MS`; a plan
 *      that promises fifty offers is a plan that never finishes. Work beyond the budget
 *      is returned as `deferred` with that reason, not dropped.
 */

export const PAGES_PER_OFFER = 9; // the content journey every offer walks

/**
 * The text a page will be written around. Deliberately does **not** fall back to the
 * slug: a slug reads like `malingu-ventures-turing-project-lead-ai-training`, and the
 * generator puts the title in the H1 and the schema. A missing title is therefore a
 * refusal further down, not something to paper over here.
 */
function titleOf(row) {
  return String((row && row.title) || '').trim();
}

/** A page the public can reach: any row that is not explicitly a draft. */
function isLivePage(post) {
  const status = String((post && post.status) || '').toLowerCase();
  return status !== 'draft';
}

/**
 * Why this offer scores what it scores. Kept as data, not prose, so the panel and the
 * CLI can render the same explanation instead of inventing their own.
 */
function scoreOffer(row, livePages) {
  const reasons = [];
  let score = 0;

  // Uncovered offers first: the first nine pages of an offer are worth more than the
  // tenth page of one that already has a journey.
  const missing = Math.max(0, PAGES_PER_OFFER - livePages);
  score += missing * 10;
  if (missing === 0) reasons.push('already has a full journey');

  if (row.referral_url) {
    score += 30;
    reasons.push('has a verified referral link');
  } else {
    score -= 10;
    reasons.push('no referral link yet — pages will earn nothing until one is added');
  }

  const rate = Number(row.compensation_max);
  if (Number.isFinite(rate) && rate > 0) {
    // A log scale, not the raw rate: one $200/hr role must not bury twenty $25/hr
    // roles that each need a journey of their own.
    score += Math.min(20, Math.round(Math.log10(rate + 1) * 10));
    reasons.push('pays $' + rate + '/hr');
  }

  const description = String(row.description || '');
  if (description.length >= 400) { score += 5; reasons.push('has a body worth writing from'); }

  return { score, missing, reasons };
}

/**
 * @param {{offers?: object[], posts?: object[], limit?: number, pagesPerOffer?: number,
 *          budgetMs?: number, perOfferMs?: number}} input
 * @returns {{runs: object[], deferred: object[], skipped: object[], needsLink: string[],
 *            totals: object, estimateMs: number, summary: string}}
 */
export function planBlogQueue({
  offers = [],
  posts = [],
  limit = 5,
  pagesPerOffer = PAGES_PER_OFFER,
  budgetMs = 0,
  perOfferMs = 90000
} = {}) {
  const rows = (Array.isArray(offers) ? offers : []).filter(Boolean);
  const pages = Array.isArray(posts) ? posts.filter(Boolean) : [];

  const liveByOffer = new Map();
  for (const post of pages) {
    const key = post.opportunity_id;
    if (!key) continue;
    if (!isLivePage(post)) continue;
    liveByOffer.set(key, (liveByOffer.get(key) || 0) + 1);
  }

  const runs = [];
  const skipped = [];

  for (const row of rows) {
    const title = titleOf(row);
    // Soft-deleted offers are out of the tenant's working set; generating pages for
    // them writes public content for something the tenant already removed.
    if (row.deleted_at) { skipped.push({ title, slug: row.slug || null, reason: 'deleted' }); continue; }
    if (!title) { skipped.push({ title: '', slug: row.slug || null, reason: 'untitled' }); continue; }
    if (!row.id) { skipped.push({ title, slug: row.slug || null, reason: 'no_id' }); continue; }

    const livePages = liveByOffer.get(row.id) || 0;
    const { score, missing, reasons } = scoreOffer(row, livePages);
    if (missing <= 0) {
      skipped.push({ title, slug: row.slug || null, reason: 'covered', livePages });
      continue;
    }

    runs.push({
      offerId: row.id,
      title,
      slug: row.slug || null,
      status: row.status || null,
      source: (row.source && row.source.slug) || row.source_slug || null,
      livePages,
      missing,
      pages: Math.min(pagesPerOffer - livePages, pagesPerOffer),
      ready: Boolean(row.referral_url),
      score,
      reasons
    });
  }

  runs.sort((a, b) => (b.score - a.score) || String(a.title).localeCompare(String(b.title)));

  // The bound is applied after sorting, so a truncated queue still contains the offers
  // that were worth doing, not whichever ones the database happened to return.
  const capped = runs.slice(0, Math.max(0, Number(limit) || 0));
  const overflow = runs.slice(capped.length);
  const deferred = [];
  let accepted = [];

  if (budgetMs > 0 && perOfferMs > 0) {
    // A budget smaller than one offer admits nothing, which is the honest answer: the
    // caller asked for work it cannot finish, and the plan says so instead of starting.
    const fits = Math.floor(budgetMs / perOfferMs);
    accepted = capped.slice(0, fits);
    for (const run of capped.slice(fits)) deferred.push({ ...run, reason: 'budget' });
  } else {
    accepted = capped;
  }
  for (const run of overflow) deferred.push({ ...run, reason: 'limit' });

  const estimateMs = accepted.length * (perOfferMs > 0 ? perOfferMs : 0);
  const totals = {
    offers: rows.length,
    livePages: pages.filter(isLivePage).length,
    eligible: runs.length,
    planned: accepted.length,
    deferred: deferred.length,
    skipped: skipped.length
  };

  return {
    runs: accepted,
    deferred,
    skipped,
    // The list to show the tenant: add a link and these pages start earning.
    needsLink: accepted.filter((run) => !run.ready).map((run) => run.title),
    totals,
    estimateMs,
    summary: `${totals.planned} offer(s) queued, ${totals.livePages} page(s) live already` +
      (totals.deferred ? `, ${totals.deferred} deferred` : '') +
      (estimateMs ? `, about ${Math.round(estimateMs / 60000)} min of generation` : '')
  };
}


