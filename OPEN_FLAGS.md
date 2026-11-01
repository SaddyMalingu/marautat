# Open Flags

Running list of things that are **known, verified, and not yet closed**. Newest first.
Nothing here is speculative — each line was observed in a log, a live run, or a test.

| # | Severity | Flag | Why it matters | Owner |
|---|---|---|---|---|
| 1 | **HIGH** | `WHATSAPP_APP_SECRET` not configured — `[WARN] signature verification skipped` | `/webhook` accepts **unsigned** payloads. Anyone who learns the URL can inject fake inbound messages into the bot. Set the secret from Meta App Dashboard → App settings → Basic. | you (env) |
| 2 | **HIGH** | Supabase **service-role key** exposed in chat + `.env` | Bypasses RLS entirely; full read/write. Rotate → update `.env` **and** Render's env before the next deploy, or the app breaks on boot. | you |
| 3 | **HIGH** | Tenant session token `t=6f0c…` exposed in chat | Grants tenant portal access. Regenerate from the portal. | you |
| 4 | MEDIUM | `npm audit`: 19 vulnerabilities (5 moderate, 13 high, **1 critical**) | Some may sit in the WhatsApp/payment paths. Needs a deliberate pass — blind `npm audit fix --force` is how a revenue path breaks. | later, separately |
| 5 | MEDIUM | `[TENANT LOOKUP] Found 0 candidate(s) for '254786817637'` | Inbound from the main number resolves to **no tenant**, so the bot answers as generic Alphadome. A mapping gap in `bot_tenants` ↔ `site_tenants`. | later |
| 6 | MEDIUM | Only 78 of 226 Turing roles collected | First listing page plus 6 "Load more" clicks. Importing the same file again creates nothing; deeper paging still needs ~14 more clicks. | next slice |
| 7 | **CLOSED** (revenue path working) | Per-role referral capture + **link verification** | 76 links captured and **76 verified** (`match`, 0 wrong, 0 unreadable) after the batch run completed. The one bad link found earlier — Project Lead pointing at *Strategic Project Lead – Software Engineering* — was cleared and replaced with a verified one. Every link is now resolved against its job page before it can be written. | done |
| 11 | MEDIUM | `migrations/2026-11-01_add_referral_link_verification.sql` **not applied** | The portal badge (*"N links verified"* / red when a link points at the wrong job) reads `opportunities.link_verdict`, which the audit writes and this migration adds. Until it is applied the strip honestly says *"N links not yet verified"* rather than pretending everything is fine. Run the SQL in Supabase → SQL editor, then re-run the audit to populate it. | **closed 2026-11-01** (applied; 76 verdicts recorded) |
| 12 | INFO | Micro1 links are **the tenant's own**, not ours | 5 links, created 2026-10-28…30, `external_id` null, one `referralCode` across all five — their account code. No Micro1 adapter exists and `browser_actor_collect.mjs` refuses any platform except Turing, so nothing of ours can have written them. Verified 2026-11-01. | closed as fact |
| 10 | **OPPORTUNITY** | Every Turing role has a real deep link: `work.turing.com/jobs?jobId=<id>` | The adapter recorded "no per-card href"; live clicking exposed `jobId=112467`, `jobId=112289`. All 78 offers point at the bare listing, so a referred candidate lands on "All 226" instead of their job. A 78-click capture run would give each role its own `destination_url` — cheap, verified, and it makes every page honest. | next slice |
| 8 | INFO | The LinkedIn **app** cannot receive prefilled text | Vendor limitation, not a bug. Mobile copies the caption and opens LinkedIn; the paste is unavoidable. Documented in `BROWSER_ACTOR_RUNTIME.md`. | closed as limitation |
| 9 | INFO | X posting returns `409 social_not_configured` until a token is set | Correct refusal, not a failure. `SOCIAL_X_TOKENS` unlocks `Post to X`; `X (prefill)` works without it. | you (optional) |
| 13 | **ACTION** | `migrations/2026-11-02_writer_flow_runs.sql` **not applied** | Adds `browser_actor_runs` (per-tenant run tracking + the one-active-run-per-tenant index) and `opportunities.link_note` (a human's decision about a link). Until it is applied the portal panel still renders and the **Verify links** button still works — it says "link health unavailable" and refuses *Accept* with a 503 naming this file. Apply it and the run history + accept/clear trail switch on. | you (Supabase SQL editor) |
| 14 | INFO | 4 of 78 marketplace offers still show a tile summary, and they are **delisted roles** | `Resident Medical Specialist (MD/DO)`, `Content Analyst`, `Azure DevOps Engineer(LangGraph)`, `Medicine Physician (MD/DO/Doctoral study/PhD)`. A 121-role sweep captured every role currently listed and planned **0** description updates: these four no longer appear in the marketplace listing, so there is no page left to read. Their links still resolve. Deal with them by retiring the offers, not by re-running the capture. | decided, no action |
| 15 | INFO | Descriptions after the sweep: **74/78 marketplace offers at full text**, median **3,428** chars, **0 empty** | Up from a median of 73 characters at the start of the day. The 18 hand-written offers are excluded from the ratio — they have no source page, so calling them "missing" would ask an agent to invent content. | closed |


## How to verify a flag is fixed

- **#1** → Render log stops printing `signature verification skipped`, and a forged `POST /webhook` without `X-Hub-Signature-256` is rejected.
- **#2/#3** → old credentials fail; `.env` and Render hold the new ones; app boots.
- **#6** → `willCreate` in the import dry run drops as roles get added; second run reports `0`.
- **#7** → a role's offer shows `Referral ✓` without you pasting anything.
