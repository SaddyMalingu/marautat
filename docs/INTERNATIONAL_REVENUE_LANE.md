# The international revenue lane — funnel as an offer, cards as a lane

**Written:** 2026-11-10 · **Trigger:** Search Console reviewed, and my own catalogue was wrong about who we sell to

## 1. Two corrections first

**Correction 1 — leaving the funnel build out was wrong.** A funnel build is a
**service**, not a download. The drops catalogue is self-serve by design (a signed
link must deliver the thing), so a service rung cannot live in it — but that is a
reason to put the funnel in the ladder, not to drop it from the business. It was
already priced at $3,000–15,000 in `ALPHADOME_HIGH_TICKET_CONTENT_ENGINE.md`; the
mistake was not carrying it into the new offer architecture.

**Correction 2 — the drops lane I built cannot take money from our actual
traffic.** `POST /api/drops/:slug/checkout` is M-Pesa only. A visitor in New York
who wants the $99 track has no way to pay. The lane-agnostic parts (order states,
entitlement, delivery, revenue report) are fine; the *payment* lane is Kenyan-only.

## 2. What the Search Console numbers actually say

28-day window, as reported:

| Country | Clicks | Impressions | CTR |
|---|---:|---:|---:|
| Kenya | 3 | 21 | **14.3%** |
| United States | 2 | 365 | 0.55% |
| United Kingdom | 1 | 137 | 0.73% |
| India | 1 | 106 | 0.94% |
| Nigeria | 0 | 103 | 0% |
| Canada | 0 | 75 | 0% |
| Total (top 6) | 7 | 807 | **0.87%** |

Two things are true at once, and they point in opposite directions:

- **Reach is international.** 90% of impressions are outside Kenya. The thesis
  "we can reach US/UK/CA buyers" is supported by the data.
- **Conversion is not.** Roughly 5 clicks per 800 impressions. The funnel is
  *getting indexed and served* in those countries; it is not yet producing
  qualified buyers. Kenya's 14% CTR is 3 clicks — noise, not a signal.

So "effectively reached by the funnel" is half right: we reach them, we don't yet
move them. Which matters because of what the funnel currently sells.

## 3. What the funnel is actually doing today

The Mercor / Micro1 / Turing engine is a **referral funnel**, not a sales funnel:

```
blog article (299 published pages)
  → /ai-jobs/apply/<id> → provider's own application → provider hires and pays
  → we earn a referral commission later
```

That is a good business, and it is somebody else's conversion. The repo's own
numbers say how slow it is: 26 signed up, 159 applications started, 22 completed,
4 offers, 3 hired, **0 paid** and **$566.32** referred to date
(`docs/BLOG_CONVERSION_ENGINE.md`). The asset we own is the traffic and the page;
the transaction belongs to the provider.

The fix is not to abandon the funnel. It is to **own one transaction on the way
through it** — which is exactly what the drops catalogue is for, once a US buyer
can pay.

## 4. The corrected offer ladder

| Rung | Offer | Price | Currency / lane | Who delivers |
|---|---|---|---:|---|
| 0 | Blueprint / ROI checklist (email capture) | $0 | — | automated |
| 1 | Written packs (courses, kits, build log) | $15–99 | USD card (**MoR**), KES M-Pesa | automated |
| 2 | Four-week implementation workshop / cohort | $300–1,500 | USD card | you, scheduled |
| 3 | **Done-for-you revenue funnel** (WhatsApp + payments + content engine, deployed) | **$3,000–15,000** | USD **invoice**, bank / PayPal / Wise | you, scoped |
| 4 | Optimisation retainer | $500–2,000 / month | USD invoice | you |
| 5 | White-label / multi-tenant licence | $10,000+ | contract | you |

Rung 3 is the one that was missing from the catalogue conversation. It also needs
**no payment integration at all**: an invoice and a bank transfer. That is the
fastest international revenue available, and it is the rung where the funnel
proof we already have (299 pages, measured conversion work, live M-Pesa lane)
does the selling.

