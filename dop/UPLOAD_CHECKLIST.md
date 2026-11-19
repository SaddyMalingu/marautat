# Upload checklist — what a human must do

Written 2026-11-18. Everything that can be automated already is:

```powershell
npm run dop:proof          # 3/3 cards green: golden 1.000, every near miss < 0.300, repeatable
npm run dop:package        # dist/hashlist/<card>/ + manifest.json
```

What is left is the part the platforms check for and an agent cannot supply: your
words, your account, your warrant. Work top to bottom; the first three steps are
reversible, step 4 is not.

---

## 1. Rewrite the golden answers in your own voice (20 min per card)

The platform's rule is that AI may not supply the engineering. The engineering here
is yours and it is dated in your commits. The *prose* in each `answer.json` is a
consolidation of your own code comments, drafted with assistance. Re-read each field
and say it the way you would say it to a colleague. Do not add facts — every sentence
must still be traceable to the source in the right-hand column.

### `dop/tasks/005-trusted-proxy-ip/answer.json`

| Field | Re-word from |
| --- | --- |
| `culprit` | `server.js:115-117` (the comment above the line) |
| `evidence` | `scripts/test_site_hygiene.mjs:1-12` — why ten clips and a `track-visit` mean a browser |
| `why_it_was_missed` | the same header: a well-formed value that reads as local traffic |
| `fix.setting` / `fix.value` | `server.js:117` — the literal line |
| `fix.ordering` | `scripts/test_site_hygiene.mjs:27-38` — the two ordering assertions |
| `must_not` | `scripts/test_site_hygiene.mjs:29-30` — "not `true`, spoofable" |
| `does_not_fix` | `docs/MULTITENANT_AI_JOBS_RUNBOOK.md:434-440` |

### `dop/tasks/004-env-var-spellings/answer.json`

| Field | Re-word from |
| --- | --- |
| `invisible_keys` | the environment list in `files/` (do not change these — they are the answer) |
| `evidence` | `dop/PROGRESS.md` DOP-004 evidence column |
| `why_it_was_missed` | `utils/logger.js:8-11` — "how the 2026-10-22 outage stayed hidden behind `hf=true`" |
| `fix.one_place` | `scripts/blogManager.js:278-292` — one helper, so the readers cannot disagree |
| `fix.match_rule` | `scripts/blogManager.js:405-489` — the enumerated spellings per provider |
| `fix.probe_reports` | `docs/MULTITENANT_AI_JOBS_RUNBOOK.md:496-498` — "the probe prints the var it read" |
| `must_not` | your own reasoning: fuzzy matching is the trap, and logging a key outlives the incident |
| `does_not_fix` | `scripts/blogManager.js:415-419` — a pin is a preference, not a trap |

### `dop/tasks/001-silent-ai-slug/answer.json`

| Field | Re-word from |
| --- | --- |
| `culprit` | the `[AI] openrouter … aborted after …` lines in `files/` |
| `evidence` | the same lines: 13.1s / 30.0s / 13.5s with no bytes |
| `why_it_was_missed` | `files/blogManager-provider-notes.txt`, the 404-vs-silence paragraph |
| `fix.*` | `scripts/blogManager.js` retire/strike logic and `54931a41` |
| `must_not_retire` | the trickle paragraph in the notes file |
| `does_not_fix` | the HF 402 and Gemini quota lines in the log |

After rewriting, re-run `npm run dop:proof`. If a rewrite drops a decisive phrase the
grader looks for, the proof tells you which step broke — that is a phrasing problem,
not a judgment call, and the fix is to say the same thing more plainly.

---

## 2. Delete the fiction in the account

The draft data-set form holds *Firmware defect tracker, motor controllers · 3,200
records · 40 GB · 2017–2024 · 120 employees · 42 engineers*. Step 2 of that flow would
ask you for ~32 of those tickets and you would then sign a licence warranting you own
them. Delete the draft, or replace it with §6 of `docs/HASHLIST_TASK_PACK.md`.

While you are there: the 28-day-old `task-mvh74zkd` draft is still in **Draft**. Either
finish it (your card 001 is 80% of that shape) or delete it. A stale draft in the same
account that receives your publication reads as a stall.

---

## 3. Create the tasks in the app — in this order

Publish **005 first**. It has the strongest evidence (verbatim log lines, six months
apart) and a near miss that is a security regression, which is the most reviewable
thing in the set. Then 004, then 001.

