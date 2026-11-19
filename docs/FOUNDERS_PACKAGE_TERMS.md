# Founder's Package — the agreement we offer a tenant

**Status:** draft for use from 2026-11-19 · **Not legal advice** · **Currency:** KES

This is the contract to put in front of the tenants already in the system. It is written
from the platform's own behaviour (`docs/TENANT_ONBOARDING_2026-10-25.md`,
`utils/workAnda.js`, `CLIENT_ONBOARDING_PLAYBOOK.md` §Support Tiers) and from the two
prices the founder set: **KES 1,000/month for tenants already in, KES 3,000/month for a
client arriving from now on.**

The Claude share and artifact links supplied on 2026-11-19 render client-side and returned
no text to a fetch, so this version is reconstructed from the repository plus those two
numbers. §9 lists the three clauses only the founder can settle.

---

## 1. Parties

**Provider:** Alphadome (Malingu Ventures), Nairobi. **Client:** the business named in the
discovery submission, acting through the phone number it registered.

The agreement starts when the client replies "agreed" on WhatsApp to the offer message, or
pays the first invoice, whichever is first.

## 2. Fee

| Client | Fee | Cadence |
|---|---|---|
| Already in the system before 2026-11-19 (founder's rate) | **KES 1,000** | per month, per business |
| Arriving from 2026-11-19 | **KES 3,000** | per month, per business |

- The fee is for the **system**, not for a volume of messages, orders or sales.
- **No invoice is issued until** the client's catalogue is loaded and one order has gone
  through end to end. Before that there is nothing to charge for.
- The first invoice covers the calendar month in which that order went through; the
  second month is billed on the same date each month.
- Collection is by M-Pesa to the provider's paybill, with the order or account reference
  quoted on the invoice. A receipt is issued for every payment.
- The founder's rate is a property of the client's account, not a timed promotion. It
  moves only if the client's account is closed and re-opened as a new business.

## 3. What the provider delivers

1. **WhatsApp sales line** — the client's number answering from the client's own
   catalogue, with a human hand-off where the system is not confident.
2. **M-Pesa collection** — a payment prompt to the buyer, a receipt per order, and a
   reconciliation reference that identifies the client.
3. **Tenant portal** — catalogue, orders, customers, abandoned carts, broadcasts, and
   Writer's Flow (blogger + research/outreach), on one sign-in link.
4. **Content engine** — pages generated for the client's offers, and the offer links they
   carry.
5. **The agent lane (Work_Anda)** — where the client is enabled for it, an agent fills
   applications on sites the client nominates. **The agent stops before submission; the
   client presses submit.** Nothing is applied for, agreed to, or represented on the
   client's behalf.

## 4. What the provider does not deliver

- **Any guarantee of sales, hires, income or ranking.** No figure in the sales
  conversation is a forecast; the USD 566 Mercor figure is a past result of the provider's
  own account.
- Custom development beyond the published scope (quoted separately, in writing).
- Third-party costs: Meta conversation charges, Daraja fees, ad spend, domains, hosting
  beyond the shared service.
- Legal, tax or licensing advice.

## 5. What the client delivers

1. A catalogue it has the right to sell: names, prices, stock, and images named by SKU.
2. One WhatsApp number it controls, and the Meta credentials for it (or the provider
   walks the client through getting them).
3. An answer within two working days when the system hands a conversation to a human.
4. Payment of the monthly invoice.

An empty catalogue is the client's blocker, not the provider's: the fee starts only once
one exists, and the system cannot sell from a shelf it was never given.

## 6. Term, cancellation and refunds

- **Month to month.** No minimum term.
- Cancel with **seven days' notice** before the next billing date, on WhatsApp, in
  writing. Access continues to the end of the paid month.
- On cancellation: the portal closes, the WhatsApp line stops answering for that client,
  and the client's data is exportable on request for **30 days**, then deleted.
- **No refund** for a month already begun. If the provider fails to deliver a listed item
  for a full month, that month is credited.

## 7. Data, accounts and reputation

- The client's catalogue, orders and customer conversations belong to the client.
- The provider stores them to run the system, does not sell them, and does not join them
  across tenants.
- Credentials are stored per tenant and never used to act on another client's account.
- **Agent lane:** the client's own accounts stay the client's. The agent fills, the client
  submits. Where a marketplace's terms forbid automated submission (as ChatterApply's and
  OneForma's do), the system deliberately does not submit.

## 8. Support

Community tier, per `CLIENT_ONBOARDING_PLAYBOOK.md` §Support Tiers: WhatsApp and email,
first response within **24–48 hours**, covering how-to questions and faults in the
listed items. Excluded: urgent hands-on work, customisation, and anything that is a new
feature. Priority support is a separate agreement.

## 9. Three clauses only the founder can settle

These were not in the material I could read, and each one changes what the client is
buying. Decide them before the first message goes out, because the activation message
already quotes the price:

| # | Question | Consequence if left open |
|---|---|---|
| 1 | Is the founder's rate **permanent** or **12 months, then KES 3,000**? | A tenant who assumed permanent will treat a later increase as a breach |
| 2 | Is the **agent lane included** in KES 1,000, or an add-on? `utils/workAnda.js` calls it "a paid upgrade" | Two documents disagreeing, in front of the customer |
| 3 | Does a **payment on the platform** (M-Pesa collection for the tenant's own sales) carry a platform fee, or is the monthly fee the only charge? | The biggest ambiguity for a tenant who starts selling — decide before the first real order |

## 10. Signature block (WhatsApp is enough)

> I accept the Founder's Package for **{{business}}** at **KES {{fee}}/month**, on the
> terms above. I understand the system does not guarantee sales or income, and that agent
> applications are submitted by me.
>
> Name: {{name}} · Phone: {{phone}} · Date: {{date}}

The reply, kept in the conversation, is the contract. A PDF copy is issued on request.

---

## 11. Why it is written this way

- **The invoice waits for the catalogue.** The honest reason a tenant would refuse to pay
  is that they have nothing to sell yet — so the fee starts after the first order, not
  before. That is also what makes the ask credible to an acquaintance.
- **No income promise, anywhere.** The repo's own tests refuse copy that guarantees
  income (`scripts/test_digital_drops.mjs`, the build page). A friend who is promised
  $450/month and does not get it is a lost friend, not a lost customer.
- **The agent stops at submit.** That is the line the browser-actor work has held since
  October (`OPEN_FLAGS` #53, #56), and it is the one a tenant's reputation depends on.

