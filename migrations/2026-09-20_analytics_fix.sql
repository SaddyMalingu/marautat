-- ============================================================
-- ANALYTICS FIX — run in Supabase SQL Editor (idempotent)
-- Adds missing geo columns + automation_log.created_at
-- Safe to run multiple times
-- ============================================================

-- 1) Page views geo columns
ALTER TABLE public.analytics_page_views ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.analytics_page_views ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE public.analytics_page_views ADD COLUMN IF NOT EXISTS city text;

-- 2) Clicks geo columns
ALTER TABLE public.analytics_clicks ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.analytics_clicks ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE public.analytics_clicks ADD COLUMN IF NOT EXISTS city text;

-- 3) automation_log.created_at (dashboard + GitHub Action depend on it)
ALTER TABLE public.automation_log ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();

-- Backfill created_at from started_at where missing (so weekly stats work)
UPDATE public.automation_log SET created_at = started_at WHERE created_at IS NULL AND started_at IS NOT NULL;

-- 4) Helpful indexes (no-op if they exist)
CREATE INDEX IF NOT EXISTS idx_analytics_views_page ON public.analytics_page_views(page_path);
CREATE INDEX IF NOT EXISTS idx_analytics_views_created ON public.analytics_page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_clicks_page ON public.analytics_clicks(page_path);
CREATE INDEX IF NOT EXISTS idx_analytics_clicks_created ON public.analytics_clicks(created_at);
CREATE INDEX IF NOT EXISTS idx_automation_log_started ON public.automation_log(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_log_status ON public.automation_log(status);

-- 5) Verify (should return 3 rows, all 'exists')
SELECT 'analytics_page_views.country' AS col, EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='analytics_page_views' AND column_name='country'
) AS exists
UNION ALL
SELECT 'analytics_clicks.country', EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='analytics_clicks' AND column_name='country'
)
UNION ALL
SELECT 'automation_log.created_at', EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='automation_log' AND column_name='created_at'
);
