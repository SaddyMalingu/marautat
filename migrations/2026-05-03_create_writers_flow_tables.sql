-- Writer's Flow Outreach Tables
-- Run this in your Supabase/Postgres SQL editor

CREATE TABLE IF NOT EXISTS public.wf_campaigns (
  id text PRIMARY KEY,
  total_leads_found integer DEFAULT 0,
  total_outreach_sent integer DEFAULT 0,
  status text DEFAULT 'created', -- running | completed | failed
  last_run_at timestamp with time zone,
  error_log text
);

CREATE TABLE IF NOT EXISTS public.wf_leads (
  id bigserial PRIMARY KEY,
  campaign_id text REFERENCES public.wf_campaigns(id) ON DELETE CASCADE,
  name text,
  organization text,
  url text,
  email text,
  phone text,
  industry text,
  description text,
  relevance_score integer DEFAULT 0,
  outreach_type text DEFAULT 'pitch',
  status text DEFAULT 'qualified', -- qualified | skipped | contacted | etc.
  source_query text,
  source_result_title text,
  raw_snippet text,
  country text,
  qualified_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wf_leads_campaign ON public.wf_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_wf_leads_status ON public.wf_leads(status);

CREATE TABLE IF NOT EXISTS public.wf_outreach (
  id bigserial PRIMARY KEY,
  lead_id bigint REFERENCES public.wf_leads(id) ON DELETE CASCADE,
  campaign_id text REFERENCES public.wf_campaigns(id) ON DELETE CASCADE,
  channel text, -- email | whatsapp
  outreach_type text,
  subject text,
  body text,
  quality_score integer DEFAULT 0,
  status text, -- sent | draft | failed | queued
  sent_at timestamp with time zone,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_wf_outreach_lead ON public.wf_outreach(lead_id);
CREATE INDEX IF NOT EXISTS idx_wf_outreach_campaign ON public.wf_outreach(campaign_id);
CREATE INDEX IF NOT EXISTS idx_wf_outreach_status ON public.wf_outreach(status);