Two lanes, one catalogue:

- **Card lane** (US, UK, CA, EU, AU): merchant of record, USD, email delivery.
- **M-Pesa lane** (Kenya): already built, KES, WhatsApp delivery.

The product is the same document. Only the money and the delivery channel differ.

## 5. What a Kenya-based seller can actually accept (verified 2026-11-10)

Checked against provider pages and a payout-tracking index on 2026-11-10. **Verify
again before signing anything** — provider rules change and approval is not
guaranteed by being listed.

| Provider | Kenya seller? | USD cards from US/UK/CA? | Handles US sales tax / UK VAT | Fit for our packs |
|---|---|---|---|---|
| **Paddle** (merchant of record) | Listed as supported (not on their unsupported list) | Yes, 200+ countries | **Yes — Paddle is the seller of record** | **Best fit.** Software/digital only, subject to review; they do not accept coaching-style services |
| **Lemon Squeezy** (MoR) | Supported, bank payouts | Yes | Yes | Good second choice; same software/digital constraint |
| **Polar** (MoR, Stripe Connect Express) | Listed for payouts | Yes | Yes | Viable, newer |
| **Gumroad** | Supported, local bank payouts | Yes | Yes (as MoR) | Fastest to switch on (hours), highest fee. Good for a 48-hour test |
| **Paystack international** | Yes (Kenya) | Yes, after approval | No — you carry tax | Needs compliance docs **plus a live page showing where the digital products are sold** — `/drops` is that page |
| **PayPal** | Receive + withdraw supported | Yes | No | Fine for rung 3 invoices, weak for checkout |
| **Stripe direct** | "Extended network" only | Unreliable | — | Not the plan |

