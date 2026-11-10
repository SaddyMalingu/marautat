# Digital Drops — the automated digital-product lane

**Written:** 2026-11-10 · **Horizon:** first paid sale inside 7 days · **Status:** built, tested offline, not yet migrated in production

**Verdict up front:** the repo could already write a page that sells a `course` or a
`product`, take an M-Pesa prompt, and message the buyer. It could not hand over
the thing that was bought — every CTA ended at a human. So a digital sale stopped
at the payment. Digital Drops is the missing half: a priced catalogue, a checkout,
a signed access link, automatic delivery, and revenue you can read.

---

## 1. Target buyer

| # | Buyer | Why they buy | What they already cost us |
|---|---|---|---|
| A | **A Kenyan operator or freelancer who found us through search or WhatsApp** | They want the thing that is written down, today, for a price they can pay from a phone. No card, no invoice, no call. | Nothing. Nobody has to be on a call. |
| B | **An agency or SME that wants our implementation, not our time** | A KES 4,500 kit answers "how does the M-Pesa lane work" for the price of one hour of a developer. It also qualifies the ones who then pay for the deployment. | A sales call that would otherwise happen for free |

Buyer A is the revenue. Buyer B is the reason the packs say "assembled from a
system that runs this", which a generic template cannot claim.

**Not the buyer:** someone who wants a recorded video course. Nothing here
pretends to be one — the catalogue, the page and the pack all say *written
material*. Selling a video that does not exist is the fastest way to lose the
M-Pesa relationship.

---

## 2. Workflow being solved

Before:

```
person finds a blog page → CTA → "get in touch" / a form / another site
                         → a human answers → a quote → maybe a payment
```

After:

```
/drops or /drops/<slug>
   → phone number
   → POST /api/drops/<slug>/checkout     (price computed server-side)
   → Daraja STK push (this lane's own callback URL)
   → POST /drops/mpesa/callback          (acknowledge, then work)
   → digital_orders paid → digital_entitlements row → signed token
   → WhatsApp message with the access link
   → /drops/access/<token> → the pack itself
   → GET /api/drops/stats?key=…          (gross, fees, net, AOV, per product)
```

No step needs a human. The only manual actions are: adding a product to the
catalogue, and answering a buyer who replies on WhatsApp.

---

## 3. What already existed, and what was reused

| Capability | Where it already was | How this uses it |
|---|---|---|
| M-Pesa STK push | `server.js` → `initiateStkPush()` | Called with a per-call `callbackUrl`; **one** STK implementation still exists in the repo |
| Callback shape and receipts | `POST /mpesa/callback` | Shape read once, in `parseMpesaCallback()`; the drops lane has its own endpoint so a subscription can never be confused for a product |
| WhatsApp sender | `utils/messenger.js` → `sendMessage()` | Delivery message after payment; a send failure does not undo a paid order |
| Phone rules | `utils/scanPay.js` → `normalizeMsisdn`, `isValidPayerPhone` | Checkout refuses a number that cannot receive a prompt, before the buyer commits |
| Offer vocabulary | `utils/conversionPlaybook.js`, `utils/ctaBlock.js` | The catalogue uses the same `course`/`product` language as the blog engine, so a drop can be promoted on a page that already knows how to convert |
| Page conventions | `public/pay.html`, `public/dashboard-*` | Same status-message pattern: a `.msg.ok/.err/.wait` block that tells the buyer what happened |
| Migration conventions | `migrations/2026-11-05_blog_jobs.sql` | Same shape: idempotent, transactional, commented, 503 with the file name when missing |
| Test conventions | `scripts/test_scan_pay.mjs` | Same `ok()` harness, runs with plain `node`, no database |

---

## 4. The minimal implementation slice that shipped

