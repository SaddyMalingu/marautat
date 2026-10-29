# The conversion engine

**Status:** shipped 2026-10-29. Files: `utils/conversionPlaybook.js` (new),
`utils/ctaBlock.js` (new), `utils/blogWriter.js`, `utils/blogQuality.js`,
`utils/contentJourney.js`, `scripts/blogManager.js`, `scripts/smartAutomation.js`.

## The problem this fixes

The blog was well written and did not convert. Two measurements say why.

### 1. The Mercor referral funnel (rolling window)

| Step | Count | Step conversion |
|---|---|---|
| Signed up | 26 | — |
| Applications started | 159 | — |
| Applications completed | 22 | **13.8% of started** |
| Offers extended | 4 | 18.2% |
| Hired | 3 | 75% |
| Paid | 0 | — |

Six of every seven people who wanted the work gave up **inside the application**.
Nothing on the page had told them what the form would ask for, so the form was
the first time they met the requirements. Total referrals paid to date: $566.32.

### 2. The LinkedIn export (48 articles, 2025-10-27 to 2026-10-26)

| Pattern | Posts | Impressions | Median |
|---|---|---|---|
| Situational story ("the shift towards a digital world") | 1 | 88,314 | 88,314 |
| "Unlock your future as a …" | 1 | 25 | 25 |
| "Master the … assessment" | 1 | 13 | 13 |
| "Ready to work as a …" | 1 | 2 | 2 |
| All 48 posts | 48 | 100,397 | **91** |

One post took 88% of all impressions and 92% of all link clicks (679 of 741).
Every title built as a command or a promise reached between 0 and 25 people.

## What changed

### `utils/conversionPlaybook.js` — one playbook per offer type

Six types (`job`, `product`, `service`, `brand`, `affiliate`, `course`). Each has:

- `reader` — who is actually reading
- `decision` — the single action the page sells
- `blocker` — why they hesitate (for jobs: *"they do not know what the
  application will demand, so the form is where they find out and quit"*)
- `proof` — the three things that move them
- `readiness` — what they must have ready **before** they click
- `afterClick` — what happens, in order
- `askEarly` / `askMid` / `askClose` — the ask ladder

Also exports `WEAK_TITLE_PATTERNS` (the losing title shapes, with the LinkedIn
evidence in the reason string), `TITLE_SHAPES` (what to write instead),
`conversionBrief()` (prompt text) and `readinessCard()` (deterministic HTML).

### `utils/blogWriter.js` — the brief now carries the conversion job

`buildArticlePrompt()` gains a `THE CONVERSION JOB` section and `shapeRules()`
gains rules 9-12:

- 9. first 100 words: offer, figure, next step
- 10. mid-page ask around section four
- 11. answer the named hesitation in the body
- 12. never invent the middle of the journey (no invented assessment format,
      delivery promise, guarantee or processing time)

`buildRepairPrompt()` chases the same targets, so the repair pass cannot loop on
a page that keeps failing for a reason the repair prompt never mentioned.

### `utils/blogQuality.js` — the gate measures conversion

`analyzeArticle(html, { offerType, title })` now also returns `conversion`:

| Field | Meaning |
|---|---|
| `offerInOpening` | a figure, price or next step in the first 110 words |
| `midAsk` | a call to action between 30% and 75% of the page |
| `readinessHeading` | a "Before you apply/order/enrol/get in touch" section, matching the type's verb |
| `firstPerson` | how often the business says we/our/us |
| `distinctNumbers` | unique figures on the page |
| `duplicateParagraphs` | paragraphs repeated word for word |
| `weakTitle` | the title is a promise, not a situation |

New issues: `duplicate-paragraph` (weight 12, **blocking**), `no-readiness` (10),
`no-offer-early` (8), `no-mid-ask` (6), `thin-specifics` (6), `no-first-person`
(4), `weak-title` (0, warning). The readiness check is type-aware: a job page
saying "Before you get in touch" is a buyer template with the nouns swapped, and
it fails.

### `utils/ctaBlock.js` — the button says something

Every page used to end with `Ready to Start? / This opportunity is available
now. / [Apply Now]` — on a job, a product and a course alike — linking to
`/ai-jobs/apply/<id>` even when the offer had no destination, which returns
`{"error":"No destination configured for this offer"}`.

Now: the heading names the offer ("Apply for ML Engineer", "Get Studio Session
priced"), the figure and place are printed when the offer has them, the readiness
list sits directly above the button, and there is a compact copy **above the
article** so a reader who never scrolls still has a way out. Destination order is
`destination_url → referral_url → application_url → /ai-jobs/apply/<id>`. With
none of those, no button is rendered — the page asks for a message instead of
sending the reader to a 404.

`OFFER_CTA` no longer maps `service → "Learn More"`.

### `utils/contentJourney.js` — titles that earn the click

Job titles stopped being commands and stopped carrying a trailing year or a
possessive `s` (which produced "…English & Finnishes" on live pages):

| Before | After |
|---|---|
| What is a X? A Complete Guide for 2026 | What a X Actually Does All Day |
| X Salary Guide: What You Can Actually Earn | Is $75/hr Really What a X Earns? |
| Essential Skills for Xs: Do You Have What It Takes? | The Skills X Work Actually Rewards |
| How to Pass the X Assessment: Complete Prep Guide | What the X Assessment Asks For, and How to Prepare |
| How to Get Hired as a X: Step-by-Step | Applying for X Work: What Happens, Step by Step |
| Remote X Jobs: Work from Anywhere Guide | Where Remote X Jobs Are Actually Listed |
| X Career Roadmap: Junior to Senior in 5 Years | What Changes in Five Years of X Work |

### `scripts/blogManager.js` — publishing hygiene

- `verify-writers-flow-*` and `test-ai-specialist-*` rows are written as
  **drafts** and get no static page. 36 of them were live in the public index.
- The pipeline passes `{ offerType, title }` into `analyzeArticle()`, so the
  conversion gate actually runs.

### The boot migration (2026-10-29, after the first deploy)

`restoreFromDB()` copied `html_content` byte-for-byte whenever a page passed the
readability audit, so the new footer reached only newly written pages. Three
changes make the existing corpus migrate itself on boot, with no model calls:

1. A page still carrying `Ready to Start?` or `This opportunity is available now.`
   is rebuilt even though it passes the audit — no code path produces those
   strings any more, so the page is stale by definition (`isStalePage()` in
   `utils/ctaBlock.js`).
2. The offers query the rebuild uses now selects `compensation_max`,
   `compensation_currency`, `location_text`, `destination_url`, `referral_url`
   and `application_url`, so the new footer can print the figure, the place and
   the real destination.
3. `/blog` is built from the files on disk, so any file without a published row
   kept being advertised — and the verifier's own pages were 93 links deep in the
   index, titled `Verify Writers Flow 20261022130935`. The restore now demotes
   existing verifier rows to draft, deletes files with no published post, and
   rebuilds the index from **real titles** instead of slug-cased filenames.

First deploy result: `Restored 337 posts (240 rebuilt from their article body)`.
Six sampled pages verified live — no legacy block, offer named in the heading,
readiness list present, two buttons.

### What a rebuild actually changes (and what it cannot)

`restoreFromDB()` re-renders the page **from `blog_posts.content`** and writes the
result to **`html_content` only** — that is the single column it updates:

```js
await sb.from('blog_posts').update({ html_content: fixed }).eq('slug', post.slug);
```

So a rebuild changes the wrapper around the article: `<head>`/`<style>`, the meta
description, the compact CTA above the article, the closing block, and the
"Published … | N min read" line. The article body is passed through
`sanitizeArticleHTML(content)` and embedded verbatim — `content`, `title` and
`slug` are never in an UPDATE payload from this path. (This rebuild path predates
2026-10-29; it used to fire only when a page failed the readability audit. Today
it also fires on the stale footer, which is why 240 pages moved instead of ~105.)

To verify that on production rather than trust it:

```bash
npm run audit:page-fidelity                 # every published post, read-only
npm run audit:page-fidelity -- --slug=chief-of-staff-awareness-1
```

It compares the article inside each stored page against
`sanitizeArticleHTML(content)` and prints how many are identical, which differ,
and which are still on the old footer. It issues SELECTs only.
`test:blog-html` pins the comparison itself (including a tampered-page case), so
the audit cannot pass by being blind.

## How to use it

```js
import { playbookFor, conversionBrief, weakTitleReason } from './utils/conversionPlaybook.js';
import { analyzeArticle, qualityBrief } from './utils/blogQuality.js';

playbookFor({ offer_type: 'job' }).decision;      // what the page sells
weakTitleReason('Unlock your future as a …');      // why that title loses
conversionBrief(offer, { price: 'USD 75' });       // prompt lines

const a = analyzeArticle(html, { offerType: 'job', title: post.title });
a.conversion;                                      // the seven signals
qualityBrief(a);                                   // what a repair pass must fix
```

Tests: `npm run test:blog-quality` (playbook + gate), `npm run test:blog-html`
(CTA block + template), `npm run test:blog-fallback` (journey titles).

## What is not done yet

1. **The 300 existing pages keep their old prose.** The template fix (CTA block,
   readiness card, top button) reaches them for free via
   `npm run repair:blog-html`, which rebuilds HTML from `blog_posts.content`
   without a model call.
2. **The readiness card is generic per offer type**, not per offer. A job that
   needs a specific document should set it on the offer row.
3. **No measurement loop yet.** `GET /tenant/writers-flow/analytics` already
   reports views and clicks per page; the next step is a before/after CTR read
   on the pages rebuilt in step 1.