**Recommendation:** rung 3 sells today by invoice (no integration). For rungs 1–2,
start with **Paddle** (or Lemon Squeezy if Paddle's review is slow) so that US
sales tax and UK VAT are somebody else's problem. Keep M-Pesa exactly as built.

## 6. What has to change in the storefront

The catalogue already carries `price_usd`; it is display-only today. The change is
small and contained:

1. **`payment_lane` per product** — `mpesa`, `card`, or `both`. Default `both` for
   published packs.
2. **Lane detection on `/drops`** — a Kenya/Safaricom visitor gets the M-Pesa form;
   everyone else gets a card button. The M-Pesa form must not be the only thing a
   US visitor can see, which is today's state.
3. **`POST /api/drops/:slug/checkout-card`** — creates the same `digital_orders`
   row (status `pending`), then returns the provider's hosted checkout URL. The
   amount comes from the catalogue row in **USD**, never from the body.
4. **`POST /drops/card/webhook`** — provider-specific signature check, then the
   *same* `orderTransition → entitlement → delivery` code the M-Pesa callback uses.
   One state machine, two front doors.
5. **Email delivery** — a card buyer has no WhatsApp thread with us. SMTP config
   already exists in `utils/tenantSmtpConfig.js`; the delivery message becomes an
   email with the same signed link.
6. **Currency-correct receipts** — `revenueSummary()` already reports per product;
   it needs to stop applying the 0.99% M-Pesa fee to card orders.

None of this touches the paywall, the entitlement token, or the pack builder.

**Shipped 2026-11-11.** All six are in the code and covered by tests:

| Change | Where |
|---|---|
| `payment_lane` per product + `lanes` in the public payload | `utils/digitalDrops.js` (`lanesFor`, `preferredLane`), `migrations/2026-11-11_digital_drops_card_lane.sql` |
| Lane detection: a Kenyan visitor sees M-Pesa first, everyone else sees card first | `public/drops.html` (`isKenyaTime`, `buyBoxHtml`) |
| `POST /api/drops/:slug/checkout-card` — USD, priced from the catalogue, returns the hosted URL | `routes/drops.js` |
| `POST /drops/card/webhook` — HMAC-SHA256 over the raw body, then the *same* `deliverOrder()` | `routes/drops.js`, `utils/digitalDrops.js` (`verifyCardWebhook`, `parseCardWebhook`) |
| Email delivery with the same signed link | `utils/dropsMailer.js`, `utils/digitalDrops.js` (`deliveryEmail`) |
| Currency-correct receipts (KES and USD reported separately, card fee not invented) | `revenueSummary()` — now returns `by_currency` and `by_lane` |
| Rung 3 (the funnel build) — page, queue, notification | `public/build.html`, `POST /api/service-requests`, `service_requests` table |


## 7. Seven days, in the order that de-risks most

| Day | Action | Pass condition |
|---|---|---|
| 0 | Open a Paddle (or Lemon Squeezy) seller account for digital/software products; submit `/drops` as the product page | Application submitted, review timeline known |
| 1 | ~~Put rung 3 on the site~~ **done** — `public/build.html` is live behind `/build` | A US or UK visitor can ask for a proposal without talking to anyone first |
| 2 | Send the `/build` page to the 20 most recent discovery submissions and the ABOSS send queue | 3 replies, 1 call booked |
| 3–4 | ~~Build the lane scaffolding~~ **done** — `payment_lane`, lane detection, card checkout | A US phone sees a card button, a Kenyan phone sees M-Pesa |
| 5 | Set `DROPS_CARD_LINK` + `DROPS_CARD_WEBHOOK_SECRET` to the provider's URL and secret; point its webhook at `/drops/card/webhook` | A sandbox card payment produces a delivered order and a working link |
| 6 | ~~Email delivery~~ **done** — needs `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` on the service | The link arrives by email, the pack opens |
| 7 | Measure: which country clicked, which rung they reached | One non-Kenyan click that reaches a checkout |

## 8. What would prove the funnel works (so we stop using impressions)

Measure, weekly, in this order:

1. **Qualified clicks** from US/UK/CA to `/drops` or the rung 3 page — not impressions.
2. **Checkout starts** per country.
3. **Paid orders** per country, and **proposals sent** for rung 3.
4. **Referral revenue** from Mercor/Micro1/Turing, reported separately — it is a
   different business with a different lag.

Impressions are an input. If a page ranks in the US but nobody clicks it, the
title or the offer is wrong — which is a lesson this repo already learned
(`weakTitleReason` in `utils/conversionPlaybook.js`: command-style titles took 0–25
impressions, one situational story took 88,314). Apply that to the international
pages before blaming the market.

## 9. Risks specific to this lane

| Risk | Why it matters here | Mitigation |
|---|---|---|
| **MoR rejects the product** | Paddle/LS are software-only and review the business; "course" copy can read as coaching | Describe the packs as written technical documentation and implementation kits; keep the outlines concrete |
| **Tax/VAT falls on the wrong party** | Selling USD to the UK without a MoR creates a VAT liability nobody planned for | MoR first; no direct card processing until the entity question is settled |
| **Two markets, one catalogue** | $99 vs KES 12,000 is not a conversion rate, it is a discount | Keep `price_usd` an independent anchor; never derive it live from KES |
| **Email deliverability** | A card buyer's only delivery channel is email | Existing SMTP config, SPF/DKIM on the sending domain, page link as fallback |
| **The funnel proof is someone else's** | Mercor hires them; we are paid later | Never present referral volume as our revenue; report it on its own line |
| **Service work does not scale like a pack** | Rung 3 needs your calendar | Cap concurrent builds; use rungs 1–2 to pre-qualify |

## 10. The one-line version

We do not have a Kenya product and an international product. We have one
catalogue, two payment lanes, and a service rung the existing funnel can sell at
$3,000-plus — and the first job is to stop showing a US buyer an M-Pesa prompt.


