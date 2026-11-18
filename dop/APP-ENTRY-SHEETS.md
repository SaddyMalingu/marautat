# App entry sheets — what to type, per step

Written 2026-11-18, derived from each card's `grader.mjs` and measured against its
near misses. The platform's builder takes a step as **an outcome, points, and one of
three checks** (a value between two numbers · a line containing a phrase · a judge).
Our graders are regexes over two fields at once, so this sheet names the **single
phrase or value that separates the golden answer from every near miss** — pick that
one, and the app's Proof will agree with `npm run dop:proof`.

> Rule for every step: the outcome line is what a correct answer *shows*, not what it
> does. Copy the text from the **Step** column verbatim; it comes from `checks.md`.

---

## A. `005-trusted-proxy-ip` — publish this one first

**Task name:** Every visitor was recorded from one address
**Type:** Software · Defect tickets with fixes · Requirements traced to code
**Size:** 1 incident · 3 evidence files · produced 2026-04-18 → 2026-10-24
**Environment:** create a new one, from the three files in `files/`

| # | Step (outcome) | Pts | Check | Enter exactly | Tick near misses |
|---|---|---|---|---|---|
| 1 | The stored address is identified as the proxy's, not the visitor's | 2 | phrase | `::1` | — |
| 2 | The setting that decides how the address is resolved is named | 3 | phrase | `trust proxy` | nm2, nm3 |
| 3 | The value is given as the hop count of one | 3 | value | field `fix.value`, min **1**, max **1** | all 3 |
| 4 | The boolean form is rejected because it lets a client spoof the address | 3 | phrase | `spoof` | all 3 |
| 5 | The setting is placed before the readers that use it | 2 | phrase | `express.json` | all 3 |
| 6 | A wrong-but-well-formed address is explained as looking normal | 2 | phrase | `well-formed` | naive, nm3 |
| 7 | The traffic itself is used to prove the peer was a person | 2 | phrase | `health checker` | all 3 |
| 8 | What it cannot identify and what it leaves broken is stated | 2 | phrase | `VPN` | all 3 |

**Point total: 19.** Golden must score 19/19 inside the app; best near miss 5/19.

---

## B. `004-env-var-spellings`

**Task name:** The AI tier cannot see keys that are in the dashboard
**Type:** Software · Defect tickets with fixes · Test logs
**Size:** 1 incident · 3 evidence files · produced 2026-10-22 → 2026-10-23

| # | Step (outcome) | Pts | Check | Enter exactly | Tick near misses |
|---|---|---|---|---|---|
| 1 | Both invisible keys are named as the host spells them | 3 | phrase | `GROK_API_KEY` (if the builder allows a second phrase, add `OPEN_ROUTER_API_KEY`) | nm3 |
| 2 | The keys are stated to be present with values, so this is not provisioning | 2 | phrase | `with values` | nm2, nm3 |
| 3 | Why a present key read as missing is explained | 2 | phrase | `two different` | naive, nm2 |
| 4 | The name decision is put in one resolver shared by walk, log and probe | 3 | phrase | `one resolver` | all 3 |
| 5 | The preferred spelling is tried first | 2 | value | field `fix.canonical_first` = **true** | all 3 |
| 6 | An exact allowlist is accepted instead of a normalised comparison | 3 | phrase | `allowlist` | naive, nm2 |
| 7 | The probe reports which variable was read, masked | 2 | phrase | `masked` | all 3 |
| 8 | Fuzzy matching and logging the secret are both refused | 2 | phrase | `fuzzy matcher` | all 3 |

**Point total: 19.** Golden 19/19; naives measure 5 / 3 / 2.

---

## C. `001-silent-ai-slug`

**Task name:** Share and Review wait half a minute, then say the AI tier is unavailable
**Type:** Software · Defect tickets with fixes · Test logs
**Size:** 1 incident · 2 evidence files · produced 2026-10-22 → 2026-10-23

| # | Step (outcome) | Pts | Check | Enter exactly | Tick near misses |
|---|---|---|---|---|---|
| 1 | The slug the click waited on is named | 3 | phrase | `nvidia/nemotron-3.5-lightning:free` | naive |
| 2 | The attempts are said to have sent no bytes, not returned an error | 2 | phrase | `zero bytes` | naive |
| 3 | The already-handled 404 is contrasted with a slug that says nothing | 2 | phrase | `silent` | naive, nm2 |
| 4 | Retirement happens after two empty boxes | 3 | value | field `fix.retire_after_empty_boxes`, min **2**, max **2** | naive, nm2 |
| 5 | The attempt after a strike is a short probe (~8 s) | 2 | value | field `fix.probe_timebox_ms`, min **7500**, max **8500** | naive, nm2 |
| 6 | The drop lasts for the process and re-probes after a deploy | 2 | phrase | `process` | naive, nm2 |
| 7 | A slow upstream that did send bytes stays out of the strike count | 3 | phrase | `trickles` | naive, nm2 |
| 8 | The change only removes the wait; output still needs credits or quota | 2 | phrase | `quota` | naive, nm2 |

**Point total: 19.** Golden 19/19; naive 0/19; nm2 5/19.

---

## If the app's Proof complains

| The app says | What it means | Do this |
|---|---|---|
| A ticked near miss passed the step | the phrase you entered is not the discriminator for that step | take the phrase from this sheet, not from `checks.md` prose |
| The golden answer failed a step | a field is named differently in the planted JSON | compare against `references/gold.json`; the rule is usually `fix.*` nesting |
| A step could not be checked | the step is a value but you entered a phrase (or the reverse) | steps 3/4/5 of 001 and step 3 of 005 are **value** checks, step 5 of 004 is a **boolean** |

## Judge steps

None of the three cards uses a judge. Every step is a value or a phrase, so a run
scores identically on every repeat — which is the "same answer, same score" condition.
If you later convert a step to a judge, `checks.md` names the one sentence the judge
must be able to quote, and an answer that does not write that sentence into the file
fails its own step.
