-- ============================================================================
-- TENANT BLOGGER (Writer's Flow → Blogger) — Phase A migration
-- ============================================================================
-- Additive + idempotent + schema-aware. Links site_tenants to bot_tenants via
-- client_phone so each tenant's Blogger content is auto-scoped (lazy-provision
-- happens in code on first Blogger access). Run BEFORE deploying Phase A code.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  -- public.site_tenants is the canonical registry used by the app.
  IF to_regclass('public.site_tenants') IS NOT NULL THEN
    ALTER TABLE public.site_tenants ADD COLUMN IF NOT EXISTS client_phone text;
    CREATE INDEX IF NOT EXISTS idx_site_tenants_phone ON public.site_tenants(client_phone);
  END IF;

  -- Defensive: some environments may also carry an alphadome.site_tenants.
  IF to_regclass('alphadome.site_tenants') IS NOT NULL THEN
    ALTER TABLE alphadome.site_tenants ADD COLUMN IF NOT EXISTS client_phone text;
    CREATE INDEX IF NOT EXISTS idx_site_tenants_phone_a ON alphadome.site_tenants(client_phone);
  END IF;
END $$;

COMMIT;

-- Verify:
--   SELECT id, slug, name, client_phone FROM public.site_tenants ORDER BY created_at;
