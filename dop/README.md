# DOP — how we record system progress

Alphadome work is written up the same way a task-platform card is written up, because
these platforms reject anything that is not real engineering and pay per **accepted**
task. If our progress notes already have the shape of a task, any week's work can be
packaged in minutes instead of reconstructed from chat logs.

**What a card actually earns** (checked against the account dashboard, 2026-11-18):
pay lands on the balance per accepted task and is paid out weekly by Stripe; the
embedded Interview Task brief on the board shows **$0 per successful submission**;
the data-set lane pays a **$500–$5,000 sample fee** on acceptance and then a licence
per batch. The full lane-by-lane comparison, the honest data-set description and the
seven-day plan are in `docs/HASHLIST_TASK_PACK.md`. Do not quote a per-task rate
here that the platform has not published — an earlier version of this file claimed
one and it was not supported by anything.

This is not a second backlog. It is the *frame* around the work we were doing
anyway: one folder per real defect or decision, with the evidence, the golden
answer, the wrong answer a capable colleague would give, and a grader that can
prove the difference.

## The rule

> No change reaches `main` without a DOP card.

Small card (a few lines in `PROGRESS.md`) is fine for typos. Anything that took a
diagnosis gets a folder under `tasks/` with a runnable `proof.mjs`.

## Field mapping

| Hashlist field | Our artifact | Why it matters to us |
| --- | --- | --- |
| Prompt, written as the job arrived | `tasks/<id>/question.md` | Forces us to keep the vague ask ("Share is slow") instead of the answer-shaped one ("retire silent slugs") |
| Environment / files | `tasks/<id>/files/` | Only production logs, code excerpts, traces — the files an engineer would actually have open |
| Golden set (correct answer) | `tasks/<id>/answer.json` | Must score 1.0 with our own grader before we claim a fix works |
| Near miss (realistic wrong answer) | `tasks/<id>/naive.json` | Names the mistake a competent colleague makes, e.g. "raise the timeout" |
| Scored steps, 1–5 points, written as outcomes | `tasks/<id>/checks.md` | Same decomposition we use for unit tests, so "done" is measurable rather than felt |
| Checks (value / phrase / judge) | `tasks/<id>/grader.mjs` | Runs offline, same answer → same score, printed per step |
| Proof | `tasks/<id>/proof.mjs` | Fails loudly if golden ≠ 1.0, naive ≥ 0.3, or a run is not repeatable |

## The five conditions, applied to us

1. **Real work.** Every card cites a date and a live host log line. Nothing is invented.
2. **No AI-generated tasks.** The diagnosis, the fix and the golden answer are ours.
   AI may draft wording; it may not supply the engineering.
3. **Hard to cheat.** The grader is not mounted next to the question when the task is
   packaged, and the question never states the culprit. `proof.mjs` asserts the
   `question.md` does not contain the answer's decisive token.
4. **Same answer, same score.** No network, no timers, no clock in the grader.
   `proof.mjs` runs it three times and compares, and greps its own source for
   `fetch` / `http` / `Date.now`.
5. **A realistic wrong answer.** `naive.json` is the answer a good engineer gives
   first — raising a timeout, blaming rate limits, pinning a model — not a strawman.

## Layout

```
dop/
  README.md                  this contract
  PROGRESS.md                the ledger: one row per shipped change
  templates/                 blanks for a new card
  tasks/<id>/
    question.md              the prompt, as the job arrived
    files/                   evidence only
    answer.json              golden answer (scores 1.0)
    naive.json               realistic wrong answer (must score < 0.3)
    checks.md                scored steps, points, which near miss fails which step
    grader.mjs               hidden check: 0.0 – 1.0
    proof.mjs                runs the grader, enforces the contract
```

## Running

```powershell
npm run dop:proof          # every task: golden = 1.0, naive < 0.3, repeatable
node dop/tasks/001-silent-ai-slug/grader.mjs dop/tasks/001-silent-ai-slug/answer.json
```

## Which brief a card can become

* Experiments on host behaviour, latency budgets and provider fallbacks → the
  **task** programme: specifications, constraints, architecture choice, scored
  checks (the shape `tasks/001` and `tasks/005` already use).
* Anything where the *stored value* disagrees with reality — a proxy address, a boot
  log that reports a key as missing, a status row counted as a message → also the
  **task** programme, because the diagnosis is the product.
* A dataset is the batch of accepted cards, not a different artifact. Anything that
  is not already a card is not a dataset either.
* **Not a dataset, ever:** the WhatsApp `conversations` table. It holds 792 inbound
  messages from 83 identifiable people; that is third-party personal data inside a
  DPA 2019 obligation, not inventory. Source history is excluded for a different
  reason: it is the product we sell, so licensing it trains the competitor.

## Packaging a card for upload

```powershell
npm run dop:proof          # golden = 1.000, every near miss < 0.300, repeatable ×3
npm run dop:package        # dist/hashlist/<id>/ in the upload layout
npm run dop:package:check  # validate every card without writing anything
```

`scripts/dop_package.mjs` writes `agent/PROMPT.md`, `agent/CONTEXT.md`, `files/`,
`references/` (gold, near misses, checks, bands) and `PROVENANCE.md`, and refuses to
finish if the grader is mounted next to the question, if a golden answer is not
1.000, if a near miss reaches 0.300, or if the redaction scan finds an email, an
M-Pesa number, a bearer token or a provider key. `dist/` is build output and is
git-ignored.

## Revenue tie-in

The point is not the paperwork. A card is the artifact we hand a prospect to prove a
fix, the artifact we hand Hashlist to get paid, and the artifact that stops the same
defect from returning in three weeks.
