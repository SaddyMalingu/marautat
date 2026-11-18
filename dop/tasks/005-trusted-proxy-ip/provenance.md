# Provenance — DOP-005

Every claim in `question.md`, `files/` and `answer.json` is traceable to something
that exists in this repository. This page exists because the platforms we submit to
reject work that cannot be traced, and because a future reader should be able to
re-check the card without asking anyone.

## The incident

| Item | Value |
| --- | --- |
| Date observed | 2026-04-18 (first `::1` page line) → 2026-10-24 (fix) |
| Fix commit | `586ec2f0` — "Every visitor was logged as ::1: trust the Render proxy, serve a real favicon" (2026-10-24) |
| Ledger row | `dop/PROGRESS.md` → DOP-005 |
| Fix line | `server.js:117` — `app.set('trust proxy', 1);` |

## Where each evidence file comes from

| File | Origin |
| --- | --- |
| `files/bot-log-excerpt-2026-04-18.txt` | `logs/bot.log`, verbatim contiguous lines 993–1002 and 1121–1125. The `[PAGE]` lines are the application's own output. |
| `files/analytics-ip-column.txt` | Notes taken while reading the analytics tables read-only on 2026-10-24; no row was written. |
| `files/health-checker-note.txt` | The duty-log note written at 03:55 UTC on 2026-10-24, while the Render log was being watched: ten range requests (~40 MB in 13 s), `POST /api/kassangas/track-visit` 200, two `favicon.ico` 404s, all from the peer logged as `::1`. |

## Where the golden answer comes from

`answer.json` is the reasoning that shipped with `586ec2f0` and that is already
written down in the repository:

* `server.js:115-117` — the comment above the fix: `1` (not `true`) trusts exactly
  the Render hop, so a client-supplied `X-Forwarded-For` cannot spoof it.
* `scripts/test_site_hygiene.mjs:1-12` — why the peer was a browser, and why the
  line must not be `true`.
* `scripts/test_site_hygiene.mjs:27-38` — the ordering assertions: the line is
  extracted from `server.js` and must appear before `express.json(` and before the
  request logger.
* `docs/MULTITENANT_AI_JOBS_RUNBOOK.md:434-440` — `::1` is Render's in-instance
  proxy, and every `ip` / `source_ip` column inherited it.

## Disclosure: how much AI was used

This matters to every platform that accepts these cards, so it is stated plainly
rather than in a footnote.

* **The incident, the diagnosis, the fix and the reasoning are human.** They are in
  the commit, the comments and the test file, all dated before this card existed.
* **The checks and the grader are human-designed, agent-implemented**: the eight
  outcomes and their weights were chosen here, and the code that tests them was
  written with an AI assistant against this repository's existing card format.
* **The prose in `answer.json` is a consolidation** of the human-written comments
  above, drafted with AI assistance. Before this card is uploaded anywhere, the
  author should re-read it and put it in their own words — both because the
  platforms require it and because a reviewer can tell.

## Redaction checklist

- [x] No tenant names, business names or personal names
- [x] No phone numbers, email addresses or WhatsApp identifiers
- [x] No API keys, tokens, cookies or connection strings
- [x] No production rows shown — the analytics file describes columns, not records
- [x] Only one surface path (`/api/kassangas/track-visit`) kept, because the traffic
      shape is the evidence
