# Provenance — DOP-001

Every claim in `question.md`, `files/` and `answer.json` is traceable to something in
this repository, because the platforms we submit to reject work that cannot be traced.

## The incident

| Item | Value |
| --- | --- |
| Date observed | 2026-10-23, one tenant session 05:17–05:18 UTC |
| Fix commit | `54931a41` — "Retire AI slugs that answer with silence, not just 404s" (2026-10-23) |
| Earlier related commit | `a7eef633` (2026-10-22) — share the angle deadline, retire dead slugs, time-box the router |
| Ledger row | `dop/PROGRESS.md` → DOP-001 |

## Where each evidence file comes from

| File | Origin |
| --- | --- |
| `files/production-log-2026-10-23.txt` | The host log for one tenant session. Timings, model slugs and status codes are verbatim. **The tenant's post slug is replaced with `post-1`**; no tenant name, phone number or credential appears. |
| `files/blogManager-provider-notes.txt` | The comment block carried in `scripts/blogManager.js` next to the provider list, as it stood before the fix. Reproduced because it is the file an engineer would have open while reading the log. |

## Where the golden answer comes from

`answer.json` is the reasoning that shipped with `54931a41`, already written down in
the repository:

* `scripts/blogManager.js` — the comment block reproduced in `files/`, which states
  that a `404` is retired for the process and that a `429` quota clears.
* `scripts/test_ai_providers.mjs` — the offline suite that drives the walk with a
  stubbed transport and asserts which provider served (`getLastAiProvider`).
* `dop/tasks/001-silent-ai-slug/checks.md` — the eight scored outcomes and their
  weights, taken from the fix as shipped.

The measured behaviour of this card is golden **1.000** (19/19), `naive` **0.000**,
`near-miss-2` **0.263**, stable across three runs (`node dop/tasks/001-silent-ai-slug/proof.mjs`).

## Disclosure: how much AI was used

* **The incident, the diagnosis, the fix and the reasoning are human.** They are in
  the commit, the code comments and the operator notes, all dated before this card.
* **The checks and the grader follow this repository's card format**, written with an
  AI assistant against real evidence.
* **The prose in `answer.json` consolidates the human-written comments above**, drafted
  with AI assistance. The author should re-read it and put it in their own words
  before uploading — both because the platform requires it and because a reviewer
  can tell.

## Redaction checklist

- [x] No tenant, business or personal names
- [x] No phone numbers, email addresses or WhatsApp identifiers
- [x] No API keys, tokens or connection strings (the log shows status codes, not credentials)
- [x] The tenant's post slug is replaced with `post-1`
- [x] Model slugs and timings kept as they were — they are the evidence
