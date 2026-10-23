# Scored steps — DOP-001

Eight outcomes, 19 points. The click's 16–32s wait is the symptom; the score is
about whether the answer found *what* was being waited on, *why* the existing
fallback missed it, and whether the proposed rule is safe for a provider that is
merely slow.

| # | Step (outcome) | Points | Checked by | Golden shows | Near miss that fails it |
| --- | --- | --- | --- | --- | --- |
| 1 | Names `nvidia/nemotron-3.5-lightning:free` as the slug the click waited on | 3 | phrase | `culprit` | `naive` (blames the free tier) |
| 2 | Says the attempts returned **no bytes**, not an error status | 2 | phrase (`zero/no bytes`) | "returned zero bytes before the time box closed" | `naive` |
| 3 | Contrasts the already-handled `404` with a slug that accepts and says nothing | 2 | phrase (needs `404` **and** silence) | `why_it_was_missed` | `near-miss-2` (calls it rate limiting) |
| 4 | Retires after **two** empty boxes — not one hiccup, not never | 3 | value = 2 | `fix.retire_after_empty_boxes` | `near-miss-2` (sets 0 "raise the timeout instead") |
| 5 | Next attempt after a strike is a short probe of ~8s | 2 | value 7500–8500 | `fix.probe_timebox_ms` | `near-miss-2` (30000) |
| 6 | Drop lasts for the process and re-probes after deploy | 2 | phrase (`process`, not `global`) | `fix.scope` | `naive` and `near-miss-2` (`global`) |
| 7 | Keeps a slow upstream that *did* send bytes out of the strike count | 3 | phrase (`bytes` + `trickl/slow`) | `must_not_retire` | both near misses (field empty) |
| 8 | Says the change only removes the wait; output still needs credits/quota | 2 | phrase (`credit/quota/billing/key`) | `does_not_fix` | `near-miss-2` ("nothing; raise the timeout") |

## Why these weights

Steps 1, 4 and 7 are the task: identifying the slug is worth little on its own
because the log names it, while the *rule* (two fair empty boxes, never a trickle)
is the part a strong engineer gets wrong by rounding "silent" up to "slow".
Steps 2, 3, 5 and 6 are the supporting reasoning a reviewer can check without a
judge. Step 8 exists so a fix that quietly claims to restore AI output cannot pass:
retiring a dead slug makes the click fast, not intelligent.

## Judge notes

There is no judge step in this task: every check is a value or a phrase, so the
score is identical on every run. If this card is packaged for a brief that uses a
judge, step 3 is the candidate — the judge must be able to quote the sentence in
`answer.json` that mentions `404`, otherwise it fails its own step.

## Measured

`npm run dop:proof` → golden **1.000** (19/19), `naive` **0.000**, `near-miss-2` **0.263**,
stable across three runs.
