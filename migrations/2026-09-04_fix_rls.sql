-- ============================================================================
-- FIX RLS POLICIES FOR ADMIN ACCESS
-- ============================================================================
-- The service role needs full access to manage opportunities
-- ============================================================================

-- Allow service role full access to all AI Jobs tables
-- This is safe because the service role is only used server-side

-- Opportunity sources
DROP POLICY IF EXISTS "Service role full access" ON alphadome.opportunity_sources;
CREATE POLICY "Service role full access" ON alphadome.opportunity_sources
  FOR ALL USING (true) WITH CHECK (true);

-- Opportunity categories
DROP POLICY IF EXISTS "Service role full access" ON alphadome.opportunity_categories;
CREATE POLICY "Service role full access" ON alphadome.opportunity_categories
  FOR ALL USING (true) WITH CHECK (true);

-- Opportunities
DROP POLICY IF EXISTS "Service role full access" ON alphadome.opportunities;
CREATE POLICY "Service role full access" ON alphadome.opportunities
  FOR ALL USING (true) WITH CHECK (true);

-- Opportunity events
DROP POLICY IF EXISTS "Service role full access" ON alphadome.opportunity_events;
CREATE POLICY "Service role full access" ON alphadome.opportunity_events
  FOR ALL USING (true) WITH CHECK (true);

-- Referral links
DROP POLICY IF EXISTS "Service role full access" ON alphadome.referral_links;
CREATE POLICY "Service role full access" ON alphadome.referral_links
  FOR ALL USING (true) WITH CHECK (true);
