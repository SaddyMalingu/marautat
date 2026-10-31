-- ============================================================================
-- ALPHADOME — seed Micro1 and Turing as opportunity sources
-- ============================================================================
-- Additive + idempotent + schema-agnostic, modelled on
-- 2026-10-12_seed_respondent_source.sql. Run after the multi-tenant migration.
--
-- Why these two: the Writer's Flow portal already sends a tenant to
--   Micro1  https://refer.micro1.ai/opportunities
--   Turing  https://work.turing.com/jobs
-- Those are marketplaces where the tenant works from their OWN account, so the
-- agent's job is to read that account and surface what matches — not to invent a
-- referral link. Hence source_type = 'account', not 'referral', and no fabricated
-- referral_url is seeded (per-opportunity URLs arrive from the browser adapter).
--
-- It also adds the two domains to the default tenant's redirect allowlist, so a
-- `/go/:id` link to either marketplace validates instead of being rejected as an
-- open-redirect attempt.
--
-- Rollback: delete the 'micro1' and 'turing' source rows.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  def_id uuid := (SELECT id FROM public.site_tenants WHERE slug = 'default');
  has_pub boolean := to_regclass('public.opportunity_sources')   IS NOT NULL;
  has_alp boolean := to_regclass('alphadome.opportunity_sources') IS NOT NULL;
BEGIN
  IF has_pub THEN
    INSERT INTO public.opportunity_sources (name, slug, base_url, source_type, is_active, tenant_id, metadata)
    VALUES
      ('Micro1', 'micro1', 'https://refer.micro1.ai', 'account', true, def_id,
       '{"portalUrl":"https://refer.micro1.ai/opportunities","auth":"tenant_account"}'::jsonb),
      ('Turing', 'turing', 'https://work.turing.com', 'account', true, def_id,
       '{"portalUrl":"https://work.turing.com/jobs","auth":"tenant_account"}'::jsonb)
    ON CONFLICT (slug) DO NOTHING;

    UPDATE public.opportunity_sources SET tenant_id = def_id
      WHERE slug IN ('micro1', 'turing') AND tenant_id IS NULL AND def_id IS NOT NULL;
  END IF;

  IF has_alp THEN
    INSERT INTO alphadome.opportunity_sources (name, slug, base_url, source_type, is_active, tenant_id, metadata)
    VALUES
      ('Micro1', 'micro1', 'https://refer.micro1.ai', 'account', true, def_id,
       '{"portalUrl":"https://refer.micro1.ai/opportunities","auth":"tenant_account"}'::jsonb),
      ('Turing', 'turing', 'https://work.turing.com', 'account', true, def_id,
       '{"portalUrl":"https://work.turing.com/jobs","auth":"tenant_account"}'::jsonb)
    ON CONFLICT (slug) DO NOTHING;

    UPDATE alphadome.opportunity_sources SET tenant_id = def_id
      WHERE slug IN ('micro1', 'turing') AND tenant_id IS NULL AND def_id IS NOT NULL;
  END IF;

  -- Merge both marketplaces into the default tenant allowlist (idempotent union).
  IF def_id IS NOT NULL AND has_pub THEN
    UPDATE public.site_tenants
      SET allowed_redirect_domains = (
        SELECT jsonb_agg(DISTINCT d) FROM (
          SELECT jsonb_array_elements_text(coalesce(allowed_redirect_domains, '[]'::jsonb)) AS d
          UNION
          SELECT unnest(ARRAY[
            'micro1.ai', 'refer.micro1.ai', 'www.micro1.ai',
            'turing.com', 'work.turing.com', 'www.turing.com'
          ])
        ) s
      )
    WHERE id = def_id;
  END IF;
END $$;

COMMIT;

-- Verify:
--   SELECT slug, name, base_url, source_type, is_active, metadata
--   FROM public.opportunity_sources WHERE slug IN ('mercor','micro1','turing') ORDER BY slug;
--   SELECT slug, allowed_redirect_domains FROM public.site_tenants WHERE slug='default';
