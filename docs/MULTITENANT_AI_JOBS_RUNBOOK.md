# Multi-Tenant AI Jobs — Phase 1 Runbook (site_tenants)

**Decision:** Option B — dedicated `alphadome.site_tenants` registry for the AI Jobs / blog / referral engine. Isolated from the WhatsApp `bot_tenants` path so the live money flow is never at risk.

**Status:** Phase 0 (safety net) + Phase 1 (additive schema) complete. Phases 2-4 pending your go-ahead.

## Rollback points (created in Phase 0)
- Tag `pre-multitenant-baseline` -> committed HEAD before any work.
- Branch `feat/multi-tenant-ai-jobs` holds all work.
- Your original uncommitted edits are preserved in commit `8a9ebcc` (wip safeguard).

To abandon everything and return to the exact prior state:
```
git checkout main
git branch -D feat/multi-tenant-ai-jobs   # optional
```

## Files added in Phase 1
- `migrations/2026-10-11_add_site_tenants_multitenant.sql` — forward (additive)
- `migrations/2026-10-11_add_site_tenants_multitenant_ROLLBACK.sql` — revert (drops only new objects)
- `scripts/validate_site_tenants_phase1.cjs` — read-only validation + optional isolation proof
- npm scripts: `npm run tenants:validate`, `npm run tenants:validate:isolation`

