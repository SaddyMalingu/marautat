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
  `POST /tenant/blogger/offers/:id/blog`, `DELETE /tenant/blogger/offers/:id`.
- **Scoping:** on first Blogger access, a `site_tenants` row is lazily created from the
  tenant's `bot_tenants` name/phone → public page at `/ai-jobs/t/<their-slug>`.
- **Public page requires** `AI_JOBS_MULTITENANT=true`.

### Deploy order (migration BEFORE code)
1. SQL Editor → run `migrations/2026-10-16_tenant_blogger.sql`.
2. Push → `main`; Render redeploys.
3. Log into `/tenant-dashboard` → **Writer's Flow** → **Blogger** tab.
4. Create an offer (any type) → Publish → open the public page (flag must be ON).

### Phase B (next) — Research & Outreach
Tenant-scope the original WF: add `wf_campaigns.tenant_id`, `/tenant/wf/*` endpoints,
per-tenant SMTP, and the Research & Outreach tab UI.

## Next (Phase 4, optional)
- Converge tenant resolution onto `alphadome-kernel` behind parity tests.
- Per-tenant custom domains / branded paths; respondent.io sample offers.
- Founder's-plan gating for Writer's Flow (currently shown to all active tenants).


