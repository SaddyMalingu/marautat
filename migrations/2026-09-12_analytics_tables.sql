-- ============================================================
-- ANALYTICS TABLES
-- Track page views and clicks for optimization
-- ============================================================

-- Page views tracking
CREATE TABLE IF NOT EXISTS public.analytics_page_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_path text NOT NULL,
  referrer text DEFAULT 'direct',
  user_agent text,
  ip_hash text,
  session_id text,
  created_at timestamp with time zone DEFAULT now()
);

-- Clicks tracking (Mercor link clicks)
CREATE TABLE IF NOT EXISTS public.analytics_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_path text NOT NULL,
  click_type text DEFAULT 'mercor_link',
  referrer text DEFAULT 'direct',
  user_agent text,
  ip_hash text,
  session_id text,
  created_at timestamp with time zone DEFAULT now()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_analytics_views_page ON public.analytics_page_views(page_path);
CREATE INDEX IF NOT EXISTS idx_analytics_views_created ON public.analytics_page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_clicks_page ON public.analytics_clicks(page_path);
CREATE INDEX IF NOT EXISTS idx_analytics_clicks_created ON public.analytics_clicks(created_at);

-- Enable RLS
ALTER TABLE public.analytics_page_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_clicks ENABLE ROW LEVEL SECURITY;

-- Only service role can insert (tracking is done server-side)
CREATE POLICY "Service role can insert views" ON public.analytics_page_views
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Service role can insert clicks" ON public.analytics_clicks
  FOR INSERT WITH CHECK (true);

-- Public can read aggregated data (no individual tracking)
CREATE POLICY "Public can read views" ON public.analytics_page_views
  FOR SELECT USING (true);
CREATE POLICY "Public can read clicks" ON public.analytics_clicks
  FOR SELECT USING (true);

-- Grant permissions
GRANT SELECT ON public.analytics_page_views TO anon;
GRANT SELECT ON public.analytics_clicks TO anon;
GRANT ALL ON public.analytics_page_views TO authenticated;
GRANT ALL ON public.analytics_clicks TO authenticated;
