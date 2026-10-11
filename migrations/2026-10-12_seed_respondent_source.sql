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
