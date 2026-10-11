-- ============================================================================
-- DIAGNOSTIC (read-only) — where do the AI Jobs tables actually live?
-- ============================================================================
-- Paste into Supabase SQL Editor and RUN. Copy the result grid back to me.
-- This tells us the exact schema for every table Phase 1 must touch, so the
-- migration targets the right place on the FIRST try. No changes are made.
-- ============================================================================

SELECT
  table_schema,
  table_name,
  CASE WHEN table_schema = 'public' THEN 'APP READS THIS (unqualified .from)' ELSE '' END AS note
FROM information_schema.tables
WHERE table_name IN (
  'site_tenants',
  'opportunity_sources',
  'opportunity_categories',
  'opportunities',
  'referral_links',
  'opportunity_events',
  'blog_posts',
  'bot_tenants'
)
ORDER BY table_name, table_schema;

-- Also show what an unqualified query resolves to (effective search_path):
SHOW search_path;
