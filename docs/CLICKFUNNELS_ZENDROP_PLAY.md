# ClickFunnels + Zendrop — the Alphadome revenue play

**Written:** 2026-11-05 · **Horizon:** first cash inside 7 days

**Verdict up front:** do **not** become a dropshipper. Become the **payment-and-fulfilment
layer that makes ClickFunnels + Zendrop usable in Africa**, then sell that layer as a
paid pilot to buyers Alphadome can already reach.

---

## 1. Target buyer

Two buyers, in this order.

| # | Buyer | Why they buy | Where they already are |
|---|---|---|---|
| A | **Kenyan/African SMB with a product list and a WhatsApp audience, no funnel** | They have demand in WhatsApp and no page that takes money, no upsell, no fulfilment process | `ABOSS_READY_TO_CONTACT.csv`, `ABOSS_TOP10_TODAY.csv`, `ABOSS_SEND_QUEUE.csv`, `public.discovery_submissions`, live tenants (Kassangas, Coach Dawn) |
| B | **The same SMB's overseas/diaspora customers** (card-paying) | Card checkout works for them; they want the product, not a 3-week wait | the client's own audience — Alphadome sells the *funnel*, not the traffic |

Buyer A is the revenue. Buyer B is the reason the funnel is worth paying for.

**Not the buyer:** a Kenyan consumer buying a Zendrop gadget. See §7 risk 3.

---

## 2. Workflow being solved

Today a client's sale looks like this: WhatsApp message → manual reply → "send M-Pesa
to this number" → screenshot → manual record → manual supplier order. Every step is a
human. That is the workflow this play removes.

Target workflow:

```
traffic ─▶ ClickFunnels page (offer, order bump, one-click upsell, A/B test)
             │
             ├── card buyer ──▶ CF native checkout (Stripe / Payments AI)
             │                    ├─▶ Zendrop auto-fulfils
             │                    └─▶ webhook orders/invoice.paid ─▶ Alphadome
             │                                                       │ order row + WhatsApp receipt
             │
             └── M-Pesa buyer ──▶ Alphadome /pay/t/<id> or
                                  POST /api/kassangas/stk-push
                                    └─▶ STK prompt ─▶ POST /mpesa/callback
                                          └─▶ Alphadome writes bot_orders
                                                ├─▶ Zendrop order (via MCP) or local stock
                                                └─▶ WhatsApp confirmation + tracking
```

The funnel raises average order value. Zendrop removes the supplier work. **Alphadome
is the only party in that diagram that can take M-Pesa.** That is the whole thesis.

---

## 3. What the two platforms actually give you (verified 2026-11-05)

### ClickFunnels 2.0

| Fact | Consequence for us |
|---|---|
| Plans: Launch **$97/mo**, Scale **$197/mo**, Optimize **$297/mo** | Scale is the floor for this play, not Launch |
| **Webhooks + full API access + custom code editor start at Scale** | Any purchase-triggered automation needs $197/mo. No way around it. |
| Payments = **Stripe (via Payments AI), PayPal, Apple Pay, Google Pay** | **No mobile money. No M-Pesa. Ever.** |
| Payments country support is Stripe's / Payments AI's, not ClickFunnels' | See the Stripe row below |
| Feature inventory Alphadome does not have | One-click upsells, order bumps, A/B testing, Smart Checkout, courses, community, MessageHub, discount codes, affiliate center |
| Webhook of record | `orders/invoice.paid` (V1+V2), plus `orders/invoice.fulfilled`, `orders/invoice.refunded`, `contact.created` |

### Stripe

Stripe's own availability page lists **Kenya (and Nigeria, South Africa) only under
"Extended network"** — not a standard supported-country account. A Kenyan entity
cannot simply switch on ClickFunnels card checkout; it needs a US/EU entity (e.g.
Stripe Atlas) or a partner's gateway.

> **This is the hardest constraint in the whole plan, and it is the reason the plan
> works.** Every Kenyan seller who buys ClickFunnels hits it. Alphadome already solved
> it with Daraja.

### Zendrop

