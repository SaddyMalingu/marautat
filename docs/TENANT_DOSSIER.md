# What the bot knows about a tenant

**Written:** 2026-11-19 · **Trigger:** the campaign delivered, the founder began engaging as
Malingu Ventures, and asked the obvious thing: *"the bot should know everything about each
tenant — their portal, Writer's Flow, Analytics."*

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

## What is deliberately not in it yet

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
