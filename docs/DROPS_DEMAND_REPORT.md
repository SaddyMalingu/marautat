# Digital Drops — demand report

_Generated 2026-11-10 by `npm run drops:report`. Prices are list anchors; demand scores are the mean of the signals each product names. Neither is a forecast._

## Catalogue

| # | Product | Kind | Price | USD | Demand | Pack |
|---:|---|---|---:|---:|---:|---|
| 1 | The AI Work Application Kit | playbook | KES 1,500 | $15 | 84 | 21 KB |
| 2 | Alphadome Build Log 2026 | report | KES 2,500 | $25 | 83 | 77 KB |
| 3 | WhatsApp + M-Pesa Checkout Kit | kit | KES 4,500 | $39 | 87 | 56 KB |
| 4 | Multi-Tenant WhatsApp Bot Starter | bundle | KES 6,500 | $59 | 83 | 120 KB |
| 5 | AI Agent Ops Track | course | KES 12,000 | $99 | 93 | 155 KB |

## What each product is standing on

### The AI Work Application Kit — KES 1,500 (demand 84)
- **AI-work application abandonment** (72): 26 signed up, 159 applications started, 22 completed (13.8%), 4 offers, 3 hired, 0 paid — $566.32 referred to date. _Internal referral funnel, rolling window to 2026-10-29 (docs/BLOG_CONVERSION_ENGINE.md)_, checked 2026-11-10.
- **Open agentic AI roles** (95): 2,401 open roles across 194 companies; 66% of 3,617 tracked AI roles (October 2026). _Agentic AI Jobs Index, Get Ready for Agents (CC BY 4.0)_, checked 2026-11-10.
- The repo's own referral funnel: 159 applications started, 22 completed (13.8%), 3 hired, 0 paid. The blocker is discoverable late.

### Alphadome Build Log 2026 — KES 2,500 (demand 83)
- **Proof assets buyers ask for before a deployment call** (70): Build logs and teardowns are the cheapest credible asset for selling implementation work; the repo already holds the material. _Internal: ALPHADOME_HIGH_TICKET_CONTENT_ENGINE.md, docs/BLOG_CONVERSION_ENGINE.md_, checked 2026-11-10.
- **Open agentic AI roles** (95): 2,401 open roles across 194 companies; 66% of 3,617 tracked AI roles (October 2026). _Agentic AI Jobs Index, Get Ready for Agents (CC BY 4.0)_, checked 2026-11-10.
- Buyers of implementation work read build logs before they book a call. This is the same asset sold as proof and as a product.

### WhatsApp + M-Pesa Checkout Kit — KES 4,500 (demand 87)
- **WhatsApp share of Kenyan online orders** (88): More than 20% of Kenya's online shopping orders happen on WhatsApp; 80% of Kenyan SMEs name simple, seamless payments as a top requirement for growth. _Mastercard / Flowcart chat-to-pay announcement; Mastercard 2026 SME Confidence Index_, checked 2026-11-10.
- **M-Pesa collection capability already running in this repo** (85): Daraja STK push, callback state machine, payment links and merchant-code reconciliation are implemented and exercised by live tenants. _Internal: server.js initiateStkPush, utils/scanPay.js, docs/TENANT_SCAN_TO_PAY.md_, checked 2026-11-10.
- WhatsApp carries more than 20% of Kenya's online shopping orders (Mastercard/Flowcart, 2026), and 80% of Kenyan SMEs name simple payments as the top growth requirement.

### Multi-Tenant WhatsApp Bot Starter — KES 6,500 (demand 83)
- **WhatsApp share of Kenyan online orders** (88): More than 20% of Kenya's online shopping orders happen on WhatsApp; 80% of Kenyan SMEs name simple, seamless payments as a top requirement for growth. _Mastercard / Flowcart chat-to-pay announcement; Mastercard 2026 SME Confidence Index_, checked 2026-11-10.
- **Agencies needing a tenant layer to resell conversational commerce** (78): Agencies sell funnels and WhatsApp commerce but cannot open a second client without tenant isolation; the layer is the blocker to resale. _Internal: docs/CLICKFUNNELS_ZENDROP_PLAY.md (buyer B), docs/PARTNERSTACK_APPLICATION.md_, checked 2026-11-10.
- Agencies reselling conversational commerce need the tenant layer before they can take a second client. This is the part that is usually rebuilt badly.

### AI Agent Ops Track — KES 12,000 (demand 93)
- **Open agentic AI roles** (95): 2,401 open roles across 194 companies; 66% of 3,617 tracked AI roles (October 2026). _Agentic AI Jobs Index, Get Ready for Agents (CC BY 4.0)_, checked 2026-11-10.
- **Skills named most often in agentic postings** (90): Python 1,732 · Cloud 972 · RAG 661 · MCP 649 · Kubernetes 624 · TypeScript 508 · LangChain 402 · multi-agent 373 · LangGraph 348 · evals 301. _Agentic AI Jobs Index, October 2026_, checked 2026-11-10.
- 2,401 open agentic roles across 194 companies in October 2026; agent engineering is 65% of the mix and agent ops/infra another 157 roles. Most-requested skills: Python (1,732), RAG (661), MCP (649), TypeScript (508), LangGraph (348), evals (301).

## Ten sales, at list price

| Product | Unit | Fee (0.99%) | Net on 10 |
|---|---:|---:|---:|
| ai-work-application-kit | KES 1,500 | KES 148.5 | KES 14,851.5 |
| repo-build-log-2026 | KES 2,500 | KES 247.5 | KES 24,752.5 |
| whatsapp-mpesa-checkout-kit | KES 4,500 | KES 445.5 | KES 44,554.5 |
| multitenant-whatsapp-bot-starter | KES 6,500 | KES 643.5 | KES 64,356.5 |
| ai-agent-ops-track | KES 12,000 | KES 1,188 | KES 118,812 |

Ten sales is not a target or a promise. It is the smallest number that shows whether a price is real: if ten sales at list does not cover the week it took to build the pack, the price or the pack is wrong.

## Ladder

- ai-work-application-kit — KES 1,500
- repo-build-log-2026 — KES 2,500
- whatsapp-mpesa-checkout-kit — KES 4,500
- multitenant-whatsapp-bot-starter — KES 6,500
- ai-agent-ops-track — KES 12,000

## Checks

- Every published row validates (`validateProduct`): yes
- Every published row has a built pack: yes
- Bumps point at a published product: yes

