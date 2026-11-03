# PartnerStack Network Application — Alphadome

**Purpose:** paste-ready answers for the PartnerStack "Apply to the PartnerStack Network" form,
grounded in what this repo and the live site actually do (verified 2026-11-03).

**Rule for this form:** every field must survive a reviewer clicking the website. PartnerStack
cross-checks the site, pays out against real attribution, and rejects inflated audience claims.
Nothing below claims revenue, client logos, or traffic we cannot show.

---

## 0. How to fill it (do this in order)

1. Fix the website/LinkedIn pair first — they must describe the **same** business (see field 1–3).
2. Tick **Agency partner + Referral partner + Consultant + System Integrator**. Do **not** tick
   Influencer or Publisher: the honest audience is small, and those boxes trigger reach questions
   we would have to overstate to pass.
3. Paste the copy in sections 2–4 verbatim.
4. Get the real traffic number from analytics before answering "monthly audience size" (section 5).
5. Apply to the three "P1" programs in section 7 the same day — Network approval is separate from
   each vendor's approval, and P1 programs are the ones that fit the live product.

---

## 1. What type of partner are you?

Tick these four:

| Box | Justification a reviewer can verify |
|---|---|
| **Agency partner** | Alphadome deploys and hands over systems for clients (pilot from $3,000; retainer $500–2,000/mo) — stated on the live homepage. |
| **Referral partner** | Specifies and integrates third-party software inside client workflows; recommends vendors it already wires. |
| **Consultant** | Runs discovery → scoped pilot → acceptance criteria → handover (live `/discovery` form). |
| **System Integrator (SI)** | Already integrates WhatsApp Cloud API, M-Pesa/Daraja STK, SMTP relays, Supabase, and an affiliate redirect layer. |

Optional fifth — tick **Reseller partner** only if you are willing to buy seats to resell.
Alphadome's white-label motion is licensing *its own* modules ($10,000 anchor), not reselling
vendor seats, so leaving this unticked is the more defensible answer.

---

## 2. Basic information

**Your business website \***
```
https://alphadome.onrender.com/
```
- Verified live on 2026-11-03: HTTP 200, ~72 KB, headline *"Alphadome — Deployable AI Systems for
  Sales, Payments and Operations"*, with labelled **Live / Demo / Next build slice** status per
  surface. This is the page that will get read in review — it is the strongest asset you have.
- `https://alphadome.com` returned **HTTP 403** when tested, so do **not** enter the bare domain
  until it resolves to the same site. `SITE_URL` in this repo already defaults to `alphadome.com`
  in `AI_JOBS_README.md` while `robots.txt` hard-codes `alphadome.onrender.com`
  (`server.js:431`) — that mismatch is worth fixing before a reviewer sees it.

**LinkedIn profile \***
```
https://www.linkedin.com/in/saddy-malingu-25low
```
- Verified: titled *"Founder and CEO at Alphadome"*. Use the **personal** profile; the form accepts
  `in/` or `company/`.
- **Do not** enter `linkedin.com/company/alphadome-ltd`. That page belongs to an unrelated
  software company in Tel Aviv, and attaching to it would be a false affiliation.

**Where are you located? \***
```
Nairobi, Kenya (EAT, UTC+3)
```
The live site says "Built in Nairobi · WhatsApp-first", so this field and the website agree.
If a "legal entity" field appears, use the registered entity name and keep it consistent with the
Invoices/payout profile — the repo shows **Malingu Ventures** as the operating tenant and Malingu
Global Supplies on LinkedIn job posts, while the brand is **Alphadome**. Pick one legal name and
use it everywhere; mismatches are the most common payout-blocking flag.


---

## 3. Tell us a bit about your business \*

**Paste this (829 characters — fits the field):**

> Alphadome builds and hands over working AI systems for small and mid-sized businesses, one
> revenue workflow at a time. We are a small engineering team in Nairobi: WhatsApp campaign and
> follow-up tooling, M-Pesa scan-to-pay checkout, a tenant-ready content engine that generates
> nine SEO pages per offer in the client's own voice, and the dashboards that show what actually
> happened. Every engagement starts with a scoped pilot, a written baseline and acceptance
> criteria, and we publish labelled demos rather than invented results. Current work covers
> multi-branch retail, construction project controls and healthcare supply-chain visibility.
> Because we specify, integrate and support the software inside those workflows, we are usually in
> the room when an SME chooses its tools — which is why we are applying as a partner.

**Longer version, if the field allows 1,500+ characters:**

