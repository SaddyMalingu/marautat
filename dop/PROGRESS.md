# Progress ledger

One row per shipped change. `Card` links the DOP task folder; `Proof` is what
`npm run dop:proof` printed at the time of shipping.

| ID | Date | Change | Evidence | Card | Proof | Status |
| --- | --- | --- | --- | --- | --- | --- |
| DOP-001 | 2026-10-23 | Retire AI slugs that answer with silence, not just 404s (`54931a4`) | `tasks/001-silent-ai-slug/files/production-log-2026-10-23.txt` | `tasks/001-silent-ai-slug/` | golden 1.00 / naive 0.00 / repeatable | shipped |
| DOP-002 | 2026-10-23 | WhatsApp reply path joins the platform provider chain (wrong host, wrong env var, retired slug, no Gemini) | Render log 06:36 (`[ERROR] OpenRouter error: getaddrinfo ENOTFOUND api.openrouter.ai`) | not yet cut — next | — | shipped, card pending |
| DOP-003 | 2026-10-23 | Provider chain is genuinely multi-provider: Gemini light→full alias walk, Groq + Cerebras as independent free tiers, `lastAiProvider` now recorded, boot log names all six | Render log 10:39-10:40 (`gemini … aborted after 15.0s` with no 429 anywhere, `hf … 402`) | not yet cut — next | `test:ai-providers` 30 passed, 0 failed | shipped, card pending |
| DOP-004 | 2026-10-23 | Chain accepts the env spellings the dashboard actually received (`GROK_API_KEY`, `OPEN_ROUTER_API_KEY`) via one `keyFrom()` helper; Mistral added as a fourth independent free tier; probe prints `via <VAR>` | Render env list showing `GROK_API_KEY` / `OPEN_ROUTER_API_KEY` on a host whose boot log said `groq=false openrouter=false`; `check:ai-key --only=groq` with `GROK_API_KEY` reaches the API (401 in 0.5 s), `--only=mistral` reaches `api.mistral.ai` (401 in 0.5 s) | not yet cut — next | `test:ai-providers` 33 passed, 0 failed | shipped, card pending |
| DOP-005 | 2026-10-24 | Every visitor was recorded as `::1`: `app.set('trust proxy', 1)` added (Render forwards over HTTP, so `req.ip` was the in-instance proxy for browsers too); `/favicon.ico` answers the brand mark instead of 404ing twice per visit | Render log 03:55 — `[PAGE] Landing page loaded by ::1` at `:36.216`, then `track-visit` 200 at `:41` and 40 MB of `/media/*.mp4` ranges; `favicon.ico 404` twice | not yet cut — next | `test:site-hygiene` 16 passed, 0 failed | shipped, card pending |

## Open items that are not cards (ops, no code)

| Item | Owner fix | Blocks |
| --- | --- | --- |
| Groq / Cerebras / Mistral keys exist on the host but **two are under names nothing read** (`GROK_API_KEY`, `OPEN_ROUTER_API_KEY`) | DOP-004 accepts those spellings, so the keys should now be dialled; rename them to `GROQ_API_KEY` / `OPENROUTER_API_KEY` on Render and redeploy to keep the config honest. Boot log must read `groq=true cerebras=true mistral=true` | Share, Review, WhatsApp — until the deploy lands, verify with `npm run check:ai-key` |
| HF account out of credits (`402 no remaining credits`) | HF Inference Providers needs prepaid credits or PRO: top up, or leave HF last (it is). If the two HF vars belong to different accounts, unset the dry one so the alias is actually read | nothing, now that four other slots exist |
| Gemini free tier: `429` cleared on 2026-10-23 10:40, `gemini-flash-latest` then sent **zero bytes for 15 s**, and at 15:23 the key answered `402 prepayment credits are depleted` on every call | the lite alias leads (DOP-003) and a `402` retires the provider for the process, so it no longer slows a walk — but Gemini is **not a usable slot** until the Cloud project is funded (`https://ai.studio/projects`). Groq/Cerebras/Mistral are the covering tiers | Share, Review |
| OpenRouter free slugs: 429 on gemma, 404 on minimax + nemotron-super, and at 15:23 `gemma-4-31b`/`gemma-4-26b` both `429` while `nemotron-3.5-lightning` sent zero bytes for its full 13 s box | rotate the key or fund it; the walk already retires `404`s and stall-marks the silent slug (second fair box retires it). Groq is the cheaper first stop while the free pool is throttled | Share, Review |
| Render auto-deploy off for this service | manual deploy after each push — and **push first**: Render builds `origin/main`, so a commit that is only local is invisible to the builder. 2026-10-23 14:56 built `facc1404` while `main` was two commits ahead, and the untested deploy read as a failed fix (`[SYSTEM] ENV LLM keys: … hf=true`, no `groq`/`cerebras`/`mistral`) | everything above |
| Landing page ships 47 MB of video (`public/media`: 11 files, eight still named `tmp*.mp4`, and one clip stored twice under a dashed and a spaced filename — same MD5 `642f789c…`) and the carousel pulls most of it in ~13 s | a visitor on a phone never finishes a clip; 10 clips inside 13 s against a 24 s rotation timer means the `error`/`load-timeout` path is advancing it (DOP-005 covered the IP/favicon half of that log). Cut to three clips under 3 MB, rename them, delete the duplicate | first impression of every demo; Render egress |

Key rotation is no longer guesswork: `npm run check:ai-key` (2026-10-23) drives the
same `ai()` walk the writers use, one provider at a time (openrouter, gemini,
groq, cerebras, mistral, openai, hf), prints the key **masked with the var it was
read from** (`via GROK_API_KEY`, so a misspelling shows up as a line instead of a
mystery), and prints `SERVED`
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
