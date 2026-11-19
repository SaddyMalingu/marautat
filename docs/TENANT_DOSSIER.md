# What the bot knows about a tenant

**Written:** 2026-11-19 · **Trigger:** the campaign delivered, the founder began engaging as
Malingu Ventures, and asked the obvious thing: *"the bot should know everything about each
tenant — their portal, Writer's Flow, Analytics."* Then, more precisely: *"there has to be
high coherence in info across all system endpoints… the WhatsApp assistant beats the
assistance part if it knows nothing."*

## 1 · The platform block — what Alphadome is, read live

Until this change the bot's Alphadome knowledge was `utils/alphadomeBrandContext.js`: a pitch
written by hand, including a price (**1,000 KES**) that no longer matched the model, and the
Avatar Universe. The 86 KB `alphadome_knowledge_base_full.json` was never imported by
anything — dead weight that looked like knowledge.

`utils/platformDossier.js` replaces the guesswork with a block assembled from the tables and
from `utils/founderOffer.js` (the single source of both prices):

```
ALPHADOME — WHAT EXISTS TODAY
… builds and runs revenue systems: WhatsApp sales line, M-Pesa collection, tenant portal,
content engine …
Prices: Founder's Package KES 1,000/month (tenants already in); KES 3,000/month (joining
now); the done-for-you funnel build is quoted from $3,000.
Digital packs on sale at /drops: The AI Work Application Kit (KES 1,500) · Alphadome Build
Log 2026 (KES 2,500) · …
Running right now: 12 active tenant(s) · 997 published page(s) · 351 live AI-work offer(s) ·
14 business(es) through discovery · 0 pack(s) sold.
Links to give, one at a time: /drops · /build · /founders-package.html · /discovery · /ai-jobs
```

Rules it encodes: a price is never invented (an unreadable catalogue says *unknown* and links
`/drops` instead), "what do you do" gets two concrete things and **one** link, and the
classified knowledge base is deliberately absent — asking a model to keep a secret in a prompt
is not a control. Cached 10 minutes, capped at 1,600 characters.

## 2 · The owner block — the business, read live

Before this, the reply path knew the tenant's **name, voice, catalogue matches and a lead
coach** — but nothing about the business. A tenant owner asking *"how is my shop doing?"*
got a polite nothing, and the bot could not suggest the next action because it did not know
the last one. The same gap is why the bot refused catalogue questions 38 times
(`docs/WHATSAPP_INTENT_AUDIT_2026-11-12.md`): there was nothing to answer from.

## What is attached now

A **BUSINESS SNAPSHOT** block, rendered from live data, appended to the model's context:

```
BUSINESS SNAPSHOT — Kassangas Music Shop
You are speaking with the OWNER of this business. These are their own numbers: …
Catalogue: 24 active product(s), KES 3,562,880 of stock · dearest: 5-Piece Drum Kit (KES 59,000)
Orders: none recorded yet.
WhatsApp: line connected; message history is not attributed to this tenant yet.
Writer's Flow: no campaign has been run yet.
Content: 0 published page(s)
Next actions you may offer: take one order end to end so the shop is proven; run one Writer's Flow campaign …
```

| Section | Source | What the bot can answer |
|---|---|---|
| Catalogue | `bot_products` | how many products, stock value, what is out of stock, the dearest item |
| Orders | `bot_orders` | how many, value of completed ones, how recently |
| WhatsApp | `conversations` (by `brand_id`) | messages stored, how many from customers, last 7 days |
| Writer's Flow | `wf_campaigns` + `wf_leads` | campaigns run, leads found, outreach sent, last run |
| Content | `blog_posts` | pages published, how recently |
| Next actions | derived gaps | the one sentence that makes a reply useful |

## The two rules that shape it

**1 · Owner only.** The block is attached when the **sender** is the tenant's own phone
(`client_phone` or `point_of_contact_phone`). A customer messaging a tenant's number never
sees the business's numbers — the dossier is not built for them at all.

**2 · "Unknown" is not "0".** A table that could not be read renders as *unknown*, and an
unreadable table never invents a "next action". Telling an owner their shop has never sold,
because a query failed, is worse than saying nothing.

Also: every query is capped (products 500, orders 100, messages 300, campaigns 50, leads
1,000, posts 200), the block is capped at **1,800 characters**, and the whole dossier is
cached **5 minutes** — a conversation is a burst of messages and the numbers do not change
between them.

## Where it is wired

| File | What it does |
|---|---|
| `utils/tenantDossier.js` | `buildDossier()` (pure, testable) and `loadDossier()` (bounded, cached, never throws) |
| `server.js` → `findTenantByOwnerPhone()` | on the **Alphadome number**, a sender who is a tenant owner is resolved to their tenant (`req.tenantVia = 'owner'`) instead of being treated as a stranger |
| `server.js` → webhook | appends the snapshot to `dbContext` **only when the owner is speaking**, then to `dbContextWithLead` |
| `server.js` → `getSystemPrompt()` | rule 11: if a BUSINESS SNAPSHOT is present, answer from it plainly, never invent a number, and say what the next action is when something is empty |

