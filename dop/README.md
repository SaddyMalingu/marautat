# DOP — how we record system progress

Alphadome work is written up the same way a Hashlist/DOP task is written up, because
Hashlist pays **$300 per accepted task** and rejects anything that is not real
engineering. If our progress notes already have the shape of a task, any week's
work can be packaged in minutes instead of reconstructed from chat logs.

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

* Experiments on host behaviour, latency budgets and provider fallbacks → **Embedded
  Systems Task** style brief: specifications, constraints, architecture choice, scored
  checks (the shape `tasks/001` already uses).
* Anything with a real register/peripheral trace or a schema migration between two
  SDK versions → the **Driver and Peripheral Bring-up** brief ($300/accepted task).
* A customer-facing dataset (tickets, WhatsApp threads, offer/catalog exports) →
  the **"send us a sample"** data-set channel, which is the highest-value route and
  needs no task format at all, only clean, consented files.

## Revenue tie-in

The point is not the paperwork. A card is the artifact we hand a prospect to prove a
fix, the artifact we hand Hashlist to get paid, and the artifact that stops the same
defect from returning in three weeks.
