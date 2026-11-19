# The tenant campaign — what they get on WhatsApp, and in what order

**Written:** 2026-11-19 · **Offer:** Founder's Package, KES 1,000/month (tenants already
in) / KES 3,000/month (new client) · **Contract:** `docs/FOUNDERS_PACKAGE_TERMS.md`

## 1. The situation this is written for

The twelve active tenants are people the founder invited personally, and they arrived
through the discovery form. Eleven of them have **an empty catalogue** (`npm run
money:routine` lists them), which is why nobody is paying: there is nothing to sell, so
there is nothing to charge for.

So the campaign is not a price announcement. It is, in order: **here is your workspace →
here is the thing that earns → here is the agent lane → the fee, once there is something
on the shelf.**

## 2. How to deliver it (this is the part that fails if done wrong)

| Channel | Works today? | Rule |
|---|---|---|
| **`wa.me` hand-off from your own phone** | **Yes** | One tap per tenant. The text is pre-filled. This is a person-to-person message, which is exactly what an acquaintance expects |
| Bot free-form send | **No** outside 24h | 10,212 `WHATSAPP_STATUS:failed` rows already exist for this reason (`docs/WHATSAPP_INTENT_AUDIT_2026-11-12.md`) |
| Bot template send (`npm run campaign:send`) | Only with an **approved Meta template** | `bot_templates` holds 0 rows today; a template must be created and approved first |

`npm run tenants:campaign` prints every message and its `wa.me` link. Nothing is sent.

```powershell
npm run tenants:campaign                      # all tenants, all five steps
npm run tenants:campaign -- --step activation # what to send today
npm run tenants:campaign -- --csv > tenants.csv
```

**The send desk** — one page, one button per tenant, ordered so the first message has a
concrete deliverable. Nothing on it sends by itself; the tick boxes are kept in the
browser so you can see what is left.

```powershell
npm run tenants:campaign -- --step activation --html leads/send_desk.html --first 254713793488
# then open leads/send_desk.html — each card has "Open in WhatsApp" and "Copy message"
```

## The file carries portal sign-in tokens, so `leads/send_desk_*.html` is git-ignored: delete
it after the round, and rotate any token that leaks
(`POST /admin/api/tenants/:id/portal-link`).

### What actually happened on 2026-11-19

**Delivered 2026-11-19, from Alphadome +254 786 817637** (quality GREEN), using the approved
alphadome template:

| Number | Tenant | Meta's verdict |
|---|---|---|
| 254702245555 | Kassangas Music Shop | DELIVERED |
| 254706291262 | joska Sportiff Academy | SENT |
| 254799721460 | Malingu Global | DELIVERED |
| 254748621563 | Insight chess club / Coach Dawn 3.0 | SENT (one message — deduped) |
| 254707459359 | Sales and marketing | SENT |
| 254743383192 | Faraja | DELIVERED |
| 254759091491 | Malingu shambas | SENT |
| 254713793488 | Spreadmasters ltd | DELIVERED |
| 254741859390 | lifeline Inc. | FAILED 131026 — not on WhatsApp |

**8 of 9 reached a handset.** The first attempt an hour earlier reached none: every message was
accepted and then dropped with 131042, because the WhatsApp Business account had no valid payment
method. The card is now on the account, and the same command delivers.
Two findings worth keeping:

1. **A `wamid` is not a delivery.** The sender now prints `ACCEPTED` on the API response
   and, with `--verify`, reads the status callbacks and prints `DELIVERED`/`FAILED` with
   Meta's code. The first version of this tool said "sent 9 of 9" and none arrived.
2. **The approved template `alphadome` takes no variables**, so it cannot carry a name or
   a portal link. Personalisation has to happen in the reply, inside the 24-hour window
   a reply opens.

Also verified: `WHATSAPP_BUSINESS_ACCOUNT_ID` in `.env` is a **business portfolio id**, not
a WABA id (`owned_whatsapp_business_accounts` → `403 Requires business_management`), so the
template list cannot be read — an explicit `--template` name is sent with Meta as the
authority, and a wrong name fails with `132001`/`132000` without delivering anything.