## Inspect it

```powershell
npm run tenant:dossier -- --tenant 254713793488   # one tenant
npm run tenant:dossier                            # every active tenant
npm run tenant:dossier -- --tenant 254702245555 --json
npm run test:tenant-dossier                       # 30 checks, no database needed
```

The CLI calls the **same** `loadDossier()` the reply path uses, so what it prints is what
the bot sees — not a second implementation that could drift.

## 4 · Reach — did the pages earn anything?

Attribution cost one discovery: **`blog_posts.tenant_id` points at `site_tenants`, not
`bot_tenants`.** The dossier was asking the wrong table and reporting *"0 published page(s)"*
for a business with 445 posts. The loader now resolves the site tenant by phone once and uses
its id for everything content-shaped (posts, offers, enquiries).

With that fixed, Malingu Ventures reads:

```
Content: 200 published page(s) — Applying for Legal Expert… · The Portfolio a Legal Expert…
         · What the Assessment Asks For… · +197 more · newest today
Live offers behind those pages: 56.
Reach (7 days): 256 view(s) · 35 click(s) · 34 apply click(s) · 1 pack click(s) · 0 enquir(ies)
Next actions: … readers are arriving and nothing converts — take one order end to end
```

That last line is the point. Views are pair-recorded with what the reader did, and when
traffic arrives with no order behind it, the block says so instead of congratulating anyone.

Attribution is bounded: the 60 most recent published slugs, `/blog/<slug>` and its `.html`
twin, seven days, 2,000 click rows. Older posts are excluded rather than costing a slow query
on every message.

## 5 · The 24-hour hunt

`npm run hunt` ranks today's revenue actions from live data — unanswered humans first, then
clicks without a purchase, then stock without an order, then approved leads without a portal
link, then empty shelves, then the fee. Read-only; it never sends.


The ask: *"it should be clear — not just running. It must seek clarification and tell the user
what is about to happen for approval."* `utils/wfOutreach.js` is a pure state machine that the
webhook consults before any model call:

| Turn | The bot | What it must not do |
|---|---|---|
| "run outreach" | *"I will not start one from a single word. What am I looking for?"* | create anything |
| the goal | confirms the phrase, asks for industries | guess industries |
| industries | asks how many leads (cap 25) | exceed the runner's cap |
| the count | **states the plan**: draft name, search terms, industries, lead count, and *"outreach messages are **not** sent by this step"* | run it |
| "YES" | creates a **draft** campaign (`insertWfCampaign`, status `draft`) and says *"Nothing has been sent. Press Run in your portal"* | send, or start the run |
| anything else | *"I have not created anything"* | treat silence as consent |

State lives in `user_sessions.context.wf_outreach`, so a conversation survives the next message
and a deploy. Cancel clears it. Every number is clamped to `WF_MAX_TARGET` (25), and the reply
for a created draft says exactly what exists and what has not happened.

Why a draft and not a run: a campaign spends the tenant's **email reputation** with inbox
providers and their **credibility** with strangers. The bot's job is to make the decision easy
and reversible, not to make it.

## 7 · Coherence — one source per fact

| Fact | Single source | Everywhere else |
|---|---|---|
| Founder's rate / walk-up price | `utils/founderOffer.js` | platform block, tenant messages, `/founders-package.html`, `money:routine` |
| The five packs and their prices | `digital_products` | `/drops`, platform block |
| Whether a tenant can sell | `bot_products` | owner block, `money:routine` |
| What is published | `blog_posts.status` | owner block, platform block |
| Who has a portal link | `bot_tenants.portal_token` | owner block, `tenants:campaign` |
| What was promised at signup | `discovery_submissions` | owner block |

If a fact is missing from a table, the block says **unknown** and names the next action. It
never guesses, and it never quotes the hand-written pitch.


- **Analytics** (page views, CTA clicks, referral revenue): the tables are platform-wide and
  not yet attributed per tenant, so reporting them would be a guess. The honest line is
  "line connected; history not attributed to this tenant yet".
- **Customer names and phones**: counts only. An owner asking "who are my customers" is a
  portal question, not a chat one.
- **Money collected** (subscriptions): the tenant's own M-Pesa settlement lives outside this
  block; `OPEN_FLAGS` #57 governs how that is counted.

The next step, when the first tenant starts selling, is to attribute `analytics_page_views`
and `opportunity_events` to the tenant so the snapshot can end with *"3 pages earned 41
clicks and 2 enquiries this week"* — which is the sentence an owner actually pays for.
