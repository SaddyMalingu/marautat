# Hashlist / DOP — evaluation and revenue projection

**Written:** 2026-11-19 · **Decision:** what we sell, what we must not upload, and whether
this displaces Alphadome work · **Sources:** hashlist.com, dop.hashlist.com (signed-in
pages pasted 2026-11-16/18), and three independent directories (paidtaskers.app,
aiworkexpert.com, aitrainingboard.com) checked 13–18 Nov 2026

---

## 1. Who they actually are

| Fact | Value |
|---|---|
| Legal entity | **Gigarator Oy**, Business ID 3153482-2, Eteläesplanadi 2, 00130 Helsinki, Finland — trades as Hashlist |
| Founded | 2020 (spacejobs), DOP contributor platform launched ~**18 Oct 2026** |
| Business | Custom evals, data sets and RL environments for **embedded engineering**; sells to frontier labs |
| Named clients | Stellantis, Toyota Motor Europe, Applied Intuition, MobileDrive, Foxconn |
| Credentials | NVIDIA Inception member; claims 100,000+ registered domain engineers |
| Public benchmark | ConstraintBench v1.3 — 50 tasks, 13 models, chip design / RTL / CAD / embedded coding, pass rates 1–57% |
| Contributor ToS | Last updated **25 Sep 2026**; §3 eligibility, §9 payouts, **§11 who owns your work**, **§13 which files you may use**, §16 tax |

**Domain verdict:** their entire public corpus is chip design, RTL, CAD, embedded coding
and automotive. Our material is a Node/Express multi-tenant SaaS with WhatsApp and M-Pesa.
We are outside their stated domain, and their data-set product page says so explicitly:
*"operational engineering data — real projects from engineering firms."*

## 2. What the terms say (and what we could not read)

The ToS is served by a JavaScript app: `hashlist.com/terms`, `/legal`, `/privacy` and
`dop.hashlist.com/terms` all return the homepage or a 4 KB shell, so **the text of §11
and §13 has not been read**. What is established from reviews and the platform's own copy:

| Point | Evidence |
|---|---|
| Publishing puts the task **into a data set** | platform copy: *"Accepted. The task joins a data set, and your pay goes to your balance"* |
| They license data sets to labs | product 02: *"Off-the-shelf data … licensed and ready to train on"* |
| **§11 governs who owns your work**, **§13 which files you may use** | aitrainingboard: *"Read sections 11 and 13 … before you upload a project"* |
| Their files rule bars third-party code | *"Hashlist's terms bar your employer's code and data. Build your work from files you own or may share"* |
| Pay is fixed at the brief's amount; a reviewer may credit a *different* amount for partial fulfilment; **a rejected task earns $0** | ToS summary via three directories |
| Payout | Stripe / PayPal / IBAN, reviewed and sent by hand, ~10 business days, **$50 minimum may apply**, W-9/W-8BEN/VAT, credits reversible **180 days** |

### The consequence nobody mentions

If §11 is an **assignment** (or an exclusive licence), then a card we publish cannot also
be sold by us. That breaks the "one artifact, three buyers" plan I wrote in
`docs/HASHLIST_TASK_PACK.md` — which assumed non-exclusive reuse. Until §11 is read,
**the honest position is: a published card is spent.** Either read §11 first, or write
cards from incidents we are willing to give away.

## 3. What is actually on sale right now

| Route | Live in this account | Pays |
|---|---|---|
| 6 engineering task briefs ($300/accepted) | **not open** — they were the Oct 19 batch | $300/task when a brief is open |
| Screen recordings (Blender, 3D, video) | open | $60/hr + $15/hr narration — **we cannot do this work** |
| Hardware / PCB / Electrical (custom) | open, 6 trials, 3 models | custom rate — we have no PCB work |
| **Interview Task (Embedded Systems)** | open | **$0 per successful submission** |
| **Data set — "send us a sample"** | open | **$500–$5,000 sample fee**, then 10% after batch 1, balance on completion, ~8 weeks |
| Referrals | open | **$200** on first accepted task, then 20% of their pay, cap $400 → **$600 max** |

**This is the single most important finding.** The only per-task route visible in the
account today pays **$0**. The paid route that is open is the **data set**, and the
cheapest reliable money is **referrals**. The `$300/task` that reviews quote belongs to
briefs that are no longer listed.

---

