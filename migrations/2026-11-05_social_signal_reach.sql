-- Reach and age on a listening signal (2026-11-05)
--
-- The scorer has always been able to weigh engagement and recency, and never had either: a post
-- parsed off LinkedIn's search page carried its words and nothing else. So "who replied to this,
-- and how recently" was invisible, and a three-week-old thread with one like scored the same as a
-- forty-minute-old post with twelve answers.
--
-- The extractor now reads both from the page — comment/reaction counts from an aria-label, the
-- timestamp from a `time[datetime]` or Reddit's `created-timestamp` — and both are stored here
-- rather than only folded into the score. A score a human cannot audit is a score nobody should
-- act on: the panel shows "12 comments · 2h ago" next to the number.
--
-- `posted_ago_hours` is nullable on purpose. NULL means the page did not say the age; 0 means it
-- said "just now". Collapsing those two would award recency points to pages we simply could not
-- read.

ALTER TABLE public.social_signals
  ADD COLUMN IF NOT EXISTS engagement jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS posted_hint text,
  ADD COLUMN IF NOT EXISTS posted_ago_hours numeric;

COMMENT ON COLUMN public.social_signals.engagement IS
  'What the page said about reach: {comments, likes, shares}, as read, not as guessed';
COMMENT ON COLUMN public.social_signals.posted_hint IS
  'The age phrase the page showed ("2h", "2 days ago"), kept verbatim for the audit trail';
COMMENT ON COLUMN public.social_signals.posted_ago_hours IS
  'Age in hours when it could be parsed; NULL when the page did not say';

-- The digest wants the best signal, and a tie at the same score should go to the fresher post.
CREATE INDEX IF NOT EXISTS idx_social_signals_tenant_fresh
  ON social_signals (tenant_id, posted_ago_hours ASC NULLS LAST, captured_at DESC);

-- Verification: three columns, all nullable/defaulted.
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_name = 'social_signals'
--     and column_name in ('engagement', 'posted_hint', 'posted_ago_hours');
