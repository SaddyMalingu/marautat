# The 24-hour playbook — what pays today, in the order it pays

**Written:** 2026-11-19, after the campaign landed and the first inbound messages arrived.
**Rule this document follows:** every line must be executable inside one day by one person,
with code that already exists. Anything that needs a marketplace approval, a Meta review, or
a client's calendar is in §6, not here.

## 1 · The perishable asset: open WhatsApp windows

Meta allows free-form text only within **24 hours** of the person's last message. Inside that
window a reply is free, instant, and can carry a link, a price and a portal token; outside it
only an approved template gets through, and the only approved one here (`alphadome`) takes no
variables.

**`npm run wa:window`** lists exactly who is inside a window right now, what they said, and a
draft reply with their own portal link. Today that is four numbers — the first real
conversations this system has had.

**This is the highest-value hour of the day**, because a window that closes cannot be reopened
without a new template.

## 2 · The seven who clicked the pack and bought nothing

`analytics_clicks` holds 7 `kit_offer` clicks in seven days and `digital_orders` holds 0. Three
of those clicks are my probes; the rest are people who pressed a button that said
*AI Work Application Kit — KES 1,500*.

That is not a traffic problem. It is one message each:

> You looked at the kit — send KES 1,500 and I'll open it for you now. If the application is
> what is stuck, send me the role and I'll finish it with you today for KES 3,500.

Which introduces the second rung.

## 3 · Sell the service, not the pack — the outside-the-box rung

The pack is a file. The thing people actually want is **the application finished**. That is a
service with a 30–45 minute delivery, priced above the pack, and it sells on the same traffic:

| Rung | Offer | Price | Delivery |
|---|---|---:|---|
| 1 | The AI Work Application Kit (file) | KES 1,500 | instant, automated |
| 2 | **Application finished with you** — one role, one call, submitted by them | KES 3,500 | 45 min |
| 3 | **Done for you** — 10 roles applied to, drafts prepared, human submits | KES 7,500 | same day |
| 4 | The funnel build (`/build`) | from $3,000 | scoped |

Rung 2 and 3 cost nothing but time, are deliverable today, and are the reason a buyer would
pay 5× the pack. The rule that keeps them safe is the one this repo already holds: **the agent
fills, the human submits** (`OPEN_FLAGS` #53/#56).

## 4 · Kassangas: the only shop that can actually transact

24 products, a live number, 105 payment links issued, and zero orders. One order end to end is
the demo every other tenant is sold with — and the first invoice (KES 1,000) rests on it. A
flash sale to their own customers, agreed with Gideon, is the cheapest way to produce it.

## 5 · The 11 empty shelves

Every "yes" dies at "send me your price list, I'll type it in". `npm run catalog:import` made
that ten minutes. The move is to ask each tenant for **one photo** of their list, load it the
same hour, and tell them the shop is live — that is the sentence that starts a fee.

## 6 · Not today, and why

| Play | Why it waits |
|---|---|
| Mercor / Micro1 / Turing referral commissions | pay on hire, 30–90 days, and $566.32 is the whole history |
| Hashlist cards and the data-set sample | $500–$5,000, but 30–60 days and ToS §11 unread |
| Brokered-data introductions | a three-messages-a-week background action; realistic 90-day outcome $0 |
| The card lane, the 15-firm pass, new blog posts | correct work, none of it lands money today |
| Running the chatters' shifts with an agent | that is `OPEN_FLAGS` #53/#56 with a different platform; draft-and-send only |

## 7 · The arithmetic for today

| Line | Realistic in 24h |
|---|---|
| 4 open windows answered → 1 catalogue + 1 order | KES 0 today, KES 1,000/month starts |
| 4 pack clicks converted (of 7) at KES 1,500 | KES 6,000 |
| 1 service sale at KES 3,500 | KES 3,500 |
| **Total** | **≈ KES 9,500**, and the first fee month begins |

That is not a jackpot. It is the first day the system is paid anything at all — which is the
only number that has ever been zero.

## 8 · The tools, in the order to run them

```powershell
npm run hunt                      # today's ranked actions, from live data
npm run wa:window                 # who is inside a 24h window, with a draft reply
npm run money:routine             # who owes, who to call, what to send
npm run tenants:campaign -- --step proof   # the day-2 message to the silent ones
npm run catalog:import -- --tenant <phone> --from prices.txt   # a list becomes a shelf
```
