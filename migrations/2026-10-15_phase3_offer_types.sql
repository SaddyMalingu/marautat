-- ============================================================================
-- ALPHADOME TRAFFIC ENGINE — Phase 3a: generalize "opportunities" -> "offers"
-- ============================================================================
-- Additive + idempotent + schema-agnostic + transactional. Safe to re-run.
-- Backward compatible: every existing row becomes offer_type='job', so all
-- current job pages/CTAs render exactly as before.
--
-- New columns on opportunities:
--   offer_type      text  -- 'job'|'product'|'service'|'brand'|'affiliate'|'course'
--   cta_label       text  -- override button text (e.g. "Shop Now"); null = auto by type
--   destination_url text  -- canonical CTA target; falls back to referral_url/application_url
-- ============================================================================

BEGIN;

DO $$
DECLARE
  has_pub boolean := to_regclass('public.opportunities')   IS NOT NULL;
  has_alp boolean := to_regclass('alphadome.opportunities') IS NOT NULL;
BEGIN
  IF has_pub THEN
    ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS offer_type text DEFAULT 'job';
    ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS cta_label text;
    ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS destination_url text;
    -- Backfill: anything without an explicit type is a job (preserves behavior).
    UPDATE public.opportunities SET offer_type = 'job' WHERE offer_type IS NULL OR offer_type = '';
    CREATE INDEX IF NOT EXISTS idx_opportunities_offer_type ON public.opportunities(offer_type);
  END IF;

  IF has_alp THEN
    ALTER TABLE alphadome.opportunities ADD COLUMN IF NOT EXISTS offer_type text DEFAULT 'job';
    ALTER TABLE alphadome.opportunities ADD COLUMN IF NOT EXISTS cta_label text;
    ALTER TABLE alphadome.opportunities ADD COLUMN IF NOT EXISTS destination_url text;
    UPDATE alphadome.opportunities SET offer_type = 'job' WHERE offer_type IS NULL OR offer_type = '';
    CREATE INDEX IF NOT EXISTS idx_opportunities_offer_type_a ON alphadome.opportunities(offer_type);
  END IF;
END $$;

COMMIT;

-- Verify (expect offer_type column present; all rows = 'job' initially):
--   SELECT offer_type, count(*) FROM public.opportunities GROUP BY offer_type;
