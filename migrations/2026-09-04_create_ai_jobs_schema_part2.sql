-- ============================================================================
-- ALPHADOME AI JOBS & MERCOR REFERRAL ENGINE - MIGRATION (Part 2: More Tables)
-- ============================================================================

BEGIN;

-- 3. OPPORTUNITIES
CREATE TABLE IF NOT EXISTS alphadome.opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES alphadome.opportunity_sources(id) ON DELETE SET NULL,
  external_id text,
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  description text,
  category_id uuid REFERENCES alphadome.opportunity_categories(id) ON DELETE SET NULL,
  subcategory text,
  compensation_min numeric,
  compensation_max numeric,
  compensation_currency text DEFAULT 'USD',
  compensation_type text DEFAULT 'hourly',
  location_text text,
  eligible_locations jsonb DEFAULT '[]'::jsonb,
  employment_type text DEFAULT 'contract',
  contract_type text,
  skills jsonb DEFAULT '[]'::jsonb,
  requirements jsonb DEFAULT '[]'::jsonb,
  experience_level text,
  application_url text,
  referral_url text,
  source_url text,
  status text DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'published', 'stale', 'closed', 'archived')),
  published_at timestamp with time zone,
  expires_at timestamp with time zone,
  last_verified_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_opportunities_slug ON alphadome.opportunities(slug);
CREATE INDEX IF NOT EXISTS idx_opportunities_source ON alphadome.opportunities(source_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_category ON alphadome.opportunities(category_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON alphadome.opportunities(status);

-- 4. OPPORTUNITY EVENTS
CREATE TABLE IF NOT EXISTS alphadome.opportunity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid REFERENCES alphadome.opportunities(id) ON DELETE SET NULL,
  category_id uuid REFERENCES alphadome.opportunity_categories(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'page_view', 'category_view', 'opportunity_view', 'apply_click', 'referral_click', 'external_click'
  )),
  session_id text,
  anonymous_id text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunity_events_opportunity ON alphadome.opportunity_events(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_opportunity_events_type ON alphadome.opportunity_events(event_type);
CREATE INDEX IF NOT EXISTS idx_opportunity_events_created ON alphadome.opportunity_events(created_at);

-- 5. REFERRAL LINKS
CREATE TABLE IF NOT EXISTS alphadome.referral_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_key text UNIQUE NOT NULL,
  link_type text NOT NULL CHECK (link_type IN ('general', 'category', 'job')),
  source_id uuid REFERENCES alphadome.opportunity_sources(id) ON DELETE SET NULL,
  category_id uuid REFERENCES alphadome.opportunity_categories(id) ON DELETE SET NULL,
  referral_url text NOT NULL,
  is_active boolean DEFAULT true,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_links_key ON alphadome.referral_links(link_key);
CREATE INDEX IF NOT EXISTS idx_referral_links_type ON alphadome.referral_links(link_type);

COMMIT;