| Fact | Consequence for us |
|---|---|
| Plans: Free **$0**, Pro **$49/mo**, Plus **$79/mo** | Free has **no automated fulfilment** — sell Pro |
| **Native ClickFunnels integration** (one-click app, CF 2.0 account required) | Product import + order sync + tracking sync, no code |
| **Up to 10 stores per Zendrop account** (Shopify / TikTok US / Wix / ClickFunnels) | One Zendrop account can back many tenants. Maps to `site_tenants`. |
| **MCP server** — Claude, ChatGPT, Cursor, Gemini, OpenClaw | Alphadome's agents can run the store: catalog search, **shipping quotes to any country**, order list/filter, tracking, revenue/profit/refund analytics, fulfilment trigger, address updates |
| Automated fulfilment only on paid plans | Budget $49/mo per pilot |

The MCP server is the lever most people will miss. Alphadome is an agent platform —
**Zendrop's fulfilment half can be driven by an Alphadome agent with zero integration
code.** That is the automation story to sell.


---

## 4. Reusable Alphadome assets (do not rebuild these)

| Capability | Where | What it does for this play |
|---|---|---|
| M-Pesa STK engine | `server.js:14856` `initiateStkPush()`; `POST /api/kassangas/stk-push` (public); `POST /mpesa/stk-push` (tenant) | The money lane. The public endpoint already takes `{phone, amount, customerName, itemName}` |
| Callback state machine | `alphadome-kernel/src/billing/payments.ts` — `processMpesaCallback()`, `markSubscriptionSuccess()`, `markSubscriptionFailed()` | Payment → order state, already written and tested |
| Payment links + QR | `POST /api/kassangas/create-template`, `POST /api/kassangas/payment-intent`, `/pay/t/:tokenId` → `public/pay.html`, `utils/scanPay.js` | Order-bump / rep link that works without a card |
| Merchant code reconciliation | `utils/scanPay.js` — `tenantMerchantCode()`, `buildAccountRef()` | M-Pesa statement line → tenant. This is what makes the client trust the numbers. |
| Failed-payment fallback | `FALLBACK_PAYMENT_OPTIONS.md` (retry / bank / COD / support) | Recovers STK prompts that fail. Pure margin. |
| Tenant orders | `GET/POST/PATCH/DELETE /tenant/orders` → `bot_orders` | Order of record |
| WhatsApp out | `utils/messenger.js`, `POST /tenant/broadcast`, approved templates | Receipts, tracking, abandoned-cart nudges |
| Tenant onboarding | `GET /discovery` → `POST /admin/api/discovery/submissions/:id/approve` → portal token (`docs/TENANT_ONBOARDING_2026-10-25.md`) | Client #1 can be signed without new code |
| Affiliate router | `app.get('/go/:id')` (`server.js:565`), `opportunity_sources` / `referral_links` / `opportunity_events` | Attribution for every funnel click — sell "I can prove where the sale came from" |
| Conversion engine | `utils/conversionPlaybook.js`, `utils/ctaBlock.js`, `docs/BLOG_CONVERSION_ENGINE.md` — offer type `product` already exists | Funnel copy that is gated, not vibes |
| Outreach machine | `ABOSS_*` CSVs, `scripts/aboss_*`, `docs/PARTNERSTACK_APPLICATION.md` | 20 warm conversations this week |
| Multi-tenant kernel | `alphadome-kernel` credits/quota/tiers, `npm run proof:isolation` | One CF workspace per client, provably isolated |

**What genuinely must be built new:** one route, one adapter, one order-writer
(~150 lines total). See §5.

---

## 5. Minimal implementation slice (the thing to ship)

**Name it the "M-Pesa lane for ClickFunnels".** It is the only piece here a competitor
cannot copy in a week.

### Files

| File | New? | Job |
|---|---|---|
| `utils/clickfunnels.js` | new (~70 lines) | verify webhook signature, map `orders/invoice.paid` → `{ tenantId, cfInvoiceId, email, phone, lineItems[], totalCents, currency }`, idempotency key |
| `POST /cf/order` in `server.js` | new (~40 lines) | receives the webhook, resolves the tenant from the funnel id via `site_tenants`, writes the order, fires the WhatsApp receipt |
| `POST /cf/pay` in `server.js` | new (~30 lines) | the reverse lane: a ClickFunnels page posts `{funnelId, phone, items[]}` → resolve amount → `initiateStkPush()` → return prompt status |
| `bot_orders` write | reuse | one insert path, `metadata.cf_invoice_id` for idempotency |
| M-Pesa callback hook | reuse + ~5 lines | on `plan_type = 'cf_order'` success → mark order paid, notify, queue Zendrop |
| `scripts/test_clickfunnels_bridge.mjs` | new | event-shape, signature rejection, duplicate-webhook, isolation-refusal checks |

