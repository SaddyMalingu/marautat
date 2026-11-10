# Digital Drops: the funnel, and what actually sells

_Written 2026-11-12. This is the commercial companion to `docs/DIGITAL_DROPS_ENGINE.md`
(which describes the machinery). Every figure below carries its source; where there is
no source, the document says so and treats the number as something to measure rather
than something to repeat._

## 1. What the evidence says sells

Three findings shape the catalogue, and none of them are guesses:

| Finding | Figure | Source |
|---|---|---|
| Small digital products are a real market, not a side hustle | **$2,009,020** earned by Gumroad sellers in the last week | gumroad.com, checked 2026-11-12 |
| Implementation guides, templates and swipe files are the best-performing upsell category | Information products: **31.2%** average upsell take, **47.8%** top quartile; best-performing products named as "implementation guides, templates, swipe files" | Focus Digital, _Average Upsell Conversion Rate: 2026 Report_, n = 1,847 digital businesses, Jan 15 – Jul 28 2026 |
| Order bumps out-convert every other mechanism | **37.8%** of primary purchasers accept a bump | same report |
| AI/agent skills demand is still climbing | **45+ GenAI enrollments per minute** (up from 25 in 2025); agentic AI named the fastest-growing AI skill | Coursera Global Skills Report 2026 (Coursera + Udemy, 300M+ learners, 98 countries) |

What the same evidence does **not** support: any published per-stage conversion range.
The most honest funnel-benchmark source I found refuses to publish numbers at all,
because none could be traced to a named study — and it is right. It lists what to
record instead: visit → capture, capture → checkout start, checkout start → purchase,
refunds, and first-value completion, each against your own cohorts.

So this system measures its own funnel (`GET /api/drops/funnel`) and does not quote
someone else's.

## 2. The rule for choosing a product

A pack gets built only when it passes all four:

1. **It is an implementation artefact** — a kit, a template, a build log, a checklist.
   Not a course of recorded video, which is the expensive shape and the worse-performing one.
2. **It can be assembled from work already done in this repo.** The builder bundles
   source documents verbatim (`scripts/build_drop_assets.mjs`), so the pack ships the
   real implementation rather than a summary of it. Nothing is invented to fill a page.
3. **It names a job the buyer is doing now** — pass an AI-work application, take an
   M-Pesa payment, add a second tenant.
4. **It has a next rung.** A pack with nothing after it is a dead end, and a dead end
   is where a repeat customer is lost.

## 3. The ladder as it stands today

Six rungs. The free rung is real (a filed pack, captured against an email or a
WhatsApp number); every paid rung hands the buyer the next one.

| # | Rung | What is on it | Price | Hands over |
|---:|---|---|---|---|
| 0 | **Free** | The 7-Day Launch Sprint · The AI-Work Application Preflight | KES 0 | Checkout Kit · Application Kit |
| 1 | **Entry** | AI Work Application Kit | KES 1,500 / $15 | Build Log 2026 |
| 2 | **Core** | Alphadome Build Log 2026 | KES 2,500 / $25 | Checkout Kit |
| 2 | **Core** | WhatsApp + M-Pesa Checkout Kit | KES 4,500 / $39 | Multi-Tenant Starter |
| 2 | **Core** | Multi-Tenant WhatsApp Bot Starter | KES 6,500 / $59 | Agent Ops Track |
| 3 | **Premium** | AI Agent Ops Track | KES 12,000 / $99 | → `/build` (rung 5) |
| 4 | **Continuity** | **empty** | — | — |
| 5 | **Service** | Funnel build (done with you) | from $3,000 | the retainer that does not exist yet |

The empty rung is deliberate to look at. A visitor can fall through it, and the
pipeline prints it rather than hiding it.

### Why the free rung exists at all

Not generosity. A visitor who will not type an address will not type a phone number
into an M-Pesa prompt either, and the paid rungs cannot be improved by traffic that
never converts. The free pack costs nothing to serve, it proves delivery works, and it
puts a real contact in `digital_leads` — the only table in this system that is
allowed to know who is interested but has not paid.

## 4. What the funnel does mechanically

| Step | Route | Behaviour |
|---|---|---|
| Visitor meets the free rung | `GET /api/drops/ladder` | Every rung in order, free packs above the prices |
| Captures a pack | `POST /api/drops/lead` | Stores one row, emails **or** WhatsApps a signed link, returns the next paid rung in the same response |
| Opens the pack | `GET /drops/free/:token` | 14-day signed link; a purchase token cannot open it, and a free token cannot open a purchase |
| Buys | `POST /api/drops/:slug/checkout` | Unchanged: the amount still comes from the database |
| Finishes the pack | `GET /api/drops/access/:token` | Now carries `next` — the higher rung, or `/build` at the premium rung |
| Operator reads the funnel | `GET /api/drops/funnel?key=…` | Leads, views, checkout starts, paid orders and gross, per rung |