## 4. Asset risk register — what we could lose

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **§11 is an assignment**, so a published card can never be sold by us again — including as a KES 2,500 Build Log chapter | **High** | Read §11 in the signed-in terms *before* publishing. Until then publish only cards we are willing to spend |
| 2 | **§13** permits only files you own or may share; our repo is company work but the account signs as an individual | **High** | Decide the owner once — personal *or* company — and give the same answer in the DOP and the data-set form |
| 3 | Their rule bars *"your employer's code and data"*, NDA material and export-controlled files | High | Never upload `server.js`, `routes/`, the browser-actor worker, tenant rows, `conversations`, client NDAs |
| 4 | Rejected task = **$0**, a reviewer may credit a *different* amount, credits reversible **180 days** | Medium | Never bank unaccepted work; acceptance is the only event that counts |
| 5 | Three live roles, one reviewer, a short record (first briefs Oct 18) | Medium | Publish only the strongest card (005). A weak card spends the relationship, not just the task |
| 6 | Our material is out of their domain (chip/RTL/CAD/embedded) | **High** | Don't force it. Use the cards for the data-set sample; go after brokered data for the upside (§6) |

**The line that protects us:** the repo is the system of record — `dop/tasks/<id>/` with
`provenance.md`, `grader.mjs`, `steps.md` and `gold.py`. Whatever we upload, we can rebuild
our own pack from it — *unless* §11 assigns the work itself. That is why §11 is the first
thing to read, not the tenth.

## 5. Revenue projection, 90 days

Assumptions, so they can be argued with: **1 USD ≈ 129 KES**; data-set sample fee
$500–$5,000 but our volume is 3–5 tasks so the low end is realistic; $300 brief-paid tasks
exist only while a brief is open; referrals convert when the introduced author's first task
is accepted; drops at 10 × KES 1,500/month; one Alphadome pilot ≈ KES 75,000.

| Lane | Basis | Low | Base | High |
|---|---|---|---|---|
| Data-set sample (our cards) | $500–$1,500, 40% acceptance | $0 | $750 | $1,650 |
| Paid tasks ($300) | only if a brief opens; 0–3 accepted | $0 | $300 | $900 |
| Task submissions, $0 route | publication only | $0 | $0 | $0 |
| Referrals | $200 + share, 1–2 accepted authors | $0 | $200 | $400 |
| Drops (existing) | KES 1,500 × 10/mo over 90 days | $300 | $450 | $750 |
| Alphadome pilots (existing) | KES 75,000 per deployment | $0 | $580 | $1,160 |
| **Total** | | **$300** | **$2,280** | **$4,860** |

**Per hour, honestly:** the DOP lane is ≈20 hours (3 cards finished, 2 converted, sample
packaged, submission written). Base is $1,250 ÷ 20 h ≈ **$62/h**; Low is **$0/h**; High
≈ $147/h. A client pilot is ≈$72/h at far lower variance *and* compounds into a retainer.
DOP matches client work in the base case, loses badly in the low case, and never compounds.
What changes the maths is not more cards — it is the referral link (no production cost) and
access to firms that own real engineering data.

## 6. The asymmetric play: our asset is access, not prose

Their product list contains **"Data partnership — license my company's data, profit
sharing model"**, and their data-set form offers **"I can introduce the owner"**. That is
the highest-value lane open to us, because it pays for *access*, not for writing:

- Kenyan firms hold genuine operational engineering records: solar and energy EPCs, water
  utilities, manufacturers, automotive workshops, cold-chain installers — commissioning
  punch lists, 8D and warranty reports, PLC code, calibration data, field-incident logs.
  Those are exactly the categories in their form (Industrial and robotics · Quality and
  safety · Test and measurement).
- We already run the machinery to reach them: ABOSS queues, the WhatsApp lane, the drops
  funnel. That is a sales asset; the cards are a writing asset. The sales asset is rarer.
- "I can introduce the owner" means we can submit an introduction without owning the data,
  and negotiate a share of the licence.

A 6–12 month play, not a 90-day one — and the only route here with a five-figure ceiling
that does not require us to become embedded engineers.

## 7. Decision

1. **Alphadome stays the revenue engine** — drops, pilots, the cron, the product. Cap DOP
   at **≤15% of working time**.
2. **Do not publish 004 or 001.** They are worth more as the data-set sample than as $0
   submissions, and every publication risks §11.
3. **Read §11 and §13 first**, in the signed-in terms or by asking through Messages.
   One question: *"If I publish a task, do I assign copyright or grant a licence — and may
   I reuse that same task commercially elsewhere?"*
4. **Then publish 005 only**, and only if §11 permits reuse. If it assigns, accept that 005
   is spent and price it as a $300-or-nothing bet, not as an asset.
5. **Run the referral lane now** — the only income here with no production cost and no IP
   exposure.
6. **Open one brokered-data conversation** with a firm that owns engineering records.

### Kill criteria

Stop investing in DOP cards if, by **2027-01-31**, all three hold: §11 assigns (or cannot be
read), no suitable brief has opened, and the sample is rejected or unanswered. The cards then
stay in the repo as Build Log material, and the time goes to drops and pilots instead.

### What this does not change

Everything already built remains correct and is not wasted: the four-command pipeline
(`dop:proof`, `dop:package`), the three calibrated cards, `gold.py`, the entry sheets, and
the honest data-set description. The work is real; the question is only how much of it we
give away, and at what price.


