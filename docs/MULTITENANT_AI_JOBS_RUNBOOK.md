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
**blog generation** (must never return 200 with 0 posts), **blog coverage**
(warns when fewer than 9 angles produced a post), public page, cleanup, **blog
cleanup** (generated `verify-writers-flow-*` posts are deleted).

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
| `404` + `unavailable for free` | the free model slug was retired (2026-10-22: `llama-3.1-8b-instruct:free`) | nothing — the writer now falls through `OPENROUTER_FREE_MODELS` on `404`; pin `OPENROUTER_MODEL` only to choose a specific model |
| `404` (any other) | model route not available on that account | set `OPENROUTER_MODEL` / `HF_MODEL` |
| `429` / `RESOURCE_EXHAUSTED` | free-tier quota | wait for the window to reset, or add `OPENROUTER_API_KEY` (free tier: 50 req/day, 1000/day after a one-time $10 credit) |
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
| `OPENROUTER_MODEL` | unset → falls through `google/gemma-4-31b-it:free`, `minimax/minimax-m3.1-flash:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `poolside/laguna-s-2.1:free` (a retired `:free` slug answers `404` and the next one is tried) |
| `GEMINI_API_KEY` | — (free tier, no card) |
| `GEMINI_MODEL` | `gemini-flash-latest` (pin `gemini-3.8-flash` to freeze) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | — / `gpt-4o-mini` |
| `HF_API_KEY` / `HF_MODEL` | — / `meta-llama/Llama-3.1-8B-Instruct:novita` |
| `*_BASE_URL` | provider default (used by the offline test) |

`npm run test:ai-providers` proves the whole chain offline against a stub
server — no keys, no network, no DB. It reproduces the 402 incident, verifies
fallback order, empty-content handling, model override, the retired-slug
fallthrough (13 checks) and the no-key message.

**Free-tier budget.** One journey is 9 sequential LLM calls (one per angle), so a
handful of test runs exhausts a small free tier — a real `429` from Gemini after
repeated runs is expected, not a code bug. OpenRouter's free tier (50 req/day,
1000/day with a one-time $10 credit) is the sustainable demo path; keep it as the
first provider and let Gemini sit second.

### Phase B (next) — Research & Outreach
Tenant-scope the original WF: add `wf_campaigns.tenant_id`, `/tenant/wf/*` endpoints,
per-tenant SMTP, and the Research & Outreach tab UI.

## Next (Phase 4, optional)
- Converge tenant resolution onto `alphadome-kernel` behind parity tests.
- Per-tenant custom domains / branded paths; respondent.io sample offers.
- Founder's-plan gating for Writer's Flow (currently shown to all active tenants).


