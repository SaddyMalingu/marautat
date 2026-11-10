-- ============================================================================
-- ALPHADOME DIGITAL DROPS — sell a digital product without a human (2026-11-10)
-- ============================================================================
-- Four tables, all additive and idempotent. Nothing existing is altered.
--
-- Why the repo needs this: it could already write an SEO page for a `course` or
-- `product` offer, take an M-Pesa prompt and send a WhatsApp message, but it had
-- no way to hand over the thing that was bought. Every CTA ended at a human.
-- These tables close that loop:
--
--   digital_products      what is for sale, at what price, with which file
--   digital_orders        one row per checkout attempt (M-Pesa checkout id, amount)
--   digital_entitlements  one row per paid order — the signed access link it issued
--   digital_events        the funnel, so "views but no sales" is measurable
--
-- Run BEFORE deploy. The routes answer 503 naming this file when a table is
-- missing, so a deploy that lands first is degraded, not broken.
--
-- ORDER: this file is step 1 of 2. Run it first, then
-- `migrations/2026-11-11_digital_drops_card_lane.sql`, which widens these tables
-- with the card lane and the funnel-build queue. On Supabase, paste the whole
-- file into the SQL editor and run it — do not run the 11-11 file first.
--
--   psql "$DATABASE_URL" -f migrations/2026-11-10_digital_drops.sql
--   psql "$DATABASE_URL" -f migrations/2026-11-11_digital_drops_card_lane.sql
--
-- To check what a database actually has: npm run drops:doctor
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.digital_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  title           text NOT NULL,
  kind            text NOT NULL DEFAULT 'kit'
                  CHECK (kind IN ('course', 'kit', 'playbook', 'bundle', 'report')),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'retired')),
  summary         text NOT NULL DEFAULT '',
  -- What the buyer can do afterwards. Three or more; the page sells outcomes.
  outcomes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ "title": "...", "detail": "..." }] — also the table of contents of the pack.
  modules         jsonb NOT NULL DEFAULT '[]'::jsonb,
  price_kes       numeric(12,2) NOT NULL CHECK (price_kes > 0),
  price_usd       numeric(12,2) NULL,
  compare_at_kes  numeric(12,2) NULL,
  -- Optional second product added to the same M-Pesa prompt (one prompt, two packs).
  bump_slug       text NULL,
  -- File under drops_assets/ served only through a verified entitlement.
  asset_file      text NULL,
  delivery_note   text NOT NULL DEFAULT '',
  rank            integer NOT NULL DEFAULT 100,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS digital_products_status_rank_idx
  ON public.digital_products (status, rank);

CREATE TABLE IF NOT EXISTS public.digital_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short, human-readable, and what M-Pesa shows as the account reference.
  order_ref           text NOT NULL UNIQUE,
  product_slug        text NOT NULL,
  product_title       text NOT NULL DEFAULT '',
  -- The exact lines charged, so a refund or a query can be answered later.
  lines               jsonb NOT NULL DEFAULT '[]'::jsonb,
  phone               text NOT NULL,
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  currency            text NOT NULL DEFAULT 'KES',
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'prompted', 'paid', 'delivered', 'failed', 'expired')),
  -- SHA-256 of the secret handed to the buyer's browser. The secret itself is
  -- never stored, so a database read cannot be replayed into someone's order.
  lookup_hash         text NOT NULL,
  checkout_request_id text NULL,
  merchant_request_id text NULL,
  mpesa_receipt       text NULL,
  failure_reason      text NULL,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  prompted_at         timestamptz NULL,
  paid_at             timestamptz NULL,
  delivered_at        timestamptz NULL
);

-- The callback looks an order up by the id Safaricom gave us, and must find
-- exactly one. A duplicate would deliver twice.
CREATE UNIQUE INDEX IF NOT EXISTS digital_orders_checkout_idx
  ON public.digital_orders (checkout_request_id)
  WHERE checkout_request_id IS NOT NULL;

-- The 90-second double-tap guard and the revenue report both read this.
CREATE INDEX IF NOT EXISTS digital_orders_phone_created_idx
  ON public.digital_orders (phone, created_at DESC);

CREATE INDEX IF NOT EXISTS digital_orders_status_created_idx
  ON public.digital_orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.digital_entitlements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES public.digital_orders(id) ON DELETE CASCADE,
  order_ref      text NOT NULL,
  product_slug   text NOT NULL,
  -- The signed token that appears in the access URL. Unique, so one order
  -- cannot quietly mint a second working link.
  token          text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  downloads      integer NOT NULL DEFAULT 0,
  last_access_at timestamptz NULL,
  revoked_at     timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS digital_entitlements_order_idx
  ON public.digital_entitlements (order_id, product_slug);

CREATE TABLE IF NOT EXISTS public.digital_events (
  id           bigserial PRIMARY KEY,
  product_slug text NULL,
  order_ref    text NULL,
  event        text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS digital_events_event_created_idx
  ON public.digital_events (event, created_at DESC);

COMMENT ON TABLE public.digital_products IS
  'Alphadome digital drops: priced courses, kits and packs. Seeded by scripts/drops_pipeline.mjs, read by routes/drops.js.';
COMMENT ON TABLE public.digital_orders IS
  'One row per M-Pesa checkout attempt. Amount is computed server-side from digital_products, never from the request body.';
COMMENT ON TABLE public.digital_entitlements IS
  'Proof of purchase: a signed, expiring access token per paid order. Served by GET /drops/access/:token.';
COMMENT ON TABLE public.digital_events IS
  'Funnel events (view, checkout, paid, delivered, failed) so the drop revenue report has a denominator.';

-- The service role writes these; no anon access is desired anywhere.
ALTER TABLE public.digital_products      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digital_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digital_entitlements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digital_events        ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Verify (expect 4 rows):
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name LIKE 'digital\_%';

