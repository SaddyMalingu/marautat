-- ============================================================================
-- ALPHADOME MULTI-TENANT AI JOBS — Phase 1: site_tenants registry (ADDITIVE)
-- ============================================================================
-- Goal: Introduce a dedicated multi-tenant registry (alphadome.site_tenants)
--       for the AI Jobs / blog / referral engine, WITHOUT breaking the live
--       Mercor experience on alphadome.onrender.com.
--
-- Safety contract:
--   * ADDITIVE ONLY — new table + new NULLABLE columns. No drops/renames.
--   * IDEMPOTENT — safe to re-run (IF NOT EXISTS everywhere).
--   * ZERO DATA LOSS — every existing row is backfilled to tenant 'default'.
--   * BACKWARD COMPATIBLE — tenant_id defaults to 'default' tenant; existing
--     queries keep working because nothing requires tenant_id yet.
--
-- Rollback: see 2026-10-11_add_site_tenants_multitenant_ROLLBACK.sql
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS alphadome;

-- ---------------------------------------------------------------------------
-- 1. site_tenants — one row per branded micro-site / vertical
--    e.g. 'default' (Alphadome/Mercor today), 'health', 'real-estate', ...
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alphadome.site_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,                 -- url segment, e.g. 'health'
  name text NOT NULL,                        -- display name, e.g. 'Health Gigs'
  description text,
  -- Branding / SEO
  logo_url text,
  primary_color text,
  seo_title text,
  seo_description text,
  -- Security: per-tenant allowed redirect domains (jsonb array of hostnames)
  allowed_redirect_domains jsonb DEFAULT '[]'::jsonb,
  is_active boolean DEFAULT true,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_tenants_slug   ON alphadome.site_tenants(slug);
CREATE INDEX IF NOT EXISTS idx_site_tenants_active ON alphadome.site_tenants(is_active);

-- ---------------------------------------------------------------------------
-- 2. Seed the 'default' tenant = today's Alphadome/Mercor experience.
--    Preserves current behavior: all pre-existing content maps here.
-- ---------------------------------------------------------------------------
INSERT INTO alphadome.site_tenants (slug, name, description, allowed_redirect_domains, is_active)
VALUES (
  'default',
  'Alphadome',
  'Default Alphadome site (legacy Mercor experience).',
  '["t.mercor.com","mercor.com","www.mercor.com"]'::jsonb,
  true
)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Add NULLABLE tenant_id to the existing AI Jobs / blog tables.
--    NULLABLE keeps this non-breaking; backfill below fills them.
--    FK uses ON DELETE SET NULL so removing a tenant never deletes content.
-- ---------------------------------------------------------------------------

-- 3a. opportunity_sources
ALTER TABLE alphadome.opportunity_sources
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES alphadome.site_tenants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_opportunity_sources_tenant ON alphadome.opportunity_sources(tenant_id);

-- 3b. opportunity_categories
ALTER TABLE alphadome.opportunity_categories
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES alphadome.site_tenants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_opportunity_categories_tenant ON alphadome.opportunity_categories(tenant_id);

-- 3c. opportunities
ALTER TABLE alphadome.opportunities
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES alphadome.site_tenants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_opportunities_tenant ON alphadome.opportunities(tenant_id);

-- 3d. referral_links
ALTER TABLE alphadome.referral_links
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES alphadome.site_tenants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_referral_links_tenant ON alphadome.referral_links(tenant_id);

-- 3e. opportunity_events (analytics)
ALTER TABLE alphadome.opportunity_events
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES alphadome.site_tenants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_opportunity_events_tenant ON alphadome.opportunity_events(tenant_id);

-- 3f. blog_posts lives in public schema
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES alphadome.site_tenants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_blog_posts_tenant ON public.blog_posts(tenant_id);

-- ---------------------------------------------------------------------------
-- 4. Backfill: attach every existing row to the 'default' tenant.
--    Only fills NULLs, so re-runs are safe.
-- ---------------------------------------------------------------------------
UPDATE alphadome.opportunity_sources    SET tenant_id = (SELECT id FROM alphadome.site_tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE alphadome.opportunity_categories SET tenant_id = (SELECT id FROM alphadome.site_tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE alphadome.opportunities          SET tenant_id = (SELECT id FROM alphadome.site_tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE alphadome.referral_links         SET tenant_id = (SELECT id FROM alphadome.site_tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE alphadome.opportunity_events     SET tenant_id = (SELECT id FROM alphadome.site_tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE public.blog_posts                SET tenant_id = (SELECT id FROM alphadome.site_tenants WHERE slug = 'default') WHERE tenant_id IS NULL;

COMMIT;

-- ============================================================================
-- POST-MIGRATION VERIFICATION (run manually; expect NO rows with NULL tenant_id
-- among pre-existing content, and exactly one 'default' tenant):
--
--   SELECT id, slug, name, is_active FROM alphadome.site_tenants ORDER BY slug;
--
--   SELECT 'sources'    t, count(*) total, count(tenant_id) scoped FROM alphadome.opportunity_sources
--   UNION ALL SELECT 'categories', count(*), count(tenant_id) FROM alphadome.opportunity_categories
--   UNION ALL SELECT 'opportunities', count(*), count(tenant_id) FROM alphadome.opportunities
--   UNION ALL SELECT 'referral_links', count(*), count(tenant_id) FROM alphadome.referral_links
--   UNION ALL SELECT 'events', count(*), count(tenant_id) FROM alphadome.opportunity_events
--   UNION ALL SELECT 'blog_posts', count(*), count(tenant_id) FROM public.blog_posts;
-- ============================================================================
