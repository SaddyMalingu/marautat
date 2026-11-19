# The 24-hour money routine

**Written:** 2026-11-19 · **Horizon:** money in one working day · **Owner:** the founder

This is the operating script for a day whose only goal is a payment. It exists because
of a measured fact, not a theory: on 2026-11-19 the platform had a live storefront
(`/drops` 200), a live M-Pesa lane (`lanes.mpesa: true`), five built packs, and had
taken **zero** orders — while two people who had asked for the service days earlier,
naming a budget, had never been answered. Nothing needed building. Something needed
asking.

- **Target buyer:** a business owner who has already asked us for lead capture or
  payments and named a budget (today: two of them, both `asap`), then the person who is
  clicking *Apply* on an AI-work offer right now.
- **Workflow being solved:** orders that arrive on WhatsApp get captured, paid and
  recorded instead of lost in a chat.
- **Reusable assets:** the live tenant stack (`/tenant/onboard`, `/tenant/catalog`,
  `/tenant/orders`, `/webhook`, `/mpesa/stk-push`, tenant portal), the five built packs
  in `drops_assets/`, `/drops` with automatic delivery, `/build` for the service rung,
  and the discovery submissions already in the database.
- **Minimal slice:** one catalogue loaded, one test order, one invoice — 2–4 hours of
  data entry per client, no deploy.
- **Revenue:** the Founder's Package, KES 1,000/month per existing tenant (KES 3,000 for
  a new client), starting once a catalogue is loaded and one order has gone through;
  KES 1,500–12,000 per pack run alongside it.
- **Main risk:** the ask never happens, and the day is spent on code instead.
- **Next validation step:** a spoken yes on one call, and `digital_orders` moving off
  zero.

---

## 1. Start here: one command

```bash
npm run money:routine
```

Read-only. It prints exactly three things: **who do I call, who owes me, what do I
send**, plus which tenants have nothing to sell (the reason nobody is paying a monthly
fee). `npm run money:routine:json` is the same payload for another tool.

---

## 2. The rule that decides every action today

> If an action does not put a price in front of a person who already asked, or collect
> a payment already promised, it is not on today's list.

That rule deletes blog posts, new packs, the card lane, the Hashlist cards, the
brokered-data introductions and the 15-firm pass from today — all of them are correct
work with a 30–90 day clock, and none of them is a 24-hour rupee.

---

## 3. Hour 0: what must be true before you take a payment

1. **`npm run money:routine` says `settlement sandbox_refund`.** That is the truth of
   this deployment, and it is not a bug to hide — it is a rule to operate:

   > A paid order on a non-production shortcode is **delivered and owed**. The pack
   > opens, the receipt comes back, and Safaricom reverses the charge. The client is
   > never told why. **You are** — the order is stamped
   > `metadata.settlement = "sandbox_refund"`, the log line says
   > `DELIVERED BUT NOT SETTLED`, and the order appears in
   > `GET /api/drops/recovery?key=…` with a message ready to send.

   So: sell, deliver, and **treat every paid order as money still to be collected**.
   Collect it on a live channel (paybill/bank/cash) before you count it.

2. **Do the KES 1 self-test yourself** before you send a link to anyone: buy the
   cheapest pack with your own number. You want to see the prompt arrive, the pack open,
   and the order appear in the recovery list. If step three does not happen, stop and
   fix the lane — a buyer who pays and receives nothing is the one outcome this
   deployment cannot survive.

3. **Never message a cold contact from the bot.** A free-form message outside the 24-hour
   window fails and counts against the number's quality rating — that is what the
   10,212 `WHATSAPP_STATUS:failed` rows were. From the bot: template messages only
   (`npm run campaign:send`). To a person: your own phone.

---

## 4. Play A — the two calls (do these before anything else)

Each of these people filled in the discovery form, named a budget, chose `asap`, and has
never been called. One has an empty tenant waiting for them.

**A1 · Spreadmasters Ltd (Francis Kiarie, `254713793488`)** — already onboarded, **zero
products**. Budget `5-10k`, needs lead capture **and** payments. A Unilever distributor
already has stock lines; the catalogue is the whole sale.

**A2 · Online Trading (Marvin Budohi, `254112283253`)** — no tenant yet. Budget `10-25k`,
needs lead capture. Sells goods online; the WhatsApp line replaces an inbox.

What to say (voice note or call, not text — this is a first ask, not a broadcast). **The
price is the founder's rate, not a setup fee.** These people are invited acquaintances; the
offer is the KES 1,000/month Founder's Package (`docs/FOUNDERS_PACKAGE_TERMS.md`), and the
invoice waits until there is a catalogue and one order:

> Hi Francis, it's Saddy from Alphadome. You asked me for lead capture and M-Pesa for
> Spreadmasters about a week ago and I owe you an answer, so this is it.
>
> Your system is already set up with your name on it — what is missing is your stock
> list. Send me your 20 or 30 lines with prices before noon and I will load them, put
> your WhatsApp number behind it so orders come to you, and take one order end to end on
> your phone today so you can see it work.
>
> It is KES 1,000 a month for the businesses already in — the founder's rate, it is 3,000
> for anyone joining now. I am not invoicing you until the catalogue is loaded and that
> one order has gone through, because before that you would be paying for an empty shop.
>
> Can I start with your list?

Then the close, whatever they answer:

- **"Send me details"** → send `/founders-package.html` (priced, one screen) and, if they
  sell on WhatsApp already, the pack that matches the problem
  (`/drops/whatsapp-mpesa-checkout-kit`, KES 4,500). A pack is a sale today even when the
  package starts next month.
