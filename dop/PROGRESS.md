# Progress ledger

One row per shipped change. `Card` links the DOP task folder; `Proof` is what
`npm run dop:proof` printed at the time of shipping.

| ID | Date | Change | Evidence | Card | Proof | Status |
| --- | --- | --- | --- | --- | --- | --- |
| DOP-001 | 2026-10-23 | Retire AI slugs that answer with silence, not just 404s (`54931a4`) | `tasks/001-silent-ai-slug/files/production-log-2026-10-23.txt` | `tasks/001-silent-ai-slug/` | golden 1.00 / naive 0.00 / repeatable | shipped |
| DOP-002 | 2026-10-23 | WhatsApp reply path joins the platform provider chain (wrong host, wrong env var, retired slug, no Gemini) | Render log 06:36 (`[ERROR] OpenRouter error: getaddrinfo ENOTFOUND api.openrouter.ai`) | not yet cut — next | — | shipped, card pending |
| DOP-003 | 2026-10-23 | Provider chain is genuinely multi-provider: Gemini light→full alias walk, Groq + Cerebras as independent free tiers, `lastAiProvider` now recorded, boot log names all six | Render log 10:39-10:40 (`gemini … aborted after 15.0s` with no 429 anywhere, `hf … 402`) | not yet cut — next | `test:ai-providers` 30 passed, 0 failed | shipped, card pending |

## Open items that are not cards (ops, no code)

| Item | Owner fix | Blocks |
| --- | --- | --- |
| No **Groq** or **Cerebras** key on the host | create a free key (https://console.groq.com/keys, https://cloud.cerebras.ai), `npm run check:ai-key`, add on Render → Manual Deploy — the chain already has slots for both | Share, Review, WhatsApp — the one action that makes the tier independent of Gemini |
| HF account out of credits (`402 no remaining credits`) | HF Inference Providers needs prepaid credits or PRO: top up, or leave HF last (it is). If the two HF vars belong to different accounts, unset the dry one so the alias is actually read | nothing, now that four other slots exist |
| Gemini free tier: `429` cleared on 2026-10-23 10:40, but `gemini-flash-latest` then sent **zero bytes for 15 s** | the lite alias now leads (DOP-003); if the light alias also stalls twice it is retired for the process — Groq/Cerebras cover it. Billing on the Cloud project removes the daily bucket | Share, Review |
| OpenRouter free slugs: 429 on gemma, 404 on minimax + nemotron-super | rotate keys; the writer already walks past them | Share, Review |
| Render auto-deploy off for this service | manual deploy after each push | everything above |

Key rotation is no longer guesswork: `npm run check:ai-key` (2026-10-23) drives the
same `ai()` walk the writers use, one provider at a time (openrouter, gemini,
groq, cerebras, openai, hf), and prints `SERVED`
with a latency or the chain's own status/body plus the fix (`out of credits`,
`key rejected`, `daily quota spent`, `slug retired`, `no answer inside the time
box`). Exit `0` = at least one provider wrote copy, so it can gate a deploy.
Sequence is in `docs/MULTITENANT_AI_JOBS_RUNBOOK.md` → *Prove a key before you
deploy it*.

## Cutting a new card

1. Copy `templates/` into `dop/tasks/<next-id>-<slug>/`.
2. Paste the prompt **as it reached you** into `question.md`; paste only the
   evidence an engineer would have into `files/`.
3. Write `answer.json` from the fix you actually shipped, then write the steps in
   `checks.md` as outcomes with points that total what you care about.
4. Write `naive.json` — the plausible first answer, not a strawman — and tick which
   steps it fails.
5. `npm run dop:proof` until it is green, then add the row above.
