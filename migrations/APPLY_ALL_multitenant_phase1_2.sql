-- ============================================================================
-- COMBINED APPLY: Phase 1 (site_tenants) + Phase 2 seed (respondent.io)
-- Generated from the two verified migration files. Run ONCE in Supabase SQL Editor.
-- Additive + idempotent + transactional. Safe to re-run.
-- ============================================================================

-- ============================================================================
-- ALPHADOME MULTI-TENANT AI JOBS — Phase 1 (SCHEMA-AGNOSTIC + SELF-BOOTSTRAP)
-- ============================================================================
-- Replaces the earlier alphadome-prefixed version (which was never applied).
--
-- WHY THIS VERSION:
--   * The app reads every AI Jobs table UNQUALIFIED (supabase.from('opportunities'),
--     .from('blog_posts'), ...), which resolves to the `public` schema. So the
--     canonical home for these tables (and site_tenants) is `public`.
--   * Some environments may still have them under `alphadome`. This migration
--     DETECTS the real schema per table and acts there.
--   * If a table is MISSING (e.g. a fresh staging DB), it is CREATED here
--     (self-bootstrap) with its full definition + tenant_id.
--
-- SAFETY CONTRACT:
--   * ADDITIVE ONLY — new table + new NULLABLE columns. No drops/renames.
--   * IDEMPOTENT — safe to re-run.
--   * ZERO DATA LOSS — existing rows backfilled to tenant 'default'.
--   * NON-BREAKING — no hard FK (avoids table-lock on large tables); isolation
--     is enforced at the query layer + proven by scripts/validate_site_tenants_phase1.cjs.
--   * Transactional — any error aborts and commits nothing.
--
-- Rollback: migrations/2026-10-11_add_site_tenants_multitenant_ROLLBACK.sql
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS alphadome;

-- ---------------------------------------------------------------------------
-- 1. site_tenants (canonical home = public, so unqualified app reads work)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,                 -- url segment, e.g. 'health'
  name text NOT NULL,                        -- display name, e.g. 'Health Gigs'
  description text,
  logo_url text,
  primary_color text,
  seo_title text,
  seo_description text,
  allowed_redirect_domains jsonb DEFAULT '[]'::jsonb,
  is_active boolean DEFAULT true,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_tenants_slug   ON public.site_tenants(slug);
CREATE INDEX IF NOT EXISTS idx_site_tenants_active ON public.site_tenants(is_active);

-- Seed the 'default' tenant = today's Alphadome/Mercor experience.
INSERT INTO public.site_tenants (slug, name, description, allowed_redirect_domains, is_active)
VALUES (
  'default',
  'Alphadome',
  'Default Alphadome site (legacy Mercor experience).',
  '["t.mercor.com","mercor.com","www.mercor.com"]'::jsonb,
  true
)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Schema-agnostic ensure + tenant_id for each AI Jobs table.
--    Logic per table T:
--      a) If T is missing everywhere -> CREATE it in public (self-bootstrap).
--      b) Add nullable tenant_id (+ index) in whichever schema T lives.
--    Uses to_regclass() so it works whether tables are in public or alphadome.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  has_public  boolean;
  has_alpha   boolean;
