# What we sell on the data-operations platform

**Written:** 2026-11-18 · **Horizon:** first accepted submission inside 7 days ·
**Status:** two cards packaged and green, three more one sitting each, one dataset
description written but not submitted

**Verdict up front:** we have exactly one thing this platform wants, and it is not a
data set. It is the DOP cards in `dop/tasks/` — real defects, dated log evidence, a
golden answer, realistic near misses, and a deterministic grader. Two are packaged
today (`npm run dop:package` → `dist/hashlist/`). The same artifact is also a chapter
of the Build Log pack we already price at KES 2,500, so the work is sold twice and
invented once.

---

## 1. The platform, as it actually pays

Four surfaces on the dashboard, and only two of them are reachable for us.

| Surface | What it wants | Terms as published | Reachable? |
|---|---|---|---|
| **Writing a task** (core) | One job from your own working week, written as prompt + files + gold + near misses + scored steps, published after Proof | Pay lands on balance per accepted task, paid weekly by Stripe. The embedded brief on the board shows **$0 / successful submission** | **Yes** — this is the lane |
| **Sell a data set** | Engineering work the company already did, in batches | Sample fee **$500–$5,000** on acceptance, then a licence, then ~8 weeks of batches, claimed ceiling $100k | **Partly** — small but real |
| **Recorder briefs** | 20–40 min screen recordings in Blender / 3D / video editing at **$60/h**, +$15/h narrated; Hardware-PCB custom at custom rate | Paid on acceptance, active time only | **No** — we do not do that work, and the briefs reject anything under 5 minutes of real activity |
| **Referrals** | Your signup link; the person you introduce does the work | **$200** when their first paid task is accepted, then 20% of their earnings up to $400 more | **Yes** — and it is the cheapest money on the page |

Two things follow immediately:

1. **The embedded "Interview Task" brief is not a revenue line.** It is listed at
   $0 per successful submission and 4.1–5.5 h of effort. Your drafted task
   (`task-mvh74zkd`, 28 days old, still Draft) is 80% of that shape and worth
   finishing only because it *publishes* — publishing is what a buyer sees.
2. **Referrals are the only lane that pays before we write anything.** We already
   run a lead engine (ABOSS queues, WhatsApp broadcast, the drops funnel) aimed at
   exactly the people who would write these tasks: developers who want paid remote
   work. Three accepted authors is $600 for two messages we already know how to send.

---

## 2. What we own, per surface

| Surface | What we already have | Honest size | Ready today |
|---|---|---|---|
| Tasks | 5 real incidents with commits and logs; 2 cut into full cards | 2 cards × 8 steps / 19 points | **Yes** (packaged) |
| Data set | The same cards plus the offline suites behind them: **53 test scripts** (`scripts/test_*` + root), **70 migrations**, **588 commits** 2026-02-12 → 2026-11-18 | A sample of ~6 tasks, a few hundred KB — not 3,200 tickets, not 40 GB | Partly |
| Referrals | Drops storefront (5 published packs, KES 1,500–12,000), WhatsApp lane, ABOSS outreach CSVs | Existing machinery | **Yes** |
| Recorder | — | We do not do Blender/3D/video work | No |
| Hardware / PCB / firmware | — | No PCB, no motor controllers, no CAD | No |

The difference between the first two rows is the whole argument of this document:
**we can sell a task today and a data set only after we have several tasks.** The
task programme is the on-ramp to the data-set programme, not a detour from it.

---

## 3. One artifact, three buyers

The same card earns three different ways, and none of them require new engineering:

| Buyer | What they pay for | Price | Cycle |
|---|---|---|---|
| The platform's reviewer | One accepted task on your balance | Per accepted task, weekly Stripe (only published figure on the board is $0 for the embedded brief) | Days to weeks |
| The platform's data team | The same cards batched, plus the logs and test output behind them | **$500–$5,000** sample fee, then licence + batches | 1–2 weeks per step |
| Our own drops buyer | The Build Log chapter the card was cut from | **KES 2,500** ≈ $19 at ~129 KES/USD | Same day, M-Pesa |

Arithmetic, because the repo's rule is arithmetic and not forecasts: one accepted
sample at the bottom of the band (**$500**) is about **43 sales** of the KES 1,500
kit, or **26** of the KES 2,500 Build Log. One accepted task at the platform's
per-task rate is worth more per hour than any pack, because a pack is written once
and priced once while a card is written once and sold three times.