`npm run wa:send` does it from the platform's own WhatsApp number, with that tenant's
name, business and portal link as template parameters:

```powershell
npm run wa:send                          # preflight: which number, quality rating, approved templates
npm run wa:send -- --to 254713793488     # one recipient, still a dry run
npm run wa:send -- --apply               # send the approved template to every active tenant
```

It needs `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID` and (to list templates)
`WHATSAPP_BUSINESS_ACCOUNT_ID` in `.env` — the same values the server uses, which live on
Render.

**It is template-only on purpose.** Meta permits free-form text only within 24 hours of
the recipient's last message; these tenants last wrote months ago, so a text send returns
`131047` and counts against the number's quality rating — the rating the 10,212
`WHATSAPP_STATUS:failed` rows already strained. When no template is approved, the script
prints the exact body to create and exits without sending anything.


## 3. The five messages, in order

| Day | Step | What it says | What it is for |
|---:|---|---|---|
| 0 | `activation` | Your workspace is live, here is the link, two things to do, and the fee — **with the invoice explicitly deferred until a catalogue exists** | Gives before it asks |
| 2 | `proof` | The Mercor USD 566: "this is not a bot that replies, it is a system that earns" | Answers "why would I pay for this" |
| 4 | `agent` | AI-task and chatter work, chatter roles advertised around $450–600/month, the agent fills and **you press submit** | The urgency, without a promise |
| 7 | `nudge-1` | "Still holding your workspace open" — offer to load the catalogue from a photo | Removes the real blocker (their time) |
| 12 | `nudge-2` | "Last one from me; reply 'go' and it is a two-hour job" | Closes the loop honestly |

The copy lives in `utils/founderOffer.js`; the tests assert it never promises income.

## 4. What to attach

Do not attach a deck. Send **links**, because a link survives being forwarded:

| What | Where | Why it is the right artefact |
|---|---|---|
| The offer, priced | `/founders-package.html` (`public/founders-package.html`) | One screen: 1,000 / 3,000, what is included, what is not |
| The engineering proof | `/drops/repo-build-log-2026` | 77 KB of real incidents with dates — the thing that makes "we can build this" credible |
| The service rung | `/build` | For the tenant who asks for more than the fee covers |
| Their own portal | `/tenant-dashboard?t=<portal_token>&phone=…` | Personal, password-less, and already minted for most tenants |

`tenants:campaign` prints the portal link per tenant, and flags the ones with **no portal
token** — issue it first with `POST /admin/api/tenants/:id/portal-link`, or the message
promises a link it does not have (the copy already degrades gracefully if you send it
anyway).

## 5. The new-client campaign (KES 3,000)

Same machine, walk-up price. Run it at the people who filled the form but are not tenants,
and at traffic from `/discovery`:

- The founder's rate is mentioned **once**, as a fact about a list that is closed — never
  as a discount to negotiate against.
- The close is not the price, it is the demo: **"send me your price list and I will put one
  order through end to end on your own number, same day."**
- The message is `newClientMessage()` in `utils/founderOffer.js`; `tenants:campaign`
  prints it for every non-tenant submission at the end of its output.

## 6. What "worked" looks like (measure these, not replies)

| Step | Signal | Where |
|---|---|---|
| Activation sent | portal link opened | `analytics_page_views` on `/tenant-dashboard` |
| Catalogue | products loaded per tenant | `bot_products` count — `npm run money:routine` §TENANTS |
| First order | an order exists | `/tenant/orders` (`bot_orders` is 0 today) |
| First shilling | invoice paid | `subscriptions` with the founder's-package amount |
| Agent lane | an application filled | `browser_actor_runs`, `apply_runs` |

A reply is not a signal. A loaded catalogue is.

## 7. The rules this campaign keeps

1. **No income promise.** Not "$450 a month", not "guaranteed hires". The Mercor figure is
   the platform's past, quoted with its source.
2. **No invoice before value.** The fee starts after one order; the copy says so.
3. **No bot for a friend's first message.** A human sends it, from his own number.
4. **The agent never submits.** It fills; the tenant presses submit. Where a marketplace
   forbids automated submission, the system does not submit at all.