| File | What it is |
|---|---|
| `migrations/2026-11-10_digital_drops.sql` | Four tables: `digital_products`, `digital_orders`, `digital_entitlements`, `digital_events`. RLS on all four, unique checkout id, unique entitlement token |
| `utils/digitalDrops.js` | Pure rules: slugs, order references, the order state machine, entitlement signing/verification, pricing, the delivery message, revenue arithmetic, callback parsing |
| `routes/drops.js` | Eleven routes: storefront, catalogue, checkout, callback, buyer polling, paywall, file, stats |
| `public/drops.html` | Storefront and product page; phone + optional bump; polls its own order |
| `public/drops-access.html` | The delivery page behind the token |
| `data/drops_catalog.json` | Five published products with outcomes, modules, prices, SEO copy and the demand signal each one stands on |
| `data/demand_signals.json` | The sourced numbers the catalogue is scored against, with a checked date on each |
| `scripts/build_drop_assets.mjs` | Builds `drops_assets/*.html` — either an assembled pack from repo documents or a workbook from the module outlines |
| `scripts/drops_pipeline.mjs` | Scores the catalogue against the signals, checks packs and bumps, writes `docs/DROPS_DEMAND_REPORT.md`, and `--apply` publishes to the database |
| `scripts/test_digital_drops.mjs` | 148 offline assertions over the rules, the routes, the catalogue, the migration and the pack builder |

Two lines changed in `server.js` (an import and a mount) and one parameter added
to `initiateStkPush`. Nothing existing was altered or moved.

### Why this cannot interfere with tenant onboarding

The router is mounted at `/`, which is only safe while every path it declares is
namespaced. That is now a test, not a promise (`test:drops`):

| Surface | Paths it uses | Touches tenant onboarding? |
|---|---|---|
| Drops pages | `/drops`, `/drops/:slug`, `/drops/access/:token` | No |
| Drops API | `/api/drops`, `/api/drops/:slug`, `/api/drops/stats`, `/api/drops/order/:ref`, `/api/drops/access/*`, `/api/drops/:slug/checkout`, `/api/drops/:slug/checkout-card` | No |
| Money callbacks | `/drops/mpesa/callback`, `/drops/card/webhook` | No — `POST /mpesa/callback` is untouched |
| Rung 3 | `/build`, `/api/service-requests` | No — a separate `service_requests` queue, **not** `discovery_submissions` |
| Tenant surfaces | `/discovery`, `/discovery/*`, `/tenant/*`, `/admin/*` | Not declared here at all |

Guards that make that true and keep it true:

- `initiateStkPush` gained `callbackUrl` as an **optional** parameter; with it
  absent the call is byte-for-byte the old behaviour
  (`CallBackURL: callbackUrl || process.env.MPESA_CALLBACK_URL`). There is still
  exactly one STK implementation in the repo.
- No catch-all (`app.get('*')`, `app.use('/')` handler, `app.get('/:x')`) exists,
  so a namespaced path cannot be swallowed before it is matched.
- The migrations only create new tables (`digital_*`, `service_requests`); the one
  `ALTER` is on `digital_orders`, which did not exist before 2026-11-10.
- `payment_lane` lives on `digital_products`. The tenant catalogue (`bot_products`)
  is a different table and was not touched.

Verified on 2026-11-11, all passing after the card-lane changes:

| Tenant-facing suite | Result |
|---|---|
| `test:discovery` (approve → tenant → portal invite, failure paths) | **122 passed** |
| `test:tenant-portal` (mobile portal, every panel it calls) | **115 passed** |
| `test:tenant-session-persistence` | **37 passed** |
| `test:apply` (application fallback) | **23 passed** |
| `test:smoke-tenant` (the onboarding smoke script itself) | **12 passed** |

That is 309 assertions on the onboarding chain, run after the drops work, none
broken.


---

## 5. The catalogue, and why those five

Prices are KES anchors; `price_usd` is a display anchor for diaspora buyers and is
never charged through M-Pesa (the STK lane collects shillings).

