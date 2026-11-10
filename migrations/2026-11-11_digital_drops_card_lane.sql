-- ============================================================================
-- DIGITAL DROPS — the card lane and the funnel-build proposal queue (2026-11-11)
-- ============================================================================
-- The 2026-11-10 build could only take M-Pesa. Search Console says most of the
-- traffic is US/UK/CA, and a US buyer had no way to pay. This migration makes the
-- catalogue sellable on both lanes without forking the order table:
--
--   digital_products.payment_lane   'mpesa' | 'card' | 'both'
--   digital_orders.lane             which lane this order used
--   digital_orders.customer_email   required for a card receipt and delivery
--   digital_orders.phone            now nullable (a card buyer has no M-Pesa number)
--   digital_orders.provider*        which hosted checkout took the money
--   service_requests                rung 3: the done-for-you funnel-build queue
--
-- Idempotent and transactional. Run BEFORE deploying the routes.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Preflight: this file only *widens* tables created by the drops migration.
-- Running it first is the one way it can fail, and the old failure was a bare
-- "42P01: relation public.digital_products does not exist", which reads like a
-- broken migration rather than a missing prerequisite.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.digital_products') IS NULL OR to_regclass('public.digital_orders') IS NULL THEN
    RAISE EXCEPTION
      'Digital Drops base tables are missing. Run migrations/2026-11-10_digital_drops.sql first, then this file. Nothing in this file has been applied.'
      USING HINT = 'SELECT table_name FROM information_schema.tables WHERE table_schema = ''public'' AND table_name LIKE ''digital%'';';
  END IF;
END $$;

-- 1) Which lanes a product is sold on --------------------------------------
ALTER TABLE public.digital_products
  ADD COLUMN IF NOT EXISTS payment_lane text NOT NULL DEFAULT 'both';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'digital_products_payment_lane_check'
       AND conrelid = 'public.digital_products'::regclass
  ) THEN
    ALTER TABLE public.digital_products
      ADD CONSTRAINT digital_products_payment_lane_check
      CHECK (payment_lane IN ('mpesa', 'card', 'both'));
  END IF;
END $$;

-- 2) Orders that can come from either lane ----------------------------------
ALTER TABLE public.digital_orders
  ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'mpesa';
ALTER TABLE public.digital_orders
  ADD COLUMN IF NOT EXISTS customer_email text NULL;
ALTER TABLE public.digital_orders
  ADD COLUMN IF NOT EXISTS provider text NULL;
ALTER TABLE public.digital_orders
  ADD COLUMN IF NOT EXISTS provider_ref text NULL;
ALTER TABLE public.digital_orders
  ADD COLUMN IF NOT EXISTS checkout_url text NULL;

-- A card buyer never supplies an M-Pesa number. The original NOT NULL was correct
-- for one lane and is wrong for two.
ALTER TABLE public.digital_orders ALTER COLUMN phone DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'digital_orders_contact_check'
       AND conrelid = 'public.digital_orders'::regclass
  ) THEN
    -- An order must be reachable somehow: a phone for M-Pesa, an email for a card.
    ALTER TABLE public.digital_orders
      ADD CONSTRAINT digital_orders_contact_check
      CHECK (phone IS NOT NULL OR customer_email IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'digital_orders_lane_check'
       AND conrelid = 'public.digital_orders'::regclass
  ) THEN
    ALTER TABLE public.digital_orders
      ADD CONSTRAINT digital_orders_lane_check
      CHECK (lane IN ('mpesa', 'card'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS digital_orders_lane_created_idx
  ON public.digital_orders (lane, created_at DESC);

-- Reconciliation for card sales: a provider reference must find exactly one order.
CREATE UNIQUE INDEX IF NOT EXISTS digital_orders_provider_ref_idx
  ON public.digital_orders (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;

-- 3) Rung 3: the done-for-you funnel build -----------------------------------
-- A service request is not a tenant and not an offer. It is a priced conversation,
-- so it gets its own queue rather than being squeezed into discovery_submissions
-- (whose approval path creates a tenant — the wrong outcome for a proposal).
CREATE TABLE IF NOT EXISTS public.service_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL,
  company       text NOT NULL DEFAULT '',
  country       text NOT NULL DEFAULT '',
  sell          text NOT NULL,
  channel       text NOT NULL DEFAULT '',
  problem       text NOT NULL DEFAULT '',
  budget        text NOT NULL CHECK (budget IN ('3k-6k', '6k-12k', '12k+', 'unsure')),
  timeline      text NOT NULL CHECK (timeline IN ('now', '30-days', 'quarter', 'exploring')),
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'contacted', 'proposal_sent', 'won', 'lost', 'archived')),
  quoted_usd    numeric(12,2) NULL,
  notes         text NULL,
  source        text NOT NULL DEFAULT 'build-page',
  created_at    timestamptz NOT NULL DEFAULT now(),
  contacted_at  timestamptz NULL
);

CREATE INDEX IF NOT EXISTS service_requests_status_created_idx
  ON public.service_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS service_requests_email_idx
  ON public.service_requests (email);

COMMENT ON TABLE public.service_requests IS
  'Rung 3 of the offer ladder: a done-for-you funnel build request. Priced and answered by a human; the page and the queue are automatic.';

ALTER TABLE public.service_requests ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'digital_orders' AND column_name IN ('lane','customer_email','provider','provider_ref');
--   SELECT is_nullable FROM information_schema.columns
--    WHERE table_name = 'digital_orders' AND column_name = 'phone';   -- expect YES
--   SELECT count(*) FROM public.service_requests;                     -- expect 0