## What Phase 1 changes
- Creates `alphadome.site_tenants` (slug, name, branding, `allowed_redirect_domains`, is_active).
- Seeds tenant `default` (= today's Mercor experience).
- Adds NULLABLE `tenant_id` to: `opportunity_sources`, `opportunity_categories`, `opportunities`, `referral_links`, `opportunity_events`, `public.blog_posts`.
- Backfills every existing row to `default`.
- **No code reads `tenant_id` yet** -> live behavior is byte-for-byte unchanged.

## Apply to STAGING first (recommended)
```
# 1) Point at staging Supabase
$env:SUPABASE_URL="https://<staging-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<staging-service-role-key>"

# 2) Apply forward migration (Supabase SQL Editor: paste & run the .sql)
#    Path: migrations/2026-10-11_add_site_tenants_multitenant.sql

# 3) Validate structure (read-only)
& 'C:\Program Files\nodejs\node.exe' scripts/validate_site_tenants_phase1.cjs

# 4) Prove isolation (creates + removes its own throwaway rows)
$env:RUN_ISOLATION_TEST='true'; & 'C:\Program Files\nodejs\node.exe' scripts/validate_site_tenants_phase1.cjs
```
Expected: all checks PASS, `default` tenant present, `total == scoped` on every table.

## Promote to PRODUCTION
Only after staging is green and you've confirmed the live site still renders `/ai-jobs` and `/ai-jobs/mercor/*`:
1. Open Supabase prod -> SQL Editor.
2. Run `migrations/2026-10-11_add_site_tenants_multitenant.sql`.
3. Run the verification SELECTs at the bottom of that file.
4. Re-run the validator against prod (read-only).

## Revert Phase 1 (if ever needed)
- **Code-only instant revert (preferred, Phase 3):** set `AI_JOBS_MULTITENANT=false`. No DB change.
- **Full schema revert:** run `..._ROLLBACK.sql` (drops only the new columns + `site_tenants`; content untouched).

## Phase 3 — Multi-Tenant Traffic Engine (DONE, commit fb15c4f)
Generalized the engine beyond jobs: any `site_tenant` can drive SEO traffic to ANY offer
(job, product, service, brand, affiliate, course). All flag-gated + backward compatible.

**Data model (additive):** `opportunities` gains `offer_type` (default 'job'), `cta_label`,
`destination_url`. Existing rows backfill to `offer_type='job'` → identical behavior.
- Migration: `migrations/2026-10-15_phase3_offer_types.sql` (run BEFORE deploy).

**Feature flag:** `AI_JOBS_MULTITENANT` (default OFF). When OFF, `/ai-jobs/t/*` returns 404
and nothing changes. Set `AI_JOBS_MULTITENANT=true` in Render env to enable.

**New tenant routes (when flag ON):**
- `GET /ai-jobs/t/:tenantSlug` — tenant hub (all offers, type-badged)
- `GET /ai-jobs/t/:tenantSlug/o/:offerSlug` — individual offer (offer-aware CTA)
- `GET /ai-jobs/t/:tenantSlug/:categorySlug` — tenant category

**Offer-aware CTAs:** job→Apply, product→Shop Now, service→Learn More, brand→Explore,
affiliate→Get Deal, course→Enroll. Admin `/admin/ai-jobs` now has Tenant + Source + Offer
Type + Destination URL + CTA pickers on the create form.

### Deploy order (important — migration BEFORE code)
1. Supabase SQL Editor → run `migrations/2026-10-15_phase3_offer_types.sql` (additive, safe).
2. Push branch → `main`; Render redeploys.
3. (Optional) set `AI_JOBS_MULTITENANT=true` in Render to turn on tenant routes.
4. Live-test:
   - `/ai-jobs` and `/ai-jobs/mercor/*` unchanged.
   - `/ai-jobs/s/respondent` unchanged.
   - With flag ON: `/ai-jobs/t/default` lists all default-tenant offers.
   - Create a `product` offer in admin (set Destination URL) → it renders with "Shop Now".

## Rollback
- Instant: set `AI_JOBS_MULTITENANT=false` (tenant routes 404; everything else unchanged).
- Schema: `migrations/2026-10-15_..._ROLLBACK` not required (columns are nullable/additive);
  to fully revert, drop the 3 columns or redeploy previous commit.

## Phase A — Tenant-Portal Writer's Flow (Blogger) — commit 11e4f12
Exposes a **Writer's Flow** section in the tenant portal (`/tenant-dashboard`) for
founder's-plan clients, with two tabs: **Research & Outreach** (placeholder) and **Blogger**
(fully functional, tenant-scoped).

- **Nav:** new "Growth → Writer's Flow" item (`data-sec="writers-flow"` → `renderWritersFlow`).
- **Migration:** `2026-10-16_tenant_blogger.sql` adds `site_tenants.client_phone`
  (links a logged-in `bot_tenants` to its Blogger `site_tenants` row). **Run BEFORE deploy.**
- **APIs (tenantSessionAuth, auto-scoped):** `GET /tenant/blogger`,
  `POST /tenant/blogger/offers`, `POST /tenant/blogger/offers/:id/publish`,
  `POST /tenant/blogger/offers/:id/blog`, `DELETE /tenant/blogger/offers/:id`,
  `DELETE /tenant/blogger/posts/:slug` (only posts with this tenant's `tenant_id`;
  removes the row and the static `public/blog/<slug>.html`).
- **Scoping:** on first Blogger access, a `site_tenants` row is lazily created from the
  tenant's `bot_tenants` name/phone → public page at `/ai-jobs/t/<their-slug>`.
- **One journey per offer:** `generateBlogPostsForOpportunity` holds an in-process
  lock keyed by offer id and returns `{ success:false, busy:true }` for a second
  concurrent call — the route answers **409** instead of starting a competing
  walk. Live 2026-10-22 a double click ran two walks on the same offer; they
  rate-limited each other on the shared free tier and both ran past 14 minutes.
  Verified live the same day on `589d7d0`: `POST …/blog 409 - 217ms` while the
  first run was still walking (client saw `409 busy` in 1.05 s). The verifier
  asserts this on every run (check **8a**), so a regression to "two walks per
  click" fails the suite rather than just costing minutes.
- **Posts outlive their offer:** if the offer row is deleted mid-run, the
  `blog_posts_opportunity_id_fkey` insert is retried without `opportunity_id`
  (the page stays on disk, in the tenant's list, and in restore-on-boot) instead
  of being lost to a logged `[DB] Save error`.
- **Public page requires** `AI_JOBS_MULTITENANT=true`.

### Deploy order (migration BEFORE code)
1. SQL Editor → run `migrations/2026-10-16_tenant_blogger.sql`.
2. Push → `main`; Render redeploys.
3. Log into `/tenant-dashboard` → **Writer's Flow** → **Blogger** tab.
4. Create an offer (any type) → Publish → open the public page (flag must be ON).

### Verify a deployment — `npm run verify:writers-flow`
End-to-end check of the live host (`scripts/verify_writers_flow.js`). It reports
PASS / FAIL / WARN per check and always deletes the rows it creates.

```bash
BASE_URL=https://alphadome.onrender.com \
TENANT_TEST_PHONE=<tenant phone> TENANT_DASHBOARD_PASS=<tenant key> \
npm run verify:writers-flow
```

Checks: **build identity** (is the served bundle the latest commit?), route
registration (401 not 404, plus a 404 control), login, context, offer create,
**slug collision** (same title twice must yield two slugs), publish,
**blog generation** (must never return 200 with 0 posts), **double click**
(a second run on the same offer while the first is live must answer
`409 {busy:true}` immediately — probed 1.5 s into the run, so it costs no extra
time), **blog coverage** (warns when fewer than 9 unique angle pages were
written, and reports `mode=ai|template|mixed`), **bounded run** (fails if the
generation call exceeds 120 s wall clock, i.e. the `BLOG_RUN_BUDGET_MS` ceiling
stopped being applied), public page, cleanup, **blog
cleanup** (generated `verify-writers-flow-*` posts are deleted).

Live baseline on `589d7d0` (2026-10-22 13:42 UTC): 18 passed / 0 failed /
0 warnings — `409 busy` in 1.05 s, 9 posts in 82.8 s, 9/9 unique pages, 9 posts
deleted, offers back to 3.

Re-run on `2c5405c` (13:53 UTC) with the daily free quota **fully exhausted**:
18 passed / 0 failed / 0 warnings, `mode=template`, 9/9 pages in **19.1 s**
(`blog 200 - 18832ms`, `409 - 379ms`). A dry quota is fast, not slow: the first
angle fails provider-wide, `isAiFailureFatal()` stops the walk, and the remaining
eight pages are composed from the offer data. So the two worst cases are both
bounded — half-dry ≈ the 90 s budget, fully dry ≈ 20 s — and neither can return
fewer than nine pages.

Exit `0` = no failures, `1` = at least one, `2` = missing config. A stale
`build identity` FAIL means the host is serving an older commit — redeploy from
the Render dashboard (this repo has no CI deploy job).

### When blog generation fails — `npm run test:ai-providers`
The writer never fabricates posts: if the LLM returns nothing it fails loudly
and the 502 body ends with `Last AI error: <provider> <status> <body>`. That
string is the diagnosis — you do not need host logs.

| `Last AI error` contains | Meaning | Fix |
| --- | --- | --- |
| `openrouter/hf 402 no remaining credits` | key valid, account out of credits | set `GEMINI_API_KEY` (free, no card) or `OPENROUTER_API_KEY`, or buy credits |
| `401` / `unauthor` | key revoked or wrong | rotate the key on Render |
| `404` + `unavailable for free` | the free model slug was retired (2026-10-22: `llama-3.1-8b-instruct:free`) | nothing — the writer now falls through `OPENROUTER_FREE_MODELS` on `404`, including past a retired `OPENROUTER_MODEL` pin; clear the pin if the console logs show it leading every run |
| `404` (any other) | model route not available on that account | set `OPENROUTER_MODEL` / `HF_MODEL` |
| `429` + `rate-limited upstream` | that one model's upstream pool is saturated; the key is fine | nothing — the writer advances to the next slug in `OPENROUTER_FREE_MODELS` (live 2026-10-22: gemma-4-31b was throttled while five siblings were healthy) |
| `429` + `You exceeded your current quota` | your own free-tier quota (per day) | wait for the reset window, add a second key, or add credits (OpenRouter free tier: 50 req/day, 1000/day after a one-time $10 credit) |
| only 1 post written, run then stops | fail-fast matched one exhausted provider (e.g. `hf 402`) in the joined error string | fixed 2026-10-22: only an all-provider auth/billing failure aborts a journey; redeploy and re-run the verifier |
| `verify-writers-flow-*` posts visible on `/blog` | verifier runs published real posts before the post-delete endpoint existed | `npm run prune:verify-posts` on the host to list them, `npm run prune:verify-posts -- --apply` to delete (needs `SUPABASE_SERVICE_ROLE_KEY`) |
| `no AI provider key configured` | no key at all | set one of the three keys |

Providers are tried in order — **OpenRouter → Gemini → OpenAI → HuggingFace** —
so any single key is enough. The journey only aborts when **every** provider it
could try failed on auth/billing (`401/402/403`, "no remaining credits"). One
exhausted provider next to a healthy one, or a `429` / `RESOURCE_EXHAUSTED`
quota reply, lets the remaining angles continue — otherwise a permanently dead
HuggingFace `402` in the chain caps every run at one post.

**Zero-spend recovery.** Google AI Studio issues a `GEMINI_API_KEY` with a free
tier and no credit card (https://aistudio.google.com/apikey). The writer talks to
Gemini through its OpenAI-compatible endpoint
(`https://generativelanguage.googleapis.com/v1beta/openai`), so setting only that
one var restores generation on the next restart — no code change and no purchase.

Relevant env (all optional except one key):

| Var | Default |
| --- | --- |
| `OPENROUTER_API_KEY` | — (preferred; alias `OPENROUTER_KEY` accepted) |
| `OPENROUTER_MODEL` | unset → tries `google/gemma-4-31b-it:free`, `minimax/minimax-m3.1-flash:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `google/gemma-4-26b-a4b-it:free`, `nvidia/nemotron-3.5-lightning:free`, `poolside/laguna-s-2.1:free`, `openrouter/free` in order. A pin is tried **first** and the free list still follows it, so a retired pin cannot starve the writer (2026-10-22: the host was pinned to `llama-3.1-8b-instruct:free`, OpenRouter retired it, and every angle 404'd while three healthy free models sat unused). Retired (`404`) and throttled (`429`) slugs advance to the next model; only `401/402/403` stops the list |
| `BLOG_ANGLE_DELAY_MS` | `1200` — pause between angles so nine sequential calls stay inside per-minute free limits; set `0` on a paid key |
| `BLOG_FALLBACK_MODE` | `auto` — when an angle gets nothing from every provider, compose it from the offer's own fields (`public/blog/<slug>.html` still gets a full page). `off` restores the loud 502 for diagnosis |
| `BLOG_AI_MAX_MISSES` | `2` — consecutive angles that return nothing from any provider before the rest of the run is composed without further AI calls. This is a latency budget, not a quorum rule: per-run only, so the next run tries AI again. `0` always walks every angle |
| `BLOG_AI_TIMEOUT_MS` | `30000` per HTTP attempt (was `120000`). A provider that accepts the connection then stalls must not hold the tenant's request open for two minutes per model slug |
| `BLOG_RUN_BUDGET_MS` | `90000` — hard wall-clock ceiling for the whole AI walk, counted from the first angle and applied to **every** AI call (compose, duplicate retry, review). When it is spent the remaining angles are composed from the offer data, so a run finishes in roughly this long with all nine pages. Live 2026-10-22: `1 of 9 pages in 6 minutes` while free slugs answered `429` and the stall burned the old 120 s per-attempt timeout; later that day a run that answered **one** angle out of nine still held the request `166 s` (`mode=mixed`, 8 pages composed anyway) because the ceiling was only applied after a miss. Fixed on `589d7d0` the same day: the deadline now applies to every call, and the same nine-angle run that previously took `166 s` returned in **`82.8 s`** with **9/9** unique pages (8 composed from the offer data, `mode=mixed`) — the verifier's **8c** check fails the suite if a run ever exceeds 120 s again. Raise the budget (e.g. `240000`) on a funded key where AI copy matters more than latency. `0` disables the ceiling |
| `BLOG_ANGLE_BUDGET_MS` | `45000` — ceiling for **one angle's** provider walk. A single angle tries up to seven candidate model slugs on one key: live 2026-10-22 one angle cost 37 s (5 models, one stalled 23 s before returning `429`). Effective per-call deadline is `min(now + this, run deadline)`, and each call in an angle (compose, duplicate retry, review) gets its own slice. Set `0` to cap only per attempt. The review pass is skipped once 60 % of the run budget is spent, so the tail of the budget buys AI-written pages rather than polish on page three |
| `GEMINI_API_KEY` | — (free tier, no card) |
| `GEMINI_MODEL` | `gemini-flash-latest` (pin `gemini-3.8-flash` to freeze) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | — / `gpt-4o-mini` |
| `HF_API_KEY` / `HF_MODEL` | — / `meta-llama/Llama-3.1-8B-Instruct:novita` |
| `*_BASE_URL` | provider default (used by the offline test) |

`npm run test:ai-providers` proves the whole chain offline against a stub
server — no keys, no network, no DB. It reproduces the 402 incident and the
2026-10-22 live failures, and verifies fallback order, empty-content handling,
model override, retired-slug fallthrough, throttled-slug (`429`) fallthrough and
the 402-still-aborts rule (17 checks), plus the no-key message.

**Free-tier budget.** One journey is 9 sequential generation calls plus one
review call per post, so a handful of test runs exhausts a small free tier — a
real `429` from Gemini after repeated runs is expected, not a code bug. Angles
are paced by `BLOG_ANGLE_DELAY_MS` (default 1200 ms) and each throttled slug
falls through to the next model, so nine angles can complete on free slugs alone.
OpenRouter's free tier (50 req/day, 1000/day with a one-time $10 credit) is the
sustainable demo path; keep it as the first provider and let Gemini sit second.

**When every tier is dry at once** (live 2026-10-22: OpenRouter `429` on the
remaining free slugs, Gemini daily quota spent, HuggingFace `402`), the journey
no longer ends empty. Each angle is composed from the offer's own fields by
`utils/angleFallback.js` — title, type, price, location, skills, CTA — and the
run still writes nine pages under nine distinct URLs. The response says so:

| Field | Meaning |
| --- | --- |
| `result.mode` | `ai` (every angle from a model), `template` (every angle composed), `mixed` (the AI tier recovered mid-run) |
| `result.fallback` | how many posts were composed rather than generated |
| `posts[].fallback` | `true` on a composed post — the dashboard toast says "composed from offer details" |

Composed copy is deliberately honest: it never invents a price (it asks for one
when the offer states none) and it escapes tenant-supplied fields. It is a demo
and continuity guarantee, not an AI substitute — the page reads as structured
advice, and the flags above make sure nobody claims a model wrote it.

`npm run test:blog-fallback` covers this path offline (10 checks): a unique slug
per angle, 230+ words per composed post, no pair above the duplicate threshold,
survival with a title-only offer, HTML escaping, no markdown artefacts, the
price never invented, CTA resolution for every offer type, plus both directions
of the job/buyer split described below.

**Offers are not all jobs.** The journey was written for the Mercor job catalog,
so a tenant's service listing produced "How to Get Hired as a Kassangas Music
Shop" and "Remote … Jobs" on its own blog. Every template now branches on
`offer_type`: `job` (the default, which is what every legacy row and every
untyped row resolves to) keeps the career copy, everything else gets buyer copy
("What It Costs and What You Get", "How to Brief …", "Taking … Beyond a Single
Site"). The prompts branch too, so the AI is not asked to write career advice
for a service either.

**One page per angle.** Until 2026-10-22 the two templates inside an angle were
slugged `<offer>-<angle>`, so the second post overwrote the first — a "9 of 9
angles" run wrote five pages. Slugs now carry the stage
(`<offer>-awareness-1`, `<offer>-awareness-2`, …) and the verifier counts unique
slugs, not array entries.

### Phase B (next) — Research & Outreach
Tenant-scope the original WF: add `wf_campaigns.tenant_id`, `/tenant/wf/*` endpoints,
per-tenant SMTP, and the Research & Outreach tab UI.

## Next (Phase 4, optional)
- Converge tenant resolution onto `alphadome-kernel` behind parity tests.
- Per-tenant custom domains / branded paths; respondent.io sample offers.
- Founder's-plan gating for Writer's Flow (currently shown to all active tenants).