| Rank | Product | Kind | KES | Stands on |
|---:|---|---|---:|---|
| 10 | The AI Work Application Kit | playbook | 1,500 | Our own referral funnel: 159 applications started, 22 completed (13.8%), 3 hired, 0 paid |
| 20 | Alphadome Build Log 2026 | report | 2,500 | The engineering diary the repo already contains, with the measurements that forced each change |
| 30 | WhatsApp + M-Pesa Checkout Kit | kit | 4,500 | >20% of Kenyan online orders run on WhatsApp; 80% of Kenyan SMEs name simple payments as a growth requirement |
| 40 | Multi-Tenant WhatsApp Bot Starter | bundle | 6,500 | Agencies cannot take a second client without tenant isolation |
| 50 | AI Agent Ops Track | course | 12,000 | 2,401 open agentic roles across 194 companies (Oct 2026); agent engineering 65% of the mix, agent ops/infra a further 157 roles |

Every published row names its signals. If a row has no sourced signal, the report
says so: *"This product is a hunch; attach evidence or leave it in draft."*

The ladder is deliberate: KES 1,500 is a phone-sized decision, and the bump on
every pack is the Build Log at KES 2,500, so a buyer who arrives for the cheap
thing can add the proof asset in the same prompt.

**Cheap pack, real content.** `ai-work-application-kit` is 21 KB of written pack
plus the funnel evidence it cites. `ai-agent-ops-track` is 155 KB because it also
bundles the runtime documentation it references. Nothing is a stub: a 6 KB pack at
KES 12,000 would be a refund waiting to happen, and the build is checked in the
test suite.

---

## 6. Revenue, stated as arithmetic and not as a forecast

Fees: Safaricom's collection charge as this repo has described it since the
Kassangas build — **0.99%**. It is a named constant, not a hidden haircut.

| Product | Unit | Fee | Net | Net on ten sales |
|---|---:|---:|---:|---:|
| AI Work Application Kit | 1,500 | 14.85 | 1,485.15 | 14,851.50 |
| Build Log 2026 | 2,500 | 24.75 | 2,475.25 | 24,752.50 |
| WhatsApp + M-Pesa Kit | 4,500 | 44.55 | 4,455.45 | 44,554.50 |
| Multi-Tenant Starter | 6,500 | 64.35 | 6,435.65 | 64,356.50 |
| AI Agent Ops Track | 12,000 | 118.80 | 11,881.20 | 118,812.00 |

Ten sales is not a target and not a promise. It is the smallest number that
answers whether a price is real: if ten sales of a pack does not cover the week
spent building it, either the pack or the price is wrong.

What actually moves this: the repo already publishes a large blog corpus and an
AI-jobs surface. A drop only earns when a page that already gets search traffic
points at it. That is the next job, not this one.

---

## 7. Environment variables

| Variable | Required | What it does |
|---|---|---|
| `DROPS_TOKEN_SECRET` | recommended | Signs access links. Falls back to `TENANT_SESSION_SECRET`, then `ADMIN_PASS`. With none of the three, checkout answers 503 rather than issuing an unsigned link |
| `DROPS_CARD_LINK` | for the card lane | The provider's hosted checkout URL (Gumroad, Paddle, Lemon Squeezy…). Unset means the card lane is closed and the storefront offers M-Pesa only |
| `DROPS_CARD_LINKS` | optional | Per-product override, JSON: `{"ai-agent-ops-track":"https://provider/..."}` |
| `DROPS_CARD_WEBHOOK_SECRET` | for the card lane | HMAC-SHA256 key for `POST /drops/card/webhook`. With it unset the webhook refuses every call |
| `DROPS_BASE_URL` | optional | Absolute base used in the access URL. Falls back to `SITE_URL`, then the request host |
| `DROPS_SUPPORT_WHATSAPP` | optional | Turns "reply on WhatsApp" into a `wa.me` link on the storefront and delivery page |
| `DROPS_ADMIN_KEY` | optional | Key for `GET /api/drops/stats` and `GET /api/service-requests`. Falls back to `ADMIN_PASS`; with neither set, both routes are closed (403) |
| `DROPS_LEAD_EMAIL` | optional | Where a funnel-build proposal request is emailed. Falls back to `ADMIN_EMAIL` |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | for the card lane | The existing platform mailer. A card buyer has no WhatsApp thread, so email is the only delivery channel; with SMTP unset the pack is still on the page and the failure is logged |
| `MPESA_CONSUMER_KEY/SECRET/PASSKEY/SHORTCODE` | already set | The money lane |
| `MPESA_CALLBACK_URL` | already set | Unchanged; the drops lane overrides it per request |

