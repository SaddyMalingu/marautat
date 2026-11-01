-- Writer's Flow run tracking (2026-11-02)
--
-- The capture work happens on the operator's machine, because that is where the
-- leased browser is. Until now the only record of a run was a JSON file on that
-- machine (tmp/collect_progress.json). The portal could not see it, it died with the
-- laptop, and it was per-operator rather than per-tenant — which does not survive the
-- second tenant, let alone the tenth.
--
-- So the record lives here, keyed by tenant:
--
--   queued     the portal asked for this; no runner has picked it up yet
--   running    a runner claimed it and is heart-beating
--   succeeded | partial | failed | cancelled
--
-- Two rules make this safe with several tenants:
--
--   1. One active run per (tenant, kind) — enforced by a partial unique index, not by
--      JavaScript, so two operators on two machines cannot both claim the same
--      tenant's capture and fight over the same profile lease.
--   2. `heartbeat_at` is what "still alive" means. A runner that dies leaves a row
--      behind; the portal reads that as stalled rather than as running (see
--      utils/browserActor/runs.js), because a dead run that looks healthy is worse
--      than no run at all.
--
-- `link_note` records a *human* decision about a link ("accepted by tenant",
-- "cleared by tenant"), which the automated verifier must not silently undo.

CREATE TABLE IF NOT EXISTS browser_actor_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES site_tenants(id) ON DELETE CASCADE,
  -- Which marketplace this run touches; null when the run is not marketplace-specific.
  source_slug text,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  requested_by text,
  total_items integer NOT NULL DEFAULT 0,
  done_items integer NOT NULL DEFAULT 0,
  ok_items integer NOT NULL DEFAULT 0,
  failed_items integer NOT NULL DEFAULT 0,
  message text,
  -- Whatever the runner wants the portal to know (window, pace, thin offers, ...).
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT browser_actor_runs_kind_check
    CHECK (kind IN ('collect', 'import', 'referrals', 'verify')),
  CONSTRAINT browser_actor_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'))
);

COMMENT ON TABLE browser_actor_runs IS
  'One row per tenant collection run: what the portal asked for, what the runner did, and whether it is still alive';

-- The portal always asks "this tenant's runs, newest first".
CREATE INDEX IF NOT EXISTS idx_browser_actor_runs_tenant_created
  ON browser_actor_runs (tenant_id, created_at DESC);

-- One live run per tenant and kind. A second request is refused instead of silently
-- queueing work that would collide on the same MoreLogin profile lease.
CREATE UNIQUE INDEX IF NOT EXISTS uq_browser_actor_runs_active
  ON browser_actor_runs (tenant_id, kind)
  WHERE status IN ('queued', 'running');

-- A human decision about a stored link. The verifier skips rows whose note starts
-- with 'accepted', so re-running verification never reverses a deliberate override.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS link_note text;

COMMENT ON COLUMN opportunities.link_note IS
  'Human decision about referral_url: accepted by tenant | cleared by tenant: <where it pointed>';