### Rules the bridge must hold

- `/cf/order` is authenticated per tenant (shared secret in `bot_tenants.metadata`), never open.
- Idempotent on `cf_invoice_id` — CF retries webhooks.
- A funnel id that is not this tenant's is refused `404`, same as `/pay/t` does.
- STK double-tap inside 90 s replays the prompt, never sends a second one (`utils/scanPay.js` already owns that rule).

### Day by day

| Day | Work | Done when |
|---|---|---|
| 1 | Zendrop → CF 2.0 connect, import **3 SKUs**, run MCP shipping quotes to **Nairobi** and **New York**. Pick **one** offer. | You have two numbers and a decision between the digital lane and the card lane |
| 2 | Build the funnel: page → order bump → one-click upsell → thank-you. Use CF **Store products** so Zendrop can match SKUs; use CF's test-order mode | A test order appears with the correct line items |
| 3 | `utils/clickfunnels.js` + `POST /cf/order` + order write + WhatsApp receipt | A real webhook from CF lands a row in `bot_orders` |
| 4 | `POST /cf/pay` (M-Pesa lane) wired to a funnel button | KES 1 sandbox prompt arrives on your phone and the order flips to paid |
| 5 | Zendrop MCP: the agent creates the fulfilment order from the paid row; tracking written back to WhatsApp | Full loop, one order, no dashboard touched |
| 6 | Demo end to end on your own phone. Pitch 5 names from `ABOSS_READY_TO_CONTACT.csv` | 5 meetings booked |
| 7 | Close #1. Take the deposit **through the lane you just built**. | Cash, and a dogfooded proof |

---

## 6. Revenue impact

### Where the week-one money actually comes from

Product margin does not pay you in seven days. **Service revenue does.**

| Line | Price | When it lands |
|---|---|---|
| **Stocked Funnel** setup (funnel + Zendrop store + WhatsApp bot + M-Pesa lane) | **KES 30,000–50,000** one-off, 50% deposit | Day 3–7 |
| Monthly run | **KES 7,000–10,000/mo** | Month 2 |
| Optional take on collections | **1.5–3%** of M-Pesa collections | ongoing |
| Card-lane unlock (client needs a supported-country entity) | pass-through + KES 5,000 setup | as needed |

One pilot closed in week one = **KES 30–50k (~$230–390)**. Five pilots =
**KES 150–250k** cash plus **KES 35–50k/mo** recurring.

For contrast, the pure dropshipping margin lane: ~$29 AOV, ~$11 landed + ~$6 shipping +
2.9% + $0.30 → **~$9 gross/order**. The same KES 35k needs ~30 orders, which needs paid
traffic you do not have this week. That is why the funnel is sold as a service first and
only later run as your own store.

### Why it compounds

- Each client is a workspace (Scale = 5, Optimize = 10) → the ClickFunnels bill is fixed,
  revenue per workspace is not.
- Each client is a Zendrop store on one account (10 allowed) → same.
- Each client inherits the WhatsApp bot, scan-to-pay and failed-payment recovery → the
  retention story is already built and already test-covered.

---

## 7. Main technical risks