No new dependency was added.

### Switching the card lane on, in order

```bash
# 1. Migrate. One paste, or two files in this order — never the reverse.
#    Supabase SQL editor: paste migrations/APPLY_ALL_digital_drops.sql and run.
#    Or, with psql:
psql "$DATABASE_URL" -f migrations/2026-11-10_digital_drops.sql
psql "$DATABASE_URL" -f migrations/2026-11-11_digital_drops_card_lane.sql

# 1b. Check what the database actually has (read-only, no DDL)
npm run drops:doctor

# 2. Point the lane at a hosted checkout and give webhooks a secret
DROPS_CARD_LINK=https://your-provider.test/checkout
DROPS_CARD_WEBHOOK_SECRET=<random 32 bytes>

# 3. Tell the provider to POST to https://<site>/drops/card/webhook
#    with the order reference in `reference` (or `order_ref`/`ref`) and the
#    signature in `X-Drops-Signature` as HMAC-SHA256 hex of the raw body.

# 4. Buy your own $99 pack with a card, then confirm:
#    - digital_orders.lane = 'card', status = 'delivered'
#    - the access email arrived, and the link opens the pack
```

**If the SQL editor says `42P01: relation "public.digital_products" does not
exist`**, the card-lane file was run before the base file. Nothing was applied —
both files are transactional. Run `APPLY_ALL_digital_drops.sql`, or the two files
in order. `npm run drops:doctor` says exactly which objects are missing and which
file creates them; the 2026-11-11 file now refuses to run out of order with a
message that names the file to run first.



---

## 8. Runbook — seven days

| Day | Action | Pass condition |
|---|---|---|
| 0 | Paste `migrations/APPLY_ALL_digital_drops.sql` into the Supabase SQL editor and run it once (it is the 2026-11-10 file followed by the 2026-11-11 file, in that order) | `npm run drops:doctor` reports every object and column present |
| 0 | Set `DROPS_TOKEN_SECRET` and `DROPS_SUPPORT_WHATSAPP` in Render, deploy | `GET /drops` returns 200 and the catalogue renders |
| 1 | `npm run drops:build` then `npm run drops:publish` | `npm run drops:check` says every published product has a pack |
| 1 | Buy the cheapest pack yourself with KES 10 (temporarily lower the price) | Prompt arrives, callback marks it delivered, WhatsApp message arrives with a working link, `/drops/access/<token>` opens the pack |
| 2 | `GET /api/drops/stats?key=…` after two test buys | Gross, fee and net agree with the M-Pesa statement to the shilling |
| 3 | Point one existing blog article with search traffic at its matching drop (the `course`/`product` CTA already exists) | At least one `/drops` session from search in the analytics |
| 4–5 | Send the cheapest pack to twenty people who already asked "how do you take M-Pesa" | First real (non-test) sale, or the objection that stopped it |
| 6 | Publish the Build Log as the bump on everything | Bump attached on at least one of the first five sales |
| 7 | Read the report: which product converted, which page referred it | Keep the winner, retire the pack that got views and no sales |

---

## 9. Risks, and what the build already does about them