> Alphadome is a Nairobi-based engineering team that deploys and hands over AI systems for
> revenue and operations. We deliberately work on one costly workflow at a time — quote-to-order,
> lead follow-up, stock exception handling — instead of selling a platform. A pilot begins with
> discovery, a documented baseline and written acceptance criteria, then connects the systems the
> client already runs, and ends with a handover: runbook, admin access and a named owner.
>
> What is running today: an M-Pesa scan-to-pay checkout (QR → STK push → merchant and client
> wallets), WhatsApp campaign and follow-up tooling with human escalation, a multi-tenant core with
> roles, audit trails and tenant isolation proofs, and a content engine that writes a nine-page
> journey per offer in a tenant's own voice and scores every draft against a quality gate before
> it publishes. The same team runs the commercial side: tracked CTAs, a link router that records
> clicks and forwards to the destination unchanged, and per-tenant attribution for referral codes.
>
> Typical buyers are SME owners and multi-branch operators, construction and infrastructure teams,
> and healthcare and service networks. Agencies that want to deliver the same modules can license
> them under a written agreement. As partners we refer and deploy the software our clients actually
> keep: messaging, CRM, payments, accounting and infrastructure.

**Do not add** to this field: tokenised equity, crowdfunding, robot avatars, or "1000 brands in 24
months". Those appear in older repo docs (`README.md`, `LANDING_SITE_CONTENT.md` HOLD sections) and
the repo's own rules (`ALPHADOME_HIGH_TICKET_CONTENT_ENGINE.md`, "Proof and Trust Rules") keep them
off the sales path. They will read as unfocused to a B2B reviewer.

---

## 4. Industries / channels / audience

**What industries do you focus on? \*** — tick, in this order:
- Retail & e-commerce (multi-branch shops, catalogue + repeat purchase)
- Construction & infrastructure (project controls, compliance)
- Healthcare & life sciences (supply-chain visibility, forecasting)
- Professional services & agencies (the licensing channel)
- Education / publishing (journal and research workflows)
- Software & technology (our own SI work)

**What types of sales channels do you use? \***
- Direct sales (founder-led, discovery-call driven — live `/discovery` form)
- WhatsApp (outbound campaigns and follow-up run on our own tooling)
- Outbound email + LinkedIn research (`ABOSS_*` playbooks in this repo)
- Content / SEO (blog engine, nine pages per offer, tracked CTAs via `/go/:id`)
- Partner & reseller channel (white-label licensing from $10,000)
- Referral / affiliate (existing referral-tracking in the tenant portal)

**Where is your audience located? \***
```
Kenya (primary), East Africa (secondary), plus remote agency buyers in the UK, UAE and US.
```

**What types of customers do you work with? \***
```
SME owners and multi-branch operators (roughly 5–200 staff), operations and sales managers inside
those businesses, and agency/consultancy owners who deliver systems to SMEs.
```

---

## 5. Monthly audience size (traffic) \*

**Get the real number first — do not guess:**
```powershell
curl "https://alphadome.onrender.com/api/analytics/visitor-summary?key=YOUR_ADMIN_PASS"
```
(`server.js:13073` — admin-key gated visitor summary.)

Then pick the **band that contains that number**, even if it is the lowest band. Reason:
- PartnerStack reconciles traffic against click/conversion data it holds; a band you cannot
  reproduce shows up as a mismatch during review.
- Alphadome's model is deployment-led, not reach-led. Reviewers approve deployment partners with
  small audiences when the profile says so plainly.
- If the number is under ~1,000/month, add one line where free text is allowed:
  *"Traffic is deliberately small: we sell through discovery calls and scoped pilots, not volume
  content. The blog engine is new and indexed; commission will come from deployments, not clicks."*


---

## 6. Commission preferences

**What is your preferred commission structure? \***
```
Recurring revenue share (preferred), or a hybrid of recurring share plus a one-time bounty on
annual prepay. One-time flat fees are only workable for tools our clients buy once and keep, not
for the software we deploy and support month to month.
```
Why this is the right answer for Alphadome: the deployment is sold as a pilot plus a $500–2,000/mo
optimisation retainer (live pricing section). A partner payout that also recurs keeps the incentive
aligned with the retainer — we only earn while the client is still running the system.

**Preferred rate for content creation or publishing**
```
$500 per long-form article that includes a build walkthrough or working demo; $150 per short-form
video or social post cut from the same build. Content is secondary income for us — we would rather
be paid for deployments and licences, and we only publish tools we have actually used.
```
Two notes before you submit this:
- These rates are **anchors**, matching the repo's offer-ladder convention
  (`ALPHADOME_HIGH_TICKET_CONTENT_ENGINE.md`: "$29–99 templates, $300–1,500 workshop"). Do not sign
  a flat per-post commit at these rates until the video pipeline is actually producing weekly —
  otherwise you have sold inventory you cannot deliver.
