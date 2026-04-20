-- ============================================================
-- Writer's Flow: Outreach Engine Tables
-- Created: 2026-04-20
-- ============================================================

-- Outreach campaigns (keyword sets + config)
CREATE TABLE IF NOT EXISTS wf_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  industries TEXT[] NOT NULL DEFAULT '{}',
  outreach_types TEXT[] NOT NULL DEFAULT '{pitch}', -- pitch | proposal | partnership | employment
  channels TEXT[] NOT NULL DEFAULT '{email}',       -- email | whatsapp | both
  target_count INT NOT NULL DEFAULT 20,
  quality_threshold INT NOT NULL DEFAULT 70,        -- min AI quality score (0-100) to auto-send
  status TEXT NOT NULL DEFAULT 'draft',             -- draft | running | paused | completed | failed
  search_provider TEXT NOT NULL DEFAULT 'google',   -- google | serpapi | bing
  total_leads_found INT NOT NULL DEFAULT 0,
  total_outreach_sent INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at TIMESTAMPTZ,
  error_log TEXT,
  notes TEXT
);

-- Discovered leads
CREATE TABLE IF NOT EXISTS wf_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES wf_campaigns(id) ON DELETE CASCADE,
  name TEXT,
  organization TEXT,
  url TEXT,
  email TEXT,
  phone TEXT,
  industry TEXT,
  sector TEXT,
  country TEXT,
  description TEXT,                -- snippet from search result
  relevance_score INT DEFAULT 0,   -- AI-assigned 0-100
  outreach_type TEXT,              -- pitch | proposal | partnership | employment
  status TEXT NOT NULL DEFAULT 'discovered', -- discovered | qualified | skipped | contacted | replied | converted
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  qualified_at TIMESTAMPTZ,
  contacted_at TIMESTAMPTZ,
  source_query TEXT,               -- the search query that found this lead
  source_result_title TEXT,
  raw_snippet TEXT,
  notes TEXT
);

-- Outreach messages (generated + sent)
CREATE TABLE IF NOT EXISTS wf_outreach (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES wf_leads(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES wf_campaigns(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'email',  -- email | whatsapp
  outreach_type TEXT NOT NULL,            -- pitch | proposal | partnership | employment
  subject TEXT,
  body TEXT NOT NULL,
  quality_score INT DEFAULT 0,            -- AI self-evaluation 0-100
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | queued | sent | failed | bounced | replied
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta JSONB DEFAULT '{}'::jsonb          -- extra data (open tracking, etc.)
);

-- Indexes for fast admin queries
CREATE INDEX IF NOT EXISTS idx_wf_leads_campaign ON wf_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_wf_leads_status ON wf_leads(status);
CREATE INDEX IF NOT EXISTS idx_wf_outreach_campaign ON wf_outreach(campaign_id);
CREATE INDEX IF NOT EXISTS idx_wf_outreach_status ON wf_outreach(status);
CREATE INDEX IF NOT EXISTS idx_wf_campaigns_status ON wf_campaigns(status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_wf_campaigns_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_wf_campaigns_updated_at ON wf_campaigns;
CREATE TRIGGER trg_wf_campaigns_updated_at
  BEFORE UPDATE ON wf_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_wf_campaigns_updated_at();
