# Scored steps — DOP-005

Eight outcomes, 19 points. The symptom is one wrong column repeated for six months;
the score is about whether the answer found *what* the address is, *which* knob
decides it, *why* the safe value is a number and not a boolean, and what the change
leaves unfixed.

| # | Step (outcome) | Points | Checked by | Golden shows | Near miss that fails it |
| --- | --- | --- | --- | --- | --- |
| 1 | Says the stored `::1` is the in-instance proxy, not the visitor | 2 | phrase (`::1`/loopback **and** proxy) | `culprit` | `naive` and `near-miss-3` pass this one — naming the value is the easy half |
| 2 | Names the setting that decides how the address is resolved | 3 | phrase | `fix.setting` | `near-miss-2` (parses the header by hand), `near-miss-3` (asks the host) |
| 3 | Gives the value as the hop count of one, not a boolean | 3 | value | `fix.value` = `1` | `naive` (`true`), `near-miss-2` (`leftmost`) |
| 4 | Rejects the boolean form and says why it is unsafe | 3 | phrase (`true` **and** spoof/forged/leftmost) | `must_not` | all three (field empty or silent on it) |
| 5 | Says the setting must sit before the middlewares that read the address | 2 | phrase (`before` **and** json/logger) | `fix.ordering` | all three |
| 6 | Explains why a wrong-but-well-formed address read as normal | 2 | phrase | `why_it_was_missed` | `naive`, `near-miss-3` |
| 7 | Uses the traffic itself to prove the peer was a person | 2 | phrase (`health/checker` **and** media/analytics) | `evidence` | `naive`, `near-miss-2`, `near-miss-3` |
| 8 | Says what it cannot identify and what it leaves broken | 2 | phrase (VPN/NAT **and** favicon/media) | `does_not_fix` | all three |

## Why these weights

Steps 3 and 4 are the task. Step 1 and step 2 are cheap because the log hands over
the value and the setting is the well-known one; the part a capable engineer rounds
off is *what* it trusts — `true` makes the header believed at face value, so the
analytics become forgeable by anyone who can set a header. That is the difference
between a fix and a regression, so it carries 6 of the 19 points.

Step 5 is the ordering trap: the same code placed after `express.json()` or after
the request logger still writes the old address for early requests, so the fix
"works" on a laptop and not on the first hit of a deploy.

Steps 6 to 8 exist so a change that quietly claims more than it did cannot pass.
Restoring the visitor's address does not tell you who a VPN user is, and it does not
touch the 40 MB of media or the favicon 404s.

## Judge notes

There is no judge step: every check is a value or a phrase, so the score is
identical on every run. If this card is packaged for a brief that uses a judge,
step 4 is the candidate — the judge must be able to quote the sentence in
`answer.json` that names `true` and the spoof, otherwise it fails its own step.

## Measured

`node dop/tasks/005-trusted-proxy-ip/proof.mjs` → golden **1.000** (19/19),
`naive` **0.263**, `near-miss-2` **0.211**, `near-miss-3` **0.105**, stable across
three runs each. Best near miss is 0.263, under half the golden score, so the task
separates a real diagnosis from the standard advice.
