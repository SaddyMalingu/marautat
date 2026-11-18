# Provenance — DOP-004

Every claim in `question.md`, `files/` and `answer.json` is traceable to something in
this repository.

## The incident

| Item | Value |
| --- | --- |
| Date observed | 2026-10-23 (boot line at 14:56, the deploy of `facc1404`) |
| Fix commit | `1436ef23` — "Writers AI tier: accept dashboard env spellings, add Mistral as a fourth free tier" (2026-10-23) |
| Related commit | `5f67bef4` (2026-10-23) — "A slow Gemini alias is a detour, not an outage" |
| Ledger row | `dop/PROGRESS.md` → DOP-004 |
| Regression suite | `scripts/test_ai_providers.mjs` — 33 passed, 0 failed after the fix (30 before) |

## Where each evidence file comes from

| File | Origin |
| --- | --- |
| `files/boot-log-2026-10-23.txt` | The startup line printed by `utils/logger.js`, quoted at 14:56 — the deploy that built `facc1404`. `openrouter=false` / `groq=false` / `hf=true` are the readings recorded in `dop/PROGRESS.md` (rows DOP-004 and the 2026-10-23 14:56 deploy note). An ellipsis marks the fields this incident did not change; key material never appears on this line. |
| `files/render-env-names-2026-10-23.txt` | The names as recorded in `dop/PROGRESS.md` DOP-004: "Render env list showing `GROK_API_KEY` / `OPEN_ROUTER_API_KEY` on a host whose boot log said `groq=false openrouter=false`". Values are not reproduced. |
| `files/gateway-notes-2026-10-22.txt` | Verbatim comment text from `utils/logger.js` (lines 8–11) and `server.js` (lines 15003–15007, truncated before the resolution it documents). The closing operator sentence is the author's. |

## Where the golden answer comes from

The fix and its reasoning shipped in `1436ef23`, and are already written down:

* `scripts/blogManager.js:278-292` — the comment above `keyFrom()`: the dashboard is
  a text box, a plausible spelling is a real risk, the canonical name leads and the
  spellings a human types still count.
* `scripts/blogManager.js:405-489` — `AI_PROVIDERS`, where each provider's accepted
  spellings are enumerated exactly, canonical first.
* `server.js:15003-15019` and `utils/logger.js:8-21` — the startup lines, with the
  comment that their names must match what the chain reads.
* `scripts/test_ai_providers.mjs` — the assertions that a misspelled key still serves
  (`GROK_API_KEY -> groq`, `OPEN_ROUTER_API_KEY -> openrouter`) and that
  `getLastAiProvider()` names who actually answered.

## Disclosure: how much AI was used

* **The incident, the diagnosis, the fix and the reasoning are human.** They are in
  the commit and the code comments, dated before this card.
* **The checks and the grader follow this repository's card format**, written with an
  AI assistant against that evidence.
* **The prose in `answer.json` consolidates the human-written comments above**, drafted
  with AI assistance. Re-read it and put it in your own words before uploading.

## Redaction checklist

- [x] No tenant, business or personal names
- [x] No phone numbers, email addresses or WhatsApp identifiers
- [x] No key material — the boot line prints booleans, the names file prints names only
- [x] No provider account identifiers, org ids or billing details
- [x] The two misspelled variable names are kept: they are the evidence
