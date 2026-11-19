# The GTM engine — Explee's shape, on our own rails

**Written:** 2026-11-19 · **Trigger:** *"Have you heard of Explee… I want our system to
conduct that kind of aggressive research and outreach."*

## 1 · What Explee actually is

Read from the snapshot (`C:\Users\HP\Downloads\Explee.html`) and its own copy — *"the most
effective semantic search engine for companies and decision makers"*:

| Part | What it does |
|---|---|
| **Semantic company/people search** | type a segment, get companies and named decision makers |
| **Campaigns** | per campaign: first email, follow-ups, variants, sender name, language of the lead |
| **Sequences** | an email sequence *and* a LinkedIn sequence, sending schedule, auto-replies |
| **Angles** | "Cost of waiting", "Offer a sample", "Free audit" — each campaign picks one |
| **Deliverability** | own domains and mailboxes, suppress list, inbox |
| **Integrations, refer & earn** | mailbox/CRM wiring, a referral scheme |

Their sidebar in the snapshot shows the segments the account is working: tour operators,
community organisations, training providers, private schools, property managers,
WhatsApp-led retailers.

**The honest gap:** the search half needs a data provider. We do not have one, and scraping
LinkedIn is a terms problem. So we copy the half that needs no provider and is the half that
actually converts: **the observation, the score and the sequence.**

## 2 · What we built instead

`utils/gtmPlaybook.js` (pure) + `scripts/gtm_plan.mjs` (research).

```powershell
npm run gtm:plan -- --segment tour_operators --from leads.csv
npm run gtm:plan -- --segment whatsapp_retailers --urls https://a.co.ke,https://b.co.ke
npm run gtm:plan -- --segment private_schools --from leads.csv --push
```

For each company it reads **their own site** — home, `/contact`, `/contact-us` — and records
three signals that decide whether this offer lands:

| Signal | Why it matters |
|---|---|
| an email address | a channel we can actually use |
| a phone or `wa.me` link | they already sell on WhatsApp — the offer fits |
| a checkout / pay link | if absent, *that* is the observation |

Then it scores (0–100, with reasons), dedupes on domain, drops anyone suppressed, and writes a
**three-touch sequence** per business: the observation (day 0), the cost of waiting (day 3),
the closing loop (day 8) — plus a one-paragraph WhatsApp version.

Real output, from `prideinnhotels.com`:

> **Subject:** Your WhatsApp button
>
> Hi,
> I was on https://prideinnhotels.com and noticed your site has a WhatsApp button, but no way
> to pay on it.
>
> The usual cost of that: bookings arrive on WhatsApp and get lost between guides and the office.
> We put a WhatsApp line that answers from the tour catalogue and takes the deposit by M-Pesa
> behind it — one operator took a booking end to end without a human replying.
>
> Worth a look, or not the right time?

That is a true, checkable sentence about *their* site. "I saw you are in hospitality" is what
gets deleted.

## 3 · The rules the tests enforce

- an observation is only used if it was **found** (`observations()` takes facts, not prose);
- **one ask** per message, **three touches**, days 0 / 3 / 8, then stop;
- **no income promise** — asserted across every generated body;
- a lead with **no channel is not a lead**;
- the same business is **never queued twice**, and a suppression list is honoured;
- `--push` creates a **draft** campaign only. Sending stays a separate decision, as with
  Writer's Flow (`docs/TENANT_DOSSIER.md` §6).

## 4 · What it will not do, and why

| Explee feature | Our position |
|---|---|
| Semantic search over every company/person | **Not built.** Needs a provider or LinkedIn scraping; instead research a list *you* bring (CSV, ABOSS queue, discovery submissions) |
| LinkedIn sequences | **Not built.** A LinkedIn automated sequence is a terms problem and a reputation risk; the browser runtime can *read* LinkedIn with a human present |
| Auto-replies | **Partial** — the bot answers inbound automatically, which is the legitimate version |
| Own domains/mailboxes | **Not built.** Today: platform SMTP; per-tenant mailboxes are a deliverability project |

## 5 · Using it aggressively, honestly

1. Pick two segments that can pay this month — **tour operators** and **WhatsApp-led
   retailers** are the strongest fits for an M-Pesa offer.
2. Bring 25–50 names per segment (`--from`). The ABOSS CSVs, `leads/*.csv` and
   `discovery_submissions` are already in the repo; the phone book you already have is a list.
3. `--push` to create the draft campaign, then read the first ten emails yourself. If they do
   not read like sentences you would send, change the segment's `pain`/`offer` in
   `utils/gtmPlaybook.js` — that is the only place the copy comes from.
4. Send, then work replies inside the 24-hour window (`npm run wa:window`).

**The rule that keeps this from becoming spam:** every message contains one thing that is
demonstrably true about the recipient, and the last one says we will stop. That is the
difference between outreach and a broadcast, and it is the only reason a reply rate survives
past week one.