| # | Risk | Reality | Mitigation |
|---|---|---|---|
| 1 | **Stripe country gate** — Kenya is "Extended network", not a supported account | Card checkout may be impossible for a Kenyan entity | Lead with the M-Pesa lane. Card lane only via a US/EU entity (Atlas) or a partner gateway. Tell the client this *before* they buy ClickFunnels. |
| 2 | **Webhooks require the Scale plan ($197/mo)** | A $97 Launch account silently never fires `orders/invoice.paid` | Budget Scale. Fallback: poll the CF API on a timer (worse, but works on cheaper plans) |
| 3 | **Zendrop → Kenya is slow and customs-friction heavy** (weeks, not days) | "Sell Zendrop gadgets to Kenyan consumers" fails on the delivery promise | Get the real number from Zendrop MCP **before** picking a product. Prefer digital/AI offers or local stock for KE buyers; keep Zendrop physical for card-paying, diaspora and US buyers |
| 4 | **One-click upsells may not map to Zendrop line items** | An upsell can arrive as a separate invoice and be left unfulfilled | Price every upsell as its own **CF Store product**, place one real test order *with* an upsell, reconcile by `cf_invoice_id` |
| 5 | **Webhook retries create duplicate orders** | CF retries; double-tap sends two prompts | Idempotency on `cf_invoice_id` + the existing 90 s STK replay guard |
| 6 | **`/cf/order` is a public URL that creates orders** | Anyone could POST fake orders | Per-tenant shared secret + signature verification + funnel-to-tenant check, same pattern as `/pay/t` |
| 7 | **WhatsApp 24 h window** | Order/tracking messages outside the window need approved templates | Submit `order_confirmed`, `order_shipped`, `payment_failed` on day 1 |
| 8 | **M-Pesa has no refund API** | Refunds are manual and visible | Say so in the client's terms; use Zendrop chargeback management for the card lane |
| 9 | **Tenant isolation** | Two clients in one workspace leaks data | One workspace per client; `metadata.tenant_id` on every row; extend `npm run proof:isolation` |
| 10 | **Account risk from dropship-style funnels** | Stripe/PayPal flag unrealistic shipping claims | Honest delivery times on the page. This protects the client and you. |

---

## 8. What not to do

- **Do not buy or rent an aged Stripe account.** It ends the processor relationship for every client hanging off it.
- **Do not promise 3-day delivery to Nairobi** from a China-warehouse SKU.
- **Do not launch 20 SKUs.** One offer, one bump, one upsell. The funnel *is* the demo.
- **Do not use ClickFunnels Classic.** No API, no webhooks, dead end.
- **Do not run two clients' funnels in one workspace.** Isolation is the product.
- **Do not sell "dropshipping" to a Kenyan client.** Sell "a funnel that takes M-Pesa and a supplier that ships" — which is what you can actually deliver.

---

## 9. Next validation step — 30 minutes, zero spend

Three checks, in this order. Each one can kill a bad assumption before any code exists.

1. **Event shape.** In CF 2.0 test mode, place an order with an upsell, pointing
   `orders/invoice.paid` at a `webhook.site` URL. Save the payload.
   *Pass = you know the exact JSON before writing `utils/clickfunnels.js`.*
2. **Economics.** In Zendrop, connect the CF store, import one product, and ask the MCP
   server for shipping cost + delivery window to **Nairobi** and **New York**.
   *Pass = both lanes are priced and one product is chosen. Fail = the KE-consumer
   physical play is dead — sell the digital/AI funnel instead.*
3. **Money lane.** `curl -X POST /api/kassangas/stk-push` with **KES 1** to your own phone.
   *Pass = the one thing no competitor has is live.*

If 1 and 3 pass, the whole product is a ~150-line bridge, and day 6 becomes a pitch
instead of a build.

---

## 10. One-line pitches to carry into those meetings

- **To the SMB:** "ClickFunnels can't take M-Pesa. I already can. I'll build the page, stock the product, and you get the money on your phone and the orders in your WhatsApp."
- **To an agency/partner:** "You sell funnels. Your Kenyan clients can't get a Stripe account. I'm the M-Pesa lane underneath your checkout — white-label it."
- **To the Zendrop/ClickFunnels partner programs:** "We're the East African system integrator: WhatsApp Cloud API, Daraja STK, Supabase and an affiliate attribution layer — already live." (see `docs/PARTNERSTACK_APPLICATION.md`)

---

## 11. The one-line summary

ClickFunnels sells you conversion. Zendrop sells you fulfilment. **Neither can take a
shilling from a Kenyan phone.** Alphadome already can, for every tenant, with receipts
and reconciliation. Charge for that, put the other two underneath it, and the first
KES 35,000 is a signature away — this week.

| 7 | Close #1. Take the deposit **through the lane you just built**. | Cash, and a dogfooded proof |
