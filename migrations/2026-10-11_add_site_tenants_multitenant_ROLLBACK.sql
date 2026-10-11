-- ============================================================================
-- ALPHADOME MULTI-TENANT AI JOBS — Phase 1 ROLLBACK (SCHEMA-AGNOSTIC)
-- ============================================================================
-- Reverts 2026-10-11_add_site_tenants_multitenant.sql (the schema-agnostic
-- self-bootstrapping version).
--
-- Safety: Drops ONLY the new tenant_id columns/indexes and the site_tenants
--         table — in BOTH public and alphadome (whichever exist). It does NOT
--         touch content rows, so the app returns to its exact pre-Phase-1
--         behavior. NOTE: tables that were newly CREATED by the forward
--         migration (self-bootstrap on a fresh DB) are intentionally LEFT in
--         place (empty) — dropping them is unnecessary and riskier.
-- ============================================================================

BEGIN;

-- 1. Drop tenant_id columns wherever they exist (public + alphadome).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'opportunity_sources','opportunity_categories','opportunities',
    'referral_links','opportunity_events','blog_posts'
  ] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS tenant_id', t);
    END IF;
    IF to_regclass('alphadome.'||t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE alphadome.%I DROP COLUMN IF EXISTS tenant_id', t);
    END IF;
  END LOOP;
END $$;

-- 2. Drop tenant indexes if any survive (safe with IF EXISTS).
DROP INDEX IF EXISTS public.idx_opportunity_sources_tenant;
DROP INDEX IF EXISTS public.idx_opportunity_categories_tenant;
DROP INDEX IF EXISTS public.idx_opportunities_tenant;
DROP INDEX IF EXISTS public.idx_referral_links_tenant;
DROP INDEX IF EXISTS public.idx_opportunity_events_tenant;
DROP INDEX IF EXISTS public.idx_blog_posts_tenant;
DROP INDEX IF EXISTS alphadome.idx_opportunity_sources_tenant_a;
DROP INDEX IF EXISTS alphadome.idx_opportunity_categories_tenant_a;
DROP INDEX IF EXISTS alphadome.idx_opportunities_tenant_a;
DROP INDEX IF EXISTS alphadome.idx_referral_links_tenant_a;
DROP INDEX IF EXISTS alphadome.idx_opportunity_events_tenant_a;
DROP INDEX IF EXISTS alphadome.idx_blog_posts_tenant_a;

-- 3. Drop the registry table(s).
DROP TABLE IF EXISTS public.site_tenants;
DROP TABLE IF EXISTS alphadome.site_tenants;

COMMIT;

-- ============================================================================
-- NOTE: If you only want to DISABLE multi-tenancy without dropping schema,
-- do NOT run this file. Instead set the app flag AI_JOBS_MULTITENANT=false
-- (Phase 3) — that is an instant, code-only revert. Use THIS rollback only
-- when you want the schema fully back to its pre-Phase-1 shape.
-- ============================================================================

