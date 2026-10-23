# Progress ledger

One row per shipped change. `Card` links the DOP task folder; `Proof` is what
`npm run dop:proof` printed at the time of shipping.

| ID | Date | Change | Evidence | Card | Proof | Status |
| --- | --- | --- | --- | --- | --- | --- |
| DOP-001 | 2026-10-23 | Retire AI slugs that answer with silence, not just 404s (`54931a4`) | `tasks/001-silent-ai-slug/files/production-log-2026-10-23.txt` | `tasks/001-silent-ai-slug/` | golden 1.00 / naive 0.00 / repeatable | shipped |
| DOP-002 | 2026-10-23 | WhatsApp reply path joins the platform provider chain (wrong host, wrong env var, retired slug, no Gemini) | Render log 06:36 (`[ERROR] OpenRouter error: getaddrinfo ENOTFOUND api.openrouter.ai`) | not yet cut — next | — | shipped, card pending |

## Open items that are not cards (ops, no code)

| Item | Owner fix | Blocks |
| --- | --- | --- |
| HF account out of credits (`402 no remaining credits`) | top up, or drop HF from the chain | any AI-generated copy |
| Gemini free tier exhausted (`429 exceeded your current quota`) | rotate key / enable billing | Share, Review |
| OpenRouter free slugs: 429 on gemma, 404 on minimax + nemotron-super | rotate keys; the writer already walks past them | Share, Review |
| Render auto-deploy off for this service | manual deploy after each push | everything above |

## Cutting a new card

1. Copy `templates/` into `dop/tasks/<next-id>-<slug>/`.
2. Paste the prompt **as it reached you** into `question.md`; paste only the
   evidence an engineer would have into `files/`.
3. Write `answer.json` from the fix you actually shipped, then write the steps in
   `checks.md` as outcomes with points that total what you care about.
4. Write `naive.json` — the plausible first answer, not a strawman — and tick which
   steps it fails.
5. `npm run dop:proof` until it is green, then add the row above.