- State the disclosure rule you already follow: affiliate links only for tools used or
  independently evaluated, with clear disclosure (same doc, "Content and monetisation").

---

## 7. Which programs to apply to first

Ranked against what Alphadome actually deploys. "Evidence" means a reason a reviewer or a client
conversation can support today — not an aspiration.

| Priority | Program | Commission | Why it fits Alphadome specifically |
|---|---|---|---|
| **P1** | **respond.io** | 15% for customer lifetime | WhatsApp-first is the core product wedge. This is the one tool every WhatsApp deployment touches, and lifetime commission matches a retainer client. |
| **P1** | **Brevo** | $100 per paying customer | Already integrated: the tenant portal ships Brevo SMTP settings (`admin/tenant_dashboard.html:3237`). Existing, documented usage — the easiest approval on the list. |
| **P1** | **Manychat** | 30–50% recurring | Same buyer as WhatsApp campaign tooling (SME marketing/ops). Highest recurring rate in the list for the closest adjacency. |
| **P2** | **monday.com** | up to 20% per closed deal | Ops dashboards for multi-branch SMEs and construction project controls — the "reporting discipline" problem already in the pitch. |
| **P2** | **Pipedrive** | 20% revenue share | Quote-to-order and lead-follow-up pilots are literally CRM pipelines; we configure rather than replace. |
| **P2** | **Xero** / **QuickBooks** | $200 per qualified purchase / 30% off for client | Accounting is the first thing an SME asks for after payments. Good client-side value even at a modest payout. |
| **P2** | **Softr** | 25% for 12 months | Client-facing portals are a recurring deliverable; complements the multi-tenant core instead of competing with it. |
| **P2** | **ElevenLabs** | 22% for first 12 months | Voice agents are the natural next slice after WhatsApp (the repo already has voice-route work: `scripts/test_tenant_voice_route.mjs`). |
| **P3** | **Deel** | $1,500 per paying customer | Highest single payout here, but it needs an HR conversation Alphadome does not currently own. Take it when a client asks, not before. |
| **P3** | **Airwallex** / **Aspire** | up to $400 / $100 per referral | Cross-border and multi-currency for the international agency buyers; weaker fit for M-Pesa-first local SMEs. |
| **P3** | **Aircall**, **Gorgias**, **Apollo.io**, **1Password** | $75/lead, 10%, up to 20%, 25% | Sensible upsells to specific clients (1Password is an easy security add-on). Apply only when a live client need exists. |

**Skip for now:** Webflow/Kit/Teachable/Circle/Gelato/Entreprenista. They pay well but target
creators and course sellers — a different buyer from the SME operator Alphadome sells to, so the
profile would read as unfocused and conversion would be near zero.

**Apply in this order:** respond.io → Brevo → Manychat (P1, same day), then monday.com and
Pipedrive once the first P1 link is live and tracked.

---

## 8. What already exists in this repo (reuse, don't rebuild)

PartnerStack approval is the easy half. Attribution is where money silently disappears. Alphadome
already has the hard part:

| Asset | Where | What it does for partner revenue |
|---|---|---|
| Affiliate-safe link router | `server.js:560` — `app.get('/go/:id', …handleOfferClick…)` | Records the click against the page that earned it, then 302s to the offer URL **unchanged**. No rewriting, no interstitial — exactly what affiliate programs require. |
| Offer/source model | `opportunity_sources`, `opportunities`, `referral_links`, `opportunity_events` (`docs/MULTITENANT_AI_JOBS_RUNBOOK.md`) | A partner program is just another offer source with its own links and events. No new architecture. |
| Per-tenant attribution | `site_tenants.allowed_redirect_domains` + `tenant_id` on offer tables | Each tenant's links are isolated and domain-allowlisted — the pattern already proven for Mercor/Turing/Micro1. |
| Referral dashboard | `admin/tenant_dashboard.html` — `renderReferrals`, referral codes, attributed revenue | Clients and partners see codes used, attributed sales, attributed revenue in KES. |
| Attribution backfill | `npm run offers:attribute` (`scripts/backfill_offer_sources.mjs`) | Attributing historical links to a source is already a solved, evidence-only operation. |
| Content surface | `/blog`, nine pages per offer, `/go/:id` CTAs | Where the partner links actually get read. |