- **"Too expensive"** → that is already the founder's rate; the honest answer is "it is
  1,000 for you and 3,000 for the next person — I am not moving it, but I am also not
  invoicing until it has made you something." Do not discount below the rate; do defer
  the first month.
- **"Later"** → ask for one thing: "send me your stock list when you have it" and put
  the date in the reply. That is a follow-up with a reason, not a reminder.

**Warm, not cold:** `npm run tenants:campaign` prints the same offer, personalised with
each tenant's portal link and a one-tap `wa.me` hand-off, plus the proof message (the USD
566 Mercor figure) and the agent-lane message for day 2 and day 4. See
`docs/TENANT_CAMPAIGN_FOUNDERS_PACKAGE.md`.

Pass condition for the day: **one catalogue loaded and one order end to end** — that is
what turns the 1,000 into an invoice. A verbal "yes" without a catalogue is not a sale.

---

## 5. Play B — the packs, to people already in the funnel

The traffic exists and is measurable: ~932 "apply" clicks, 567 `apply_click` events, the
newest today. They are mid-application on an AI-work platform, which is exactly who the
**AI Work Application Kit (KES 1,500)** was written for: 159 people started an
application and only 22 finished it.

- **Send the product, not the shop.** `/drops/ai-work-application-kit` — one link, price
  on the page, M-Pesa prompt, pack opens immediately.
- **Add the bump in the same sentence:** the Build Log (KES 2,500) is offered at checkout.
- **Who to send it to today:** the nine priority inbound numbers in
  `leads/priority_inbound_non_kassangas.csv`, and anyone in the tenant contact list whose
  last message is inside the 24-hour window. Use your own phone for a personal note, or
  a template via the bot.
- **What to do when it sells:** the pack delivers itself; **you** then get the order in
  `npm run money:routine` under *TO CHASE*, and you collect it. That list is the whole
  point of section 3.

Three to ten sales is KES 4,500–15,000. Nothing else on the site converts faster,
because nothing else is aimed at a person mid-task.

---

## 6. Play C — Kassangas pays a fee, or it stays a favour

Kassangas is the only tenant with a real catalogue (24 products) and 105 payment
templates issued. The bot is alive and dormant since 30 October.

One call to Gideon, one sentence: **KES 5,000 for the month** to refresh the catalogue
and run **one** broadcast to his customer list with a pay link. Not free — free is why it
stopped. His list is the only list in this business that has ever transacted.

---

## 7. The rest of the day (small, in this order)

| # | Action | Pass condition |
|---|---|---|
| 1 | Reply to the 13 named conversations in `docs/WHATSAPP_INTENT_AUDIT_2026-11-12.md` §"the dozen conversations that were worth money" | every one answered, even with "still interested?" |
| 2 | Send `/build` to the two leads who said "send details" | proposal requested, not promised |
| 3 | Load one catalogue (the client who said yes) | test order visible in `/tenant/orders` |
| 4 | `npm run money:routine` before you sleep | numbers recorded, chase list empty or owned |

---

## 8. What "paid" means from now on

| Field | Where | Meaning |
|---|---|---|
| `gross` | `GET /api/drops/stats` | what the ledger booked — **not** income |
| `collected` | same | money that reached the paybill |
| `unsettled` + `recovery` | same | delivered and owed; the chase list |
| `settlement_mode` | same | which of the two today's payments will be |
| `metadata.settlement` | `digital_orders` | stamped per order at delivery |
| `DELIVERED BUT NOT SETTLED` | Render log | the operator's alarm line |
| `GET /api/drops/recovery?key=…` | API | the list, with the message to send |
| `settlement_pending` | `digital_events` | the audit trail of every owed order |

The client-facing message asks them to resend and promises the same-day confirmation. It
never mentions a sandbox, a refund, or a test mode: what happened on our side is ours to
fix, and what they need to know is that the pack is open and the payment has not arrived.

---

## 9. Explicitly not today

Hashlist cards and the data-set sample ($500–5,000, but 30–60 days and ToS §11 unread —
`docs/HASHLIST_EVALUATION.md`); brokered-data introductions (a three-messages-a-week
background action with a realistic 90-day outcome of $0); the card lane; the 15-firm
pass; new blog posts; the continuity rung. All correct, none of them a 24-hour rupee.

**Queued instead:** the *Offer Intercept* — the free Preflight capture and the KES 1,500
kit placed in front of the Apply redirect — is recorded as a Work_Anda agent card
(`utils/workAnda.js` → `WORK_ANDA_QUEUE`), beside OF Chatter, built to the same rule:
a worker fills, a human submits, nothing is asserted on a tenant's behalf.

---

## 10. Risks

| Risk | What is done about it | What is left |
|---|---|---|
| A buyer pays on sandbox and is refunded | Order stamped `sandbox_refund`; recovery list + message ready; client not told the plumbing | **you must chase it** — the system cannot collect |
| The WhatsApp number loses its quality rating | Follow-up automation defaults off; template-only sends | do not free-form message cold contacts |
| A pack sells to a non-Kenyan buyer | — | card lane is off; say so rather than take an order you cannot take payment for |
| A client is onboarded with an empty catalogue | `money:routine` lists every tenant with zero products | loading the catalogue is the deliverable, not an afterthought |
| The day is spent building | this document is the day's scope | the Offer Intercept is queued, not started |

---

## 11. The one-line version

Sell to the two people who asked, send the pack to the people who are applying, charge
Kassangas a fee — and treat every "paid" today as money still owed, because on this
deployment it is.
