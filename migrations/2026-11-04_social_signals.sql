-- Social listening: what people said, before it becomes a lead (2026-11-04)
--
-- The listening taxonomy and its scorer have existed since the ABOSS work, but nothing ever
-- produced their input: `data/ABOSS_SOCIAL_SIGNALS_RAW.csv` was a header row and an apology.
-- The tenant's own browser closes that gap — it can read LinkedIn with the tenant signed in,
-- which is the one thing a server-side scraper cannot do without an account and a legal risk.
--
-- What this table is not: a lead table. A row is a public post that scores against one of the
-- twelve intents, with the phrases that caused the score kept alongside it so a human can
-- disagree with the machine. Outreach stays human: `status` tracks what the tenant did about it
-- ('new' -> 'drafted' -> 'sent', or 'ignored'), and no code path sends anything.
--
-- Why `(tenant_id, post_url)` is unique: the same search run twice must not double the digest.
-- The post URL is the identity because the text gets edited and the id does not.
--
-- `run_id` is nullable and has no foreign key on purpose: a signal outlives the run that found
-- it, and deleting run history must not delete the only record of a prospect.

CREATE TABLE IF NOT EXISTS social_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES site_tenants(id) ON DELETE CASCADE,
  platform text NOT NULL DEFAULT 'linkedin',
  post_url text NOT NULL,
  post_text text NOT NULL,
  author_name text,
  author_handle text,
  profile_url text,
  location_hint text,
  -- Which taxonomy intent this matched, and how strongly.
  intent_id text NOT NULL,
  intent_name text NOT NULL,
  buyer_signal_strength text,
  intent_score integer NOT NULL,
  confidence text NOT NULL,
  -- The evidence. A score a human cannot audit is a score nobody should act on.
  trigger_hits jsonb NOT NULL DEFAULT '[]'::jsonb,
  warm_hits jsonb NOT NULL DEFAULT '[]'::jsonb,
  exclusion_hits jsonb NOT NULL DEFAULT '[]'::jsonb,
  contact_email text,
  contact_phone text,
  recommended_channel text,
  draft_first_line text,
  run_id uuid,
  status text NOT NULL DEFAULT 'new',
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_signals_status_check
    CHECK (status IN ('new', 'drafted', 'sent', 'ignored')),
  CONSTRAINT social_signals_score_check
    CHECK (intent_score >= 0 AND intent_score <= 100),
  CONSTRAINT social_signals_tenant_post_unique
    UNIQUE (tenant_id, post_url)
);

COMMENT ON TABLE social_signals IS
  'Public posts that matched a listening intent, with the phrases behind the score and the human decision that followed';

-- The panel asks one question: this tenant's best signals, newest first.
CREATE INDEX IF NOT EXISTS idx_social_signals_tenant_score
  ON social_signals (tenant_id, intent_score DESC, captured_at DESC);

-- And "what is still untouched", for the counter that keeps the digest honest.
CREATE INDEX IF NOT EXISTS idx_social_signals_tenant_status
  ON social_signals (tenant_id, status, captured_at DESC);

-- Listening is a run like any other, but it is not a capture: it writes no offers and needs its
-- own (tenant, kind) slot so it cannot block a referral capture the tenant is waiting for.
ALTER TABLE public.browser_actor_runs
  DROP CONSTRAINT IF EXISTS browser_actor_runs_kind_check;

ALTER TABLE public.browser_actor_runs
  ADD CONSTRAINT browser_actor_runs_kind_check
  CHECK (kind IN ('collect', 'import', 'referrals', 'verify', 'micro1', 'listen'));

-- Verification: two rows, both true.
--   select to_regclass('public.social_signals') is not null as table_exists;
--   select pg_get_constraintdef(oid) like '%listen%' as kind_widened
--   from pg_constraint where conname = 'browser_actor_runs_kind_check';