| # | Risk | Mitigation in the code | Still open |
|---|---|---|---|
| 1 | **A fake "payment received" call** | Access is issued only from the Safaricom callback, matched on `CheckoutRequestID`, never from the buyer's browser | Safaricom IP allow-listing is still worth adding |
| 2 | **Two prompts from one double tap** | 90-second replay guard reuses the open order instead of pushing again | A buyer can still prompt twice from two numbers; the second payment is a support case, not a code bug |
| 3 | **A retried callback delivers twice** | `orderTransition()` returns null for a repeated `paid`; entitlements are unique per `(order_id, product_slug)` | — |
| 4 | **The pack leaks** | Files live in `drops_assets/`, are never served by `express.static`, require a valid signed token, and the path is `basename()`-ed and prefix-checked | A buyer can forward a working link; the token is one order, expires, and has a download ceiling |
| 5 | **Someone polls another order** | The browser holds a random lookup secret; the database stores only its SHA-256 | — |
| 6 | **A buyer pays and gets nothing** | The link is on the page as well as WhatsApp; a WhatsApp failure is logged, never fatal | Needs a daily check of `paid` orders without a delivered entitlement |
| 7 | **M-Pesa has no refund API** | Refunds are manual and visible; the delivery page names support | Say it in the terms |
| 8 | **A price entered in the body** | The route computes the amount from the database row; there is no amount field in the page | — |
| 9 | **Claims that overstate the product** | The pack's licence page states what it is and is not; the catalogue names "written material, not recorded video" | Marketing copy is a human responsibility |
| 10 | **Tax and licensing** | Nothing here is VAT-aware | Needs an accountant before volume, not after |

---

## 10. What is deliberately not done

> **Corrected 2026-11-10 (after Search Console review).** This section used to say
> "No card checkout" and implied the offer set was Kenya-first. That was wrong on
> both counts: the traffic is not Kenyan (US 365 impressions, UK 137, Canada 75
> against Kenya's 21, 28-day window), and a funnel build *is* an offer — it is a
> **service** rung, so it cannot be delivered by a signed download and therefore
> never belonged in this catalogue. See `docs/INTERNATIONAL_REVENUE_LANE.md` for
> the corrected ladder and the card-lane decision.

1. **No card checkout *in this lane yet*.** Still true of the code as shipped: the
   drops checkout is M-Pesa only. It is no longer the plan. A US or UK buyer
   cannot pay today, which is the single most expensive gap in what was built.
   The fix is a second lane (merchant of record or Paystack international), not a
   rewrite: the order, entitlement and delivery code is lane-agnostic already.
2. **No email delivery.** WhatsApp and the page are the two channels this system
   already runs; adding SMTP would add a failure mode nobody would watch. A card
   buyer outside Kenya has no WhatsApp thread, so **the card lane needs email** —
   that is part of that piece of work, not a nicety.
3. **No automatic blog promotion of the drops.** The `course`/`product` CTA and
   the conversion playbook already exist, but wiring the whole 300-page corpus to
   the storefront is a separate, measurable change — and it should be done one
   page at a time, with the referral visible in analytics.
4. **No subscription or licence tier.** A recurring digital product needs a
   renewal prompt, dunning and a cancellation path. That is a different state
   machine, and it should be built after one-off sales have a conversion rate.
5. **No admin UI for the catalogue.** `npm run drops:publish` is enough for five
   products; a form is worth building at fifty.


---

## 11. Next validation step — 30 minutes, zero spend

1. **Money lane, for real.** Lower one price to KES 10, buy it with your own
   phone, and confirm the entitlement row, the WhatsApp message and the file.
   *Pass = the entire lane works, including the fee arithmetic.*
2. **Paywall.** Take the working access link, change one character, reload.
   *Pass = 403 with a reason, and no file.*
3. **Traffic.** Pick the one blog article with the most search impressions and add
   a link to its matching drop. *Pass = a click appears in analytics within a week;
   fail = the catalogue needs a page that ranks, not a better storefront.*

If 1 and 2 pass, the lane is a product. If 3 fails, the next five days belong to
distribution, not to more packs.

---

## 12. Commands

```bash
npm run test:drops         # 148 offline assertions, no database, no M-Pesa
npm run drops:build        # build every published pack into drops_assets/
npm run drops:check        # fail if a published product has no pack
npm run drops:report       # score the catalogue, write docs/DROPS_DEMAND_REPORT.md
npm run drops:publish      # upsert the published catalogue into digital_products
```

The report is regenerated by `drops:report`; treat `docs/DROPS_DEMAND_REPORT.md`
as output, not as a hand-edited document.


