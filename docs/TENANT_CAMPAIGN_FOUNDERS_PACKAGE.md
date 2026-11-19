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