BEGIN
  -- ============ opportunity_sources ============
  has_public := to_regclass('public.opportunity_sources')   IS NOT NULL;
  has_alpha  := to_regclass('alphadome.opportunity_sources') IS NOT NULL;
  IF NOT has_public AND NOT has_alpha THEN
    CREATE TABLE public.opportunity_sources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text UNIQUE NOT NULL,
      base_url text,
      source_type text DEFAULT 'referral',
      is_active boolean DEFAULT true,
      metadata jsonb DEFAULT '{}'::jsonb,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
    );
    has_public := true;
  END IF;
  IF has_public THEN
    ALTER TABLE public.opportunity_sources ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_opportunity_sources_tenant ON public.opportunity_sources(tenant_id);
  END IF;
  IF has_alpha THEN
    ALTER TABLE alphadome.opportunity_sources ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_opportunity_sources_tenant_a ON alphadome.opportunity_sources(tenant_id);
  END IF;

  -- ============ opportunity_categories ============
  has_public := to_regclass('public.opportunity_categories')   IS NOT NULL;
  has_alpha  := to_regclass('alphadome.opportunity_categories') IS NOT NULL;
  IF NOT has_public AND NOT has_alpha THEN
    CREATE TABLE public.opportunity_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text UNIQUE NOT NULL,
      description text,
      parent_id uuid,
      referral_url text,
      seo_title text,
      seo_description text,
      seo_keywords jsonb DEFAULT '[]'::jsonb,
      display_order integer DEFAULT 0,
      is_active boolean DEFAULT true,
      metadata jsonb DEFAULT '{}'::jsonb,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
    );
    has_public := true;
  END IF;
  IF has_public THEN
    ALTER TABLE public.opportunity_categories ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_opportunity_categories_tenant ON public.opportunity_categories(tenant_id);
  END IF;
  IF has_alpha THEN
    ALTER TABLE alphadome.opportunity_categories ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_opportunity_categories_tenant_a ON alphadome.opportunity_categories(tenant_id);
  END IF;

  -- ============ opportunities ============
  has_public := to_regclass('public.opportunities')   IS NOT NULL;
  has_alpha  := to_regclass('alphadome.opportunities') IS NOT NULL;
  IF NOT has_public AND NOT has_alpha THEN
    CREATE TABLE public.opportunities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_id uuid,
      external_id text,
      slug text UNIQUE NOT NULL,
      title text NOT NULL,
      description text,
      category_id uuid,
      subcategory text,
      compensation_min numeric,
      compensation_max numeric,
      compensation_currency text DEFAULT 'USD',
      compensation_type text DEFAULT 'hourly',
      location_text text,
      eligible_locations jsonb DEFAULT '[]'::jsonb,
      employment_type text DEFAULT 'contract',
      contract_type text,
      skills jsonb DEFAULT '[]'::jsonb,
      requirements jsonb DEFAULT '[]'::jsonb,
      experience_level text,
      application_url text,
      referral_url text,
      source_url text,
      status text DEFAULT 'draft',
      published_at timestamp with time zone,
      expires_at timestamp with time zone,
      last_verified_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now(),
      metadata jsonb DEFAULT '{}'::jsonb
    );
    has_public := true;
  END IF;
  IF has_public THEN
    ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_opportunities_tenant ON public.opportunities(tenant_id);
  END IF;
  IF has_alpha THEN
    ALTER TABLE alphadome.opportunities ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_opportunities_tenant_a ON alphadome.opportunities(tenant_id);
  END IF;

  -- ============ referral_links ============
  has_public := to_regclass('public.referral_links')   IS NOT NULL;
  has_alpha  := to_regclass('alphadome.referral_links') IS NOT NULL;
  IF NOT has_public AND NOT has_alpha THEN
    CREATE TABLE public.referral_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      link_key text UNIQUE NOT NULL,
      link_type text NOT NULL,
      source_id uuid,
      category_id uuid,
      referral_url text NOT NULL,
      is_active boolean DEFAULT true,
      metadata jsonb DEFAULT '{}'::jsonb,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
    );
    has_public := true;
  END IF;
  IF has_public THEN
    ALTER TABLE public.referral_links ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_referral_links_tenant ON public.referral_links(tenant_id);
  END IF;
  IF has_alpha THEN
    ALTER TABLE alphadome.referral_links ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_referral_links_tenant_a ON alphadome.referral_links(tenant_id);
  END IF;

  -- ============ opportunity_events ============
  has_public := to_regclass('public.opportunity_events')   IS NOT NULL;
  has_alpha  := to_regclass('alphadome.opportunity_events') IS NOT NULL;
  IF NOT has_public AND NOT has_alpha THEN
    CREATE TABLE public.opportunity_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      opportunity_id uuid,
      category_id uuid,
      event_type text NOT NULL,
      session_id text,
      anonymous_id text,
      referrer text,
      utm_source text,
      utm_medium text,
      utm_campaign text,
      utm_content text,
      metadata jsonb DEFAULT '{}'::jsonb,
      created_at timestamp with time zone DEFAULT now()
    );
    has_public := true;
  END IF;
  IF has_public THEN
    ALTER TABLE public.opportunity_events ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_opportunity_events_tenant ON public.opportunity_events(tenant_id);
  END IF;
  IF has_alpha THEN
    ALTER TABLE alphadome.opportunity_events ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_opportunity_events_tenant_a ON alphadome.opportunity_events(tenant_id);
  END IF;

  -- ============ blog_posts (canonical home = public) ============
  has_public := to_regclass('public.blog_posts')   IS NOT NULL;
  has_alpha  := to_regclass('alphadome.blog_posts') IS NOT NULL;
  IF NOT has_public AND NOT has_alpha THEN
    CREATE TABLE public.blog_posts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text UNIQUE NOT NULL,
      title text NOT NULL,
      content text NOT NULL DEFAULT '',
      html_content text NOT NULL DEFAULT '',
      opportunity_id uuid,
      category text DEFAULT 'general',
      thumbnail_url text,
      meta_description text,
      status text DEFAULT 'published',
      view_count integer DEFAULT 0,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
    );
    has_public := true;
  END IF;
  IF has_public THEN
    ALTER TABLE public.blog_posts ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_blog_posts_tenant ON public.blog_posts(tenant_id);
  END IF;
  IF has_alpha THEN
    ALTER TABLE alphadome.blog_posts ADD COLUMN IF NOT EXISTS tenant_id uuid;
    CREATE INDEX IF NOT EXISTS idx_blog_posts_tenant_a ON alphadome.blog_posts(tenant_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Backfill: attach every existing row (in whichever schema it lives) to
--    the 'default' tenant. Only fills NULLs, so re-runs are safe.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  def_id uuid := (SELECT id FROM public.site_tenants WHERE slug = 'default');
BEGIN
  IF to_regclass('public.opportunity_sources')   IS NOT NULL THEN
    UPDATE public.opportunity_sources    SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;
  IF to_regclass('alphadome.opportunity_sources') IS NOT NULL THEN
    UPDATE alphadome.opportunity_sources SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;

  IF to_regclass('public.opportunity_categories')   IS NOT NULL THEN
    UPDATE public.opportunity_categories    SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;
  IF to_regclass('alphadome.opportunity_categories') IS NOT NULL THEN
    UPDATE alphadome.opportunity_categories SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;

  IF to_regclass('public.opportunities')   IS NOT NULL THEN
    UPDATE public.opportunities    SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;
  IF to_regclass('alphadome.opportunities') IS NOT NULL THEN
    UPDATE alphadome.opportunities SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;

  IF to_regclass('public.referral_links')   IS NOT NULL THEN
    UPDATE public.referral_links    SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;
  IF to_regclass('alphadome.referral_links') IS NOT NULL THEN
    UPDATE alphadome.referral_links SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;

  IF to_regclass('public.opportunity_events')   IS NOT NULL THEN
    UPDATE public.opportunity_events    SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;
  IF to_regclass('alphadome.opportunity_events') IS NOT NULL THEN
    UPDATE alphadome.opportunity_events SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;

  IF to_regclass('public.blog_posts')   IS NOT NULL THEN
    UPDATE public.blog_posts    SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;
  IF to_regclass('alphadome.blog_posts') IS NOT NULL THEN
    UPDATE alphadome.blog_posts SET tenant_id = def_id WHERE tenant_id IS NULL; END IF;
END $$;

COMMIT;

-- ============================================================================
-- POST-MIGRATION VERIFICATION (expect exactly one 'default' tenant; and for
-- each table, total == scoped):
--
--   SELECT id, slug, name, is_active FROM public.site_tenants ORDER BY slug;
--
--   SELECT 'sources' t, count(*) total, count(tenant_id) scoped FROM public.opportunity_sources
--   UNION ALL SELECT 'categories', count(*), count(tenant_id) FROM public.opportunity_categories
--   UNION ALL SELECT 'opportunities', count(*), count(tenant_id) FROM public.opportunities
--   UNION ALL SELECT 'referral_links', count(*), count(tenant_id) FROM public.referral_links
--   UNION ALL SELECT 'events', count(*), count(tenant_id) FROM public.opportunity_events
--   UNION ALL SELECT 'blog_posts', count(*), count(tenant_id) FROM public.blog_posts;
-- ============================================================================
-- >>> next file >>>

-- ============================================================================
-- ALPHADOME MULTI-TENANT AI JOBS — Phase 2: seed respondent.io source
-- ============================================================================
-- Additive + idempotent + schema-agnostic. Proves the engine now serves more
-- than Mercor. Run AFTER 2026-10-11_add_site_tenants_multitenant.sql.
--
-- What it does:
--   1. Inserts an active 'respondent' source (base_url https://respondent.io)
--      into whichever schema holds opportunity_sources (public or alphadome),
--      scoped to the 'default' tenant.
--   2. Merges respondent.io redirect domains into the default tenant's
--      allowed_redirect_domains (idempotent jsonb union).
--
-- It seeds NO fabricated referral URL — per-opportunity referral_url values
-- are added via the admin UI. Rollback: delete the 'respondent' source row.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  def_id uuid := (SELECT id FROM public.site_tenants WHERE slug = 'default');
  has_pub boolean := to_regclass('public.opportunity_sources')   IS NOT NULL;
  has_alp boolean := to_regclass('alphadome.opportunity_sources') IS NOT NULL;
BEGIN
  -- 1. Seed the respondent source in whichever schema is in use.
  IF has_pub THEN
    INSERT INTO public.opportunity_sources (name, slug, base_url, source_type, is_active, tenant_id)
    VALUES ('Respondent', 'respondent', 'https://respondent.io', 'referral', true, def_id)
    ON CONFLICT (slug) DO NOTHING;
    UPDATE public.opportunity_sources SET tenant_id = def_id
      WHERE slug = 'respondent' AND tenant_id IS NULL AND def_id IS NOT NULL;
  END IF;

  IF has_alp THEN
    INSERT INTO alphadome.opportunity_sources (name, slug, base_url, source_type, is_active, tenant_id)
    VALUES ('Respondent', 'respondent', 'https://respondent.io', 'referral', true, def_id)
    ON CONFLICT (slug) DO NOTHING;
    UPDATE alphadome.opportunity_sources SET tenant_id = def_id
      WHERE slug = 'respondent' AND tenant_id IS NULL AND def_id IS NOT NULL;
  END IF;

  -- 2. Merge respondent domains into the default tenant allowlist (idempotent).
  IF def_id IS NOT NULL THEN
    UPDATE public.site_tenants
      SET allowed_redirect_domains = (
        SELECT jsonb_agg(DISTINCT d) FROM (
          SELECT jsonb_array_elements_text(coalesce(allowed_redirect_domains, '[]'::jsonb)) AS d
          UNION
          SELECT unnest(ARRAY['respondent.io','www.respondent.io','app.respondent.io'])
        ) s
      )
    WHERE id = def_id;
  END IF;
END $$;

COMMIT;

-- Verify:
--   SELECT id, slug, name, base_url, is_active, tenant_id
--   FROM public.opportunity_sources ORDER BY slug;
--   SELECT slug, allowed_redirect_domains FROM public.site_tenants WHERE slug='default';
