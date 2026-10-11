-- ============================================================================
-- ALPHADOME MULTI-TENANT AI JOBS — Phase 1 ROLLBACK (ADDITIVE-SAFE)
-- ============================================================================
-- Reverts 2026-10-11_add_site_tenants_multitenant.sql.
--
-- Safety: This only DROPS the new tenant_id columns, their indexes, and the
--         new site_tenants table. It does NOT touch any content rows, so all
--         opportunities/categories/blogs/referral links remain intact and the
--         app returns to its exact pre-Phase-1 behavior.
--
-- Order matters: drop dependent columns BEFORE dropping site_tenants (FKs).
-- ============================================================================

BEGIN;

-- 1. Drop the tenant_id columns (drops their FK constraints automatically).
ALTER TABLE alphadome.opportunity_sources    DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE alphadome.opportunity_categories DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE alphadome.opportunities          DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE alphadome.referral_links         DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE alphadome.opportunity_events     DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE public.blog_posts                DROP COLUMN IF EXISTS tenant_id;

-- 2. Drop the tenant indexes (dropped with columns above, but be explicit for
--    any that survive). Safe with IF EXISTS.
DROP INDEX IF EXISTS alphadome.idx_opportunity_sources_tenant;
DROP INDEX IF EXISTS alphadome.idx_opportunity_categories_tenant;
DROP INDEX IF EXISTS alphadome.idx_opportunities_tenant;
DROP INDEX IF EXISTS alphadome.idx_referral_links_tenant;
DROP INDEX IF EXISTS alphadome.idx_opportunity_events_tenant;
DROP INDEX IF EXISTS public.idx_blog_posts_tenant;

-- 3. Drop the registry table itself (no rows reference it after step 1).
DROP TABLE IF EXISTS alphadome.site_tenants;

COMMIT;

-- ============================================================================
-- NOTE: If you only want to DISABLE multi-tenancy without dropping schema,
-- do NOT run this file. Instead set the app flag AI_JOBS_MULTITENANT=false
-- (Phase 3) — that is an instant, code-only revert. Use THIS rollback only
-- when you want the schema fully back to its pre-Phase-1 shape.
-- ============================================================================
