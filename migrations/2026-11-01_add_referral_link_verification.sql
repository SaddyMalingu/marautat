-- Referral link verification (2026-11-01)
--
-- A referral link drives revenue, so "it looks fine" is not good enough. The audit
-- resolves each stored link and records where it actually lands, so the portal can
-- show link health without making an HTTP request per offer on every page load.
--
--   link_verdict      'match' | 'mismatch' | 'unresolvable'   (null = never checked)
--   link_checked_at   when that verdict was last established
--
-- Written by scripts/browser_actor_audit_links.mjs and by the capture path before a
-- link is attached. Read by GET /tenant/blogger/coverage.
--
-- Why this exists: a link on the Project Lead offer was found pointing at
-- "Strategic Project Lead - Software Engineering". Nothing in the database could
-- have told you that; only resolving the link can.

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS link_verdict text,
  ADD COLUMN IF NOT EXISTS link_checked_at timestamptz;

COMMENT ON COLUMN opportunities.link_verdict IS
  'match | mismatch | unresolvable — set by the referral link audit; null means never checked';
COMMENT ON COLUMN opportunities.link_checked_at IS
  'when link_verdict was last established';

-- The portal asks "which links are wrong?" — a partial index keeps that cheap.
CREATE INDEX IF NOT EXISTS idx_opportunities_link_verdict
  ON opportunities (link_verdict)
  WHERE link_verdict IS NOT NULL;