**Minimal implementation slice (target: one working day, no DDL):**
1. Add each approved program as an `opportunity_sources` row (`slug: respondio`, `brevo`, `manychat`,
   `source_type: affiliate`, referral link on the vendor's own host).
2. Add the partner's `allowed_redirect_domains` entry to the tenant that publishes the page.
3. Publish one page per program through the content engine, with the CTA pointing at `/go/<offer-id>`.
4. Verify the 302 still lands on the vendor URL with the referral parameter intact — the rule already
   enforced when Mercor links were tested (`verifyReferralLink`, `OPEN_FLAGS.md` #18).
5. Report weekly from `opportunity_events`: clicks → signups → conversions, per program.

Do **not** bolt PartnerStack's own tracking script onto pages while the `/go/:id` router is live.
Two redirect layers corrupt attribution and both sides lose the click.

---

## 9. Revenue impact (why this is worth the afternoon)

- Direct: commissions on software Alphadome already specifies. A single $3,000–15,000 deployment
  typically carries a handful of vendor seats; at respond.io/Manychat rates that is small per deal,
  but it recurs for the life of the client and costs nothing to earn at the point of sale.
- Indirect: approved partner programs are third-party validation on a site that currently says,
  correctly, that it has **no published case studies**. That is directly useful in the
  agency-licensing conversation ($10,000 anchor).
- Not the business: this will not replace deployments. It is margin on conversations already
  happening, plus a floor under months with no closes.

---

## 10. Main technical and commercial risks

| Risk | Reality check | Mitigation |
|---|---|---|
| Audience is small; profile overstates reach | Analytics shows the true number | Report the honest band, lead with the deployment model (section 5). |
| Entity/identity mismatch (Alphadome vs Malingu Ventures / Malingu Global Supplies) | Repo and LinkedIn use different names | Pick one legal name for payouts and keep website + LinkedIn + bank profile consistent before submitting. |
| `alphadome.com` returns 403 while the site lives on `.onrender.com` | Verified 2026-11-03 | Enter the resolving URL, or fix the domain first. Also reconcile the `SITE_URL` default in `AI_JOBS_README.md` with `robots.txt` (`server.js:431`). |
| Unrelated `linkedin.com/company/alphadome-ltd` (Tel Aviv) | Different company entirely | Use the personal profile only. |
| Commission conflict with white-label licensing | A licensed agency may buy vendor seats directly | Keep client-side referrals to tools Alphadome configures and supports; never refer against a licence holder's own account. |
| Approval rejected as "vague AI company" | Reviewers skim | Anchor the pitch to three named, openable surfaces: scan-to-pay, WhatsApp tooling, content engine. |
| Payout/tax onboarding for KES | Kenya-based payouts need correct currency and tax details | Complete the payout profile before driving any traffic; an unpaid click is a lost click. |
| Claim drift | Older repo docs contain equity/robot/1000-brand claims | Keep the profile free of them; they are already excluded from the live site's sales path. |

---

## 11. Next validation step

1. Get the real traffic number (section 5) and record it with the date checked.
2. Submit the Network application with the website and personal LinkedIn above.
3. Same day: apply to respond.io, Brevo and Manychat.
4. Before the first link goes anywhere public, confirm `/go/:id` preserves the vendor's referral
   parameter end to end — one manual click test per program, recorded.
5. The 30-day success signal is **not** clicks: it is *one approved program with a live, tracked
   link and a named client it was recommended to.*

---

## 12. Field-by-field cheat sheet (fill order)

| Form field | Answer |
|---|---|
| What type of partner are you? | Agency partner, Referral partner, Consultant, System Integrator |
| Your business website | `https://alphadome.onrender.com/` |
| LinkedIn profile | `https://www.linkedin.com/in/saddy-malingu-25low` |
| Where are you located? | Nairobi, Kenya (EAT, UTC+3) |
| Tell us about your business | Section 3, short version (~900 chars) |
| Industries you focus on | Retail, construction, healthcare, professional services/agencies, education/publishing |
| Sales channels | Direct sales, WhatsApp, outbound email/LinkedIn, content/SEO, partner/reseller, referral |
| Audience location | Kenya (primary), East Africa, UK/UAE/US agency buyers |
| Types of customers | SME owners and multi-branch operators (5–200 staff), ops/sales managers, agency owners |
| Monthly audience size | The honest band from `/api/analytics/visitor-summary` |
| Preferred commission structure | Recurring revenue share, or hybrid with a prepay bounty |
| Content rate | $500/article with a build demo, $150/short video |

**A reviewer's likely first three clicks:** homepage → `/discovery` → the blog. Confirm the deployed
homepage is current when you submit (`npm run test:landing` guards it — 53 checks).
