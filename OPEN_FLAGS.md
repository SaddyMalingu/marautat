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
| 7 | **HIGH (revenue)** — *capture works, links verified* | Per-role referral capture + **link verification** | `--limit 5 --apply` wrote 4 links; `referralVerify.js` then proved where each one lands. An audit of all 11 stored links found **1 wrong**: Project Lead - AI Training pointed at *Strategic Project Lead – Software Engineering*. It was cleared and replaced with a verified `r/xako-8LrQK`. The capture path now refuses any link whose page title does not match its role, so this cannot recur. Remaining: ~72 offers still have no link (`--limit 72 --apply`). | next slice |
| 10 | **OPPORTUNITY** | Every Turing role has a real deep link: `work.turing.com/jobs?jobId=<id>` | The adapter recorded "no per-card href"; live clicking exposed `jobId=112467`, `jobId=112289`. All 78 offers point at the bare listing, so a referred candidate lands on "All 226" instead of their job. A 78-click capture run would give each role its own `destination_url` — cheap, verified, and it makes every page honest. | next slice |
| 8 | INFO | The LinkedIn **app** cannot receive prefilled text | Vendor limitation, not a bug. Mobile copies the caption and opens LinkedIn; the paste is unavoidable. Documented in `BROWSER_ACTOR_RUNTIME.md`. | closed as limitation |
| 9 | INFO | X posting returns `409 social_not_configured` until a token is set | Correct refusal, not a failure. `SOCIAL_X_TOKENS` unlocks `Post to X`; `X (prefill)` works without it. | you (optional) |

## How to verify a flag is fixed

- **#1** → Render log stops printing `signature verification skipped`, and a forged `POST /webhook` without `X-Hub-Signature-256` is rejected.
- **#2/#3** → old credentials fail; `.env` and Render hold the new ones; app boots.
- **#6** → `willCreate` in the import dry run drops as roles get added; second run reports `0`.
- **#7** → a role's offer shows `Referral ✓` without you pasting anything.