---

## 4. The inventory: five incidents, two cards, three to go

Every row is a shipped commit with dated evidence. Nothing here is a reconstruction.

| ID | Incident | Commit | Evidence | Card | Status |
|---|---|---|---|---|---|
| DOP-001 | AI slugs that answer with silence, not a 404 | `54931a41` | production log, provider notes | `tasks/001-silent-ai-slug/` | shipped, **packaged** |
| DOP-002 | WhatsApp replies did not use the platform provider chain | `facc1404` | `ENOTFOUND api.openrouter.ai`, 06:36 | — | shipped, card pending |
| DOP-003 | A slow Gemini alias was treated as an outage | `5f67bef4` | `aborted after 15.0s`, no 429 anywhere | — | shipped, card pending |
| DOP-004 | Valid keys invisible under the spellings the dashboard received | `1436ef23` | boot log `groq=false openrouter=false` while the keys existed | — | shipped, card pending |
| DOP-005 | Every visitor recorded from `::1` | `586ec2f0` | `logs/bot.log` page lines, 2026-04-18 → 2026-10-24 | `tasks/005-trusted-proxy-ip/` | shipped, **packaged** |

Both packaged cards score **1.000 golden (19/19)**, with the best near miss at
**0.263** — under half, so the task separates a real diagnosis from the standard
advice. DOP-002/003/004 are the same three files plus a grader each; the prompts are
already written in `dop/PROGRESS.md`.

---

## 5. The pipeline

Two commands, and neither invents anything.

```bash
npm run dop:proof        # every card: golden = 1.000, each near miss < 0.300, repeatable ×3
npm run dop:package      # writes dist/hashlist/<card>/ in the upload layout
```

What `dop:package` produces, and why in that shape:

| Packaged path | Comes from | Why |
|---|---|---|
| `agent/PROMPT.md` | `question.md` | the prompt as the job arrived, with the answer-file shape |
| `agent/CONTEXT.md` | generated | the environment and file map, no outcome strings |
| `files/` | `files/` verbatim | the evidence the model is allowed to see |
| `references/gold.json` | `answer.json` | the golden set answer |
| `references/naive_*.json` | `naive.json`, `near-miss-*.json` | the wrong answers a capable colleague gives |
| `references/checks.md` | `checks.md` | the scored steps as outcomes with points |
| `references/bands.json` | read out of `grader.mjs` | the same steps as data, so the reference cannot drift |
| `PROVENANCE.md` | `provenance.md` | claim → commit, for the reviewer |

Three guards run on every package, and each one fails the build: the grader is
**not** copied into the task folder (a model must not read the marking script), a
redaction scan refuses emails, M-Pesa numbers, bearer tokens and provider keys, and
the golden/near-miss separation is re-checked from the grader itself.

---

## 6. The data-set form, filled with the truth

The draft in the account reads *Firmware defect tracker, motor controllers · 3,200
records · 40 GB · 2017–2024 · 120 employees · 42 engineers*. Every one of those
numbers is false for this repo, and the flow is built to catch it: step 2 asks for
**~1% of the data set** (~32 tickets that do not exist) and the licence warrants
that you own it.

This is the honest submission. It is smaller, and it survives review.

> **Name:** Engineering-defect task packs from a live multi-tenant WhatsApp + M-Pesa platform
>
> **Type of data:** Defect tickets with fixes · Test logs · Requirements traced to code
>
> **Domain:** Node/Express multi-tenant SaaS; WhatsApp Cloud API; Safaricom Daraja
> (M-Pesa STK); LLM provider fallback chains; observability and multi-tenant isolation
>
> **Owner:** I own it personally and can sign
>
> **Size:** 5 incidents (2 complete as tasks, 3 in progress); 8 evidence files;
> ~40 KB packaged; each task carries a golden answer, 3 near misses, 8 scored steps
> and an offline grader
>
> **Produced from:** 2026-02 · **Produced to:** 2026-11
>
> **Company size:** 1 · **Contributors:** 1 human author, AI-assisted drafting
>
> **Samples:** the packaged folders in `dist/hashlist/`

Two sentences do the work there: *"I own it personally"* and *"AI-assisted
drafting"*. The first is a warranty, so it must be true. The second is disclosure;
it costs nothing now and everything later if it is found rather than declared.

---

## 7. What we must not sell

Four things look like inventory and are not. Each has a specific reason.