Two rules are enforced in code rather than in copy:

- **A step up means more commitment.** `isForwardStep()` refuses a `next_slug` that is
  cheaper or on a lower rung, so the ladder cannot loop.
- **The funnel is measured with its denominators.** A rate is `null` when its
  denominator is zero; it is never rendered as 0%, because "no leads yet" and "leads
  that never bought" are different problems.

## 5. The revenue arithmetic (not a forecast)

Stated as quantities rather than promises. At list price, with the 0.99% Safaricom
collection fee:

| Event | Gross | Fee | Net |
|---|---:|---:|---:|
| 10 × Entry (KES 1,500) | 15,000 | 148.50 | 14,851.50 |
| 10 × Checkout Kit (KES 4,500) | 45,000 | 445.50 | 44,554.50 |
| 10 × Agent Ops Track (KES 12,000) | 120,000 | 1,188.00 | 118,812.00 |
| 1 × Funnel build ($3,000) | ≈ KES 387,000 | — | invoiced, not collected by M-Pesa |

What has to be true for ten sales: a hundred free captures at a 10% entry take, or
forty at 25%. Neither is asserted here — `GET /api/drops/funnel?key=…` reports what
actually happened, rung by rung, and the first honest decision is made from that.

The upsell case is where the published evidence helps: order bumps convert at 37.8%
across 1,847 businesses, and information-product upsells average 31.2%. Both mechanisms
already exist here — the bump at checkout, the next rung after delivery. The number
that matters is ours, not theirs.

## 6. The three gaps, in order of cost

1. **Continuity is empty.** Every pack is a one-off. A retainer (monitoring, monthly
   changes, a report) is the only rung that makes a buyer's second month worth more
   than their first. Nothing is built for it yet; the ladder shows the hole.
2. **Free → KES 4,500 is the biggest drop in the ladder.** The Checkout Kit has no
   KES 500–900 tripwire in front of it on the same topic. That is the cheapest product
   left to write, and the one the funnel report will point at first.
3. **The card lane is inert** (`DROPS_CARD_LINK` unset). Every non-Kenyan visitor sees
   an M-Pesa form that rejects their number, so the international rung of this funnel
   is currently a dead end. Provider decision pending; see
   `docs/INTERNATIONAL_REVENUE_LANE.md`.

## 7. Risks worth naming

| Risk | What is already done about it |
|---|---|
| The free packs become low-quality bait | The builder refuses a magnet with no file, fewer than three modules or fewer than three outcomes, and every magnet is assembled from a document that exists in this repo |
| Lead data becomes a liability | `digital_leads` holds email/phone under RLS, is never joined to a tenant, records consent instead of assuming it, and has no other personal data |
| A deploy lands before the migration | Reads fall back to the catalogue file; `--apply` retries without the rung columns and names the SQL file; the storefront falls back to the flat grid |
| A funnel that leaks silently | `GET /api/drops/funnel` reports each rung's denominator, and the pipeline refuses a broken `next_slug` |
| Selling a promised outcome | Packs carry a licence page that states what they are not, and the tests assert no income promise appears |

## 8. What to do next, in order

| # | Action | Pass condition |
|---:|---|---|
| 1 | Run `migrations/2026-11-12_drops_funnel.sql` (or `APPLY_ALL`), then `npm run drops:doctor` | Every object present, including the two 11-12 tables |
| 2 | `npm run drops:publish -- --apply` | "Published 5 product(s)" and "Published 2 free pack(s)" |
| 3 | Open `/drops` | Two free packs above three paid shelves; no empty rung rendered |
| 4 | Capture a free pack with your own email | An email arrives, the pack opens, the next paid rung is named under the button |
| 5 | Buy the Entry pack with your own Safaricom number | Prompt → paid → pack opens → the access page offers the Build Log |
| 6 | `GET /api/drops/funnel?key=…` | `steps[0].leads` is 1, the entry rung shows `paid: 1`, gross 1,500, net 1,485.15 |
| 7 | Write the KES 500–900 payment-topic tripwire | The free → 4,500 jump has a rung in it |

## 9. Tests

- `npm run test:drops` — 378 assertions, including that the ladder never offers
  something cheaper, that a purchase token cannot open a free pack (and the reverse),
  and that the combined migration contains all three files in order.
- `npm run test:drops:flow` — 92 assertions against a live router and a fake database:
  capture, email, WhatsApp, download, token confusion, deduplication, and the funnel
  report's arithmetic.

