-- 2026-10-24 — Discovery → tenant approval, per-tenant portal access, tenant Writer's Flow
--
-- Why: a client who fills the public questionnaire (POST /discovery) should be
-- one owner click away from their own tenant portal. That needs three things this
-- migration supplies:
--   1. a durable home for the questionnaire (Render's disk is ephemeral, so the
--      JSONL fallback alone loses submissions on every deploy),
--   2. a per-tenant portal credential (bot_tenants.portal_token) so the invite
--      link does not have to leak the shared TENANT_DASHBOARD_PASS,
--   3. wf_campaigns.tenant_id so a client can run Writer's Flow for themselves
--      without seeing another tenant's campaigns.
--
-- Additive and idempotent: safe to run before the code deploy, safe to re-run.

BEGIN;

-- 1) Questionnaire submissions -------------------------------------------------

CREATE TABLE IF NOT EXISTS public.discovery_submissions (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  phone TEXT,
  business_name TEXT,
  industry TEXT,
  business_description TEXT,
  team_size TEXT,
  challenges TEXT[] DEFAULT '{}',
  challenges_other TEXT,
  whatsapp_usage TEXT,
  capabilities TEXT[] DEFAULT '{}',
  revenue_target TEXT,
  ownership_interest TEXT,
  timeline TEXT,
  budget TEXT,
  blockers TEXT,
  source TEXT,
  additional_notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  tenant_id UUID,
  portal_token TEXT,
  portal_url TEXT,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The table may already exist from an earlier manual create; add what is missing.
ALTER TABLE public.discovery_submissions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new';
ALTER TABLE public.discovery_submissions ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE public.discovery_submissions ADD COLUMN IF NOT EXISTS portal_token TEXT;
ALTER TABLE public.discovery_submissions ADD COLUMN IF NOT EXISTS portal_url TEXT;
ALTER TABLE public.discovery_submissions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE public.discovery_submissions ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE public.discovery_submissions ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE public.discovery_submissions ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE public.discovery_submissions ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS discovery_submissions_status_idx
  ON public.discovery_submissions (status, submitted_at DESC);

-- 2) Per-tenant portal credential ---------------------------------------------

ALTER TABLE public.bot_tenants ADD COLUMN IF NOT EXISTS portal_token TEXT;
ALTER TABLE public.bot_tenants ADD COLUMN IF NOT EXISTS portal_token_issued_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS bot_tenants_portal_token_key
  ON public.bot_tenants (portal_token)
  WHERE portal_token IS NOT NULL;

-- 3) Tenant-owned Writer's Flow campaigns --------------------------------------
-- Guarded: some deployments name the table differently or have not created it.

DO $$
BEGIN
  IF to_regclass('public.wf_campaigns') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.wf_campaigns ADD COLUMN IF NOT EXISTS tenant_id UUID';
    EXECUTE 'CREATE INDEX IF NOT EXISTS wf_campaigns_tenant_idx ON public.wf_campaigns (tenant_id)';
  END IF;
END $$;

COMMIT;

-- Verification (run after the migration):
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'discovery_submissions' ORDER BY ordinal_position;
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'bot_tenants' AND column_name LIKE 'portal_token%';
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'wf_campaigns' AND column_name = 'tenant_id';