| Temptation | Why not | What to do instead |
|---|---|---|
| **Source code with its history** (the 670 KB `server.js`, `routes/`, the browser-actor worker) | This is the product. Selling history to an agent trainer is funding the competitor who will rebuild it, and the tenant-isolation and M-Pesa work is the moat. | Sell the *reasoning*: defect → diagnosis → rule → grader. That is what a card is. |
| **The WhatsApp conversations table** | 11,869 rows, of which 792 are inbound messages from **83 identifiable people**, including one number in a 100%-failure loop since 2026-08-06. Third-party personal data, not ours to licence; redacting it leaves nothing. | Nothing. Delete the line in `dop/README.md` that maps conversations to the sample channel. |
| **The firmware draft in the form** | It asks for 3,200 motor-controller tickets and a sample of ~32 of them. We have none. | The honest description in §6. |
| **AI-generated tasks** | The platform's rule is explicit: AI may draft wording, may not supply the engineering, and all-AI submissions are declined automatically. | `provenance.md` in every card states exactly what was human and what was drafted. |

## 8. Domain fit: the risk nobody mentions on the form

The board's curated briefs lean **embedded, hardware, PCB, PLC, robotics** — the
example environment is five front radars with range complaints and 22 files of
`.npz` captures. Our incidents are web-platform software: a provider fallback chain
and a proxy address. Two different bets:

* **Against us:** a reviewer comparing our card to the radar example may see a much
  thinner environment — no datasheet, no binary captures, no measurements.
* **For us:** every coding agent is trained to debug servers, and a task where the
  answer is *"the value you would have chosen makes the analytics forgeable"* is
  exactly the reasoning a code model gets wrong. The task page says the rule is
  "a job from your working week", not "a job in embedded".

So the first submission is a **fit test**, not a revenue event. That is why it goes
on the card that is already perfect rather than on a new invention.

## 9. Seven days

The tickable version of this table, with the source line to re-word each answer field
from, is `dop/UPLOAD_CHECKLIST.md`. Use that when you are actually in the app.

| Day | Action | Pass condition |
|---|---|---|
| 1 | `npm run dop:proof` and `npm run dop:package` | 2/2 cards packaged, both golden 1.000 |
| 2 | Re-read `answer.json` for both cards and put the prose in your own words | you can defend every sentence to a reviewer |
| 3 | Create the task in the app: upload `agent/PROMPT.md`, `files/`, build the 8 steps, tick the near misses, press Proof | Proof passes inside the app, not just locally |
| 4 | Publish 005, submit 001 behind it | Published page shows 8 scored steps and 19 points |
| 5 | Send the referral link to three developers through the existing WhatsApp lane | one signup |
| 6 | Submit the §6 data-set description with the `dist/hashlist/` folders as samples | reference number |
| 7 | Cut DOP-004 (env spellings) from its PROGRESS row | `npm run dop:proof` goes to 3/3 |

The only irreversible step is day 3–4: publishing makes the task visible. Everything
before it is local and reversible.

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Published task rejected on the "no AI-generated" rule | High | `provenance.md` names what was human; the answer prose is rewritten by hand on day 2 |
| Reviewer finds the environment too thin | Medium | Lead with the log evidence, which is real and dated; keep `files/` to what an engineer would have open |
| PII slips into a sample | High | `dop:package` refuses emails, M-Pesa numbers, tokens; nothing from `conversations` is ever packaged |
| Data-set warranty turns out false | High | submit only what is owned personally; never claim the company or the 42 engineers |
| Time spent on cards instead of a paying pilot | Medium | the whole lane is capped at 7 days; the cards are also Build Log chapters, so the time is not wasted either way |

## 11. Next validation step

**Publish card 005, and watch two numbers only:** whether the reviewer accepts it,
and whether any model scores between 0.2 and 0.8. The first tells us whether this
lane is open to us; the second tells us whether the card is calibrated the way the
platform needs. Both answers arrive without writing another line of code.

If the reviewer says the environment is too thin, the fix is already in the repo:
DOP-004 and DOP-003 have *interacting* evidence (a boot log that disagrees with a
dashboard, a provider that answers nothing inside its own deadline), which is
closer to the hardware examples than a single one-line setting.

If it is accepted, the same card becomes the first row of the data-set sample, and
the next three cards are the batches — sold once to the platform and once to our
own buyers at KES 2,500 a chapter.