| App field | Take from |
| --- | --- |
| Prompt | `dist/hashlist/<card>/agent/PROMPT.md` |
| Environment / files | `dist/hashlist/<card>/files/` |
| Context, if the builder has one | `dist/hashlist/<card>/agent/CONTEXT.md` |
| Golden set | `dist/hashlist/<card>/references/gold.json` |
| Near misses | `dist/hashlist/<card>/references/naive_*.json` |
| Scored steps, points, check kind | `dist/hashlist/<card>/references/bands.json` |
| Reviewer notes | `dist/hashlist/<card>/references/checks.md` |
| Provenance | `dist/hashlist/<card>/PROVENANCE.md` |

**Tick the near misses under the steps their own `checks.md` names** — or take the
tick map straight from `dop/APP-ENTRY-SHEETS.md`, which was measured against the
graders and gives the single phrase or value that separates the golden answer from
every near miss. A near miss you tick under a step has to fail that step, and the
app's Proof button will hold you to it.

**Do not paste `grader.mjs` into the task.** The app has its own check builder (value /
phrase / judge). The grader stays in `dop/tasks/<card>/` as the offline referee for
local changes.

---

## Known platform limits (countered once already)

| Limit | What it blocked | How to work with it |
|---|---|---|
| Daily spend limit **$0.00** on this account | *"Generate checks from your steps"* — it is a model job, so it is cancelled before it runs | **Add the scored steps manually** from `APP-ENTRY-SHEETS.md`. The checks are already known; nothing needs drafting. Ask Hashlist to raise the limit before relying on generated drafts |
| "Runs are temporarily paused" (service notice, 2026-11-16) | step 7 **Run**, and the model spread a reviewer sees | publish anyway — runs queue and the notice says they resume Tue 17th. Do not read a queued run as a rejection |
| Script execution is **not** a model job | nothing — `gold.py` ran and produced the expected `answer.txt` while jobs were blocked | the parts that need no spend: gold script, near-miss scripts, environment, prompt, scored steps entered by hand |

## 4. Publish, then watch two numbers

> **Gate before you publish:** ToS **§11** (who owns your work) and **§13** (which files
> you may use) have not been read — the legal pages are a JavaScript app and returned no
> text. Publishing may assign the task, in which case the card can never be sold by us
> again. Ask the reviewer through **Messages** first: *"If I publish a task, do I assign
> copyright or grant a licence, and may I reuse that same task commercially elsewhere?"*
> See `docs/HASHLIST_EVALUATION.md`.

Publishing is the only irreversible action in this list.

| What to watch | Why |
| --- | --- |
| Reviewer verdict | tells you whether this lane is open to a solo operator at all |
| Model spread across runs | the brief wants 2–20% success; if every run scores 1.00 the task is too easy, if every run scores 0.00 it is too hard |

If the reviewer says the environment is too thin (a real risk — their example is five
radars and 22 `.npz` files), the answer is already in the repo: cut **DOP-003**
(Gemini's 15-second silence with no 429 anywhere, `5f67bef4`). It has interacting
evidence — a provider that accepts a request and answers nothing while a *different*
provider is throttled — which is the closest thing we have to a hardware bring-up
story.

---

## 5. The referral lane — cheapest money on the page

$200 when someone you introduce has their first paid task accepted, then 20% up to
$400 more. You already have the audience: the drops buyers and the WhatsApp list are
people who want paid remote work with a laptop.

Three messages, one link (`https://dop.hashlist.com/signup?ref=furgz23g`), and the
`ai-work-application-kit` pack (KES 1,500) as the thing you hand them on the way in.
That is the whole campaign, and it uses machinery that already runs.

---

## Hard rules — do not do these

- **Do not upload the repo's source history.** The M-Pesa lane, tenant isolation and
  the browser-actor worker are the product.
- **Do not upload anything from `public.conversations`.** 792 inbound messages from 83
  identifiable people; not yours to licence.
- **Do not claim the company or the 42 engineers.** "I own it personally" is a warranty.
- **Do not add a card for work you did not do.** The near misses are what make these
  cards good; an invented incident has no near miss because it has no failure.

## When this checklist is done

Three published or submitted tasks, one honest data-set submission, a referral link in
three conversations, and a `dist/hashlist/manifest.json` whose totals line is the
answer to "what do we actually have to sell". Everything after that is a repeat of the
same four commands.

