-- ============================================================
-- AUTOMATION LOG
-- Tracks automated operations for dashboard reporting
-- ============================================================

CREATE TABLE IF NOT EXISTS public.automation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type text DEFAULT 'manual', -- 'manual' or 'scheduled'
  jobs_processed integer DEFAULT 0,
  posts_generated integer DEFAULT 0,
  status text DEFAULT 'success', -- 'success', 'partial', 'failed'
  details jsonb DEFAULT '{}'::jsonb,
  started_at timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.automation_log ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_automation_log_created ON public.automation_log(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_log_status ON public.automation_log(status);

ALTER TABLE public.automation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read automation log" ON public.automation_log
  FOR SELECT USING (true);
CREATE POLICY "Service role can insert" ON public.automation_log
  FOR INSERT WITH CHECK (true);

GRANT SELECT ON public.automation_log TO anon;
GRANT ALL ON public.automation_log TO authenticated;
