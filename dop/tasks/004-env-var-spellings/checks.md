# Scored steps — DOP-004

Eight outcomes, 19 points. The symptom is a provider that stays missing while its key
is present; the score is about whether the answer found *which names* are invisible,
*why a present key reads as absent*, and whether the fix is a rule about names or a
one-off rename that leaves the trap in place.

| # | Step (outcome) | Points | Checked by | Golden shows | Near miss that fails it |
| --- | --- | --- | --- | --- | --- |
| 1 | Names both keys, spelled as the host has them | 3 | value (both exact names) | `invisible_keys` | `near-miss-3` (believes the log, names none) |
| 2 | Says the keys are there with values, so this is not provisioning | 2 | phrase | `evidence` | `near-miss-2`, `near-miss-3` |
| 3 | Explains why a present key read as missing instead of failing loudly | 2 | phrase (absent/silent **and** log/lookup/differ) | `why_it_was_missed` | `naive`, `near-miss-2` |
| 4 | Puts the name decision in one resolver shared by walk, log and probe | 3 | phrase (one/single **and** resolver **and** log/probe) | `fix.one_place` | all three |
| 5 | Tries the preferred spelling first | 2 | value `true` | `fix.canonical_first` | all three (`false` or absent) |
| 6 | Accepts an exact allowlist, not a normalised comparison | 3 | phrase | `fix.match_rule` | `near-miss-2` (normalises, the plausible wrong fix) |
| 7 | The probe reports which variable was read, masked | 2 | phrase (`mask` **and** variable/name) | `fix.probe_reports` | all three |
| 8 | Rejects fuzzy/lookalike matching and refuses to log the secret | 2 | phrase | `must_not` | all three (field empty) |

## Why these weights

Steps 1 and 2 are 5 of the 19 points because the environment list hands over the two
spellings: recognising a missing `Q` is not the hard part, and a task that pays for
it would reward transcription.

Step 4 is the task, and step 6 is its teeth. A single resolver shared by the reply
path, the startup line and the probe is what stops the *next* version of this
incident; an exact allowlist is what stops the fix from becoming a fuzzy matcher that
turns any lookalike variable into a credential. `near-miss-2` is exactly that
mistake — it recognises the naming problem, then normalises every name, which is the
answer a thorough engineer reaches for and which quietly makes a typo authoritative.

Step 8 exists so a fix that quietly claims too much cannot pass: making the name
readable does not create quota, and a wrong key still answers 401/402.

## Judge notes

There is no judge step: every check is a value or a phrase, so the score is identical
on every run. If this card is packaged for a brief that uses a judge, step 6 is the
candidate — the judge must be able to quote the sentence in `answer.json` that names
the allowlist and refuses the normalised comparison.

## Measured

`node dop/tasks/004-env-var-spellings/proof.mjs` → golden **1.000** (19/19),
`naive` **0.263** (renames on the host), `near-miss-2` **0.158** (normalises every
name), `near-miss-3` **0.105** (re-provisions), stable across three runs each.
