-- ============================================================================
-- DIGITAL DROPS — the funnel rungs and the free shelf (2026-11-12)
-- ============================================================================
-- Step 3 of 3. Run after 2026-11-10 (tables) and 2026-11-11 (card lane).
--
-- Why this exists: the catalogue could price a pack and take money for it, but it
-- had no idea what order to read itself in. A buyer who landed on the KES 12,000
-- track with no cheaper proof did not buy, and a buyer who finished the KES 1,500
-- kit was shown nothing next. Both are catalogue problems, not traffic problems.
--
-- This file adds:
--
--   digital_products.funnel_step   which rung a row sits on (lead/entry/core/...)
--   digital_products.next_slug     the rung this row hands the buyer
--   digital_lead_magnets           the free shelf: real files, no price, no order
--   digital_leads                  one row per capture, email or WhatsApp
--
-- Everything is additive and idempotent: no column is dropped, no existing row is
-- rewritten (funnel_step defaults to 'core', which is what every pre-11-12 row was).
--
-- On Supabase, paste this file into the SQL editor and run it. Do not run it before
-- the 2026-11-10 file: it widens tables that file creates, and the preflight below
-- names the file to run first instead of failing with a bare 42P01.
-- ============================================================================

BEGIN;

-- Preflight: if the base tables are absent, stop with a message that names the fix.
DO $$
BEGIN
  IF to_regclass('public.digital_products') IS NULL THEN
    RAISE EXCEPTION 'digital_products is missing: run migrations/2026-11-10_digital_drops.sql first, then 2026-11-11, then this file.';
  END IF;
END $$;

-- ---- the rung a row sits on ------------------------------------------------
ALTER TABLE public.digital_products
  ADD COLUMN IF NOT EXISTS funnel_step text NOT NULL DEFAULT 'core';

ALTER TABLE public.digital_products
  ADD COLUMN IF NOT EXISTS next_slug text NULL;

-- Named so a re-run is quiet, and so a bad seed fails at the source rather than
-- producing a rung that no page can render.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'digital_products_funnel_step_check'
  ) THEN
    ALTER TABLE public.digital_products
      ADD CONSTRAINT digital_products_funnel_step_check
      CHECK (funnel_step IN ('lead', 'entry', 'core', 'premium', 'continuity', 'service'));
  END IF;
END $$;

-- The storefront reads the ladder in this order on every request.
CREATE INDEX IF NOT EXISTS digital_products_funnel_rank_idx
  ON public.digital_products (status, funnel_step, rank);

-- ---- the free shelf --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.digital_lead_magnets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL,
  summary     text NOT NULL DEFAULT '',
  -- What the visitor gets, in one sentence. Shown on the capture card.
  promise     text NOT NULL DEFAULT '',
  -- [{ "title": "...", "detail": "..." }] — the same shape as a product, because
  -- the builder renders both with one function.
  modules     jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcomes    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- File under drops_assets/, served only through a signed lead token.
  asset_file  text NOT NULL,
  -- The paid rung this magnet hands the visitor to.
  next_slug   text NULL,
  status      text NOT NULL DEFAULT 'published'
              CHECK (status IN ('draft', 'published', 'retired')),
  rank        integer NOT NULL DEFAULT 100,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS digital_lead_magnets_status_rank_idx
  ON public.digital_lead_magnets (status, rank);

CREATE TABLE IF NOT EXISTS public.digital_leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  magnet_slug  text NOT NULL,
  -- One of these is present; both is allowed, neither is refused by the route.
  email        text NULL,
  phone        text NULL,
  name         text NULL,
  source       text NOT NULL DEFAULT 'unknown',
  -- Recorded, not assumed. The capture card states what the address is used for.
  consent      boolean NOT NULL DEFAULT false,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set when this lead later buys the rung the magnet pointed at.
  order_ref    text NULL,
  delivered_at timestamptz NULL,
  downloaded   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digital_leads_contact_check CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- One capture per address per magnet: a visitor who refreshes the page is not a
-- second lead, and the conversion rate keeps its denominator honest.
CREATE UNIQUE INDEX IF NOT EXISTS digital_leads_magnet_email_idx
  ON public.digital_leads (magnet_slug, lower(email))
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS digital_leads_magnet_phone_idx
  ON public.digital_leads (magnet_slug, phone)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS digital_leads_created_idx
  ON public.digital_leads (created_at DESC);

COMMENT ON COLUMN public.digital_products.funnel_step IS
  'The rung this row sits on: lead, entry, core, premium, continuity or service. Defaults to core for every row written before 2026-11-12.';
COMMENT ON COLUMN public.digital_products.next_slug IS
  'The rung this product hands the buyer. Must point at a higher rung; resolved by step order when null.';
COMMENT ON TABLE public.digital_lead_magnets IS
  'The free rung: finished files captured against an email or WhatsApp number. Seeded by scripts/drops_pipeline.mjs, served by GET /drops/free/:token.';
COMMENT ON TABLE public.digital_leads IS
  'One row per free-pack capture. Never written by a paid checkout, and never joined to a tenant.';

ALTER TABLE public.digital_lead_magnets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digital_leads        ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Verify (expect 2 columns, 2 tables, 1 constraint):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'digital_products' AND column_name IN ('funnel_step', 'next_slug');
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name IN ('digital_lead_magnets', 'digital_leads');
--   SELECT conname FROM pg_constraint WHERE conname = 'digital_products_funnel_step_check';


