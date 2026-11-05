-- Blog optimisation jobs (2026-11-05)
--
-- One row per "run my assets" request: a tenant pressing the button on their own offers, or the
-- owner pressing the button on everything.
--
-- Why a table at all: the work takes minutes (nine angles per offer, up to 90s each), so the
-- HTTP request cannot carry it. The button enqueues a row, a background drain fills in progress,
-- and the portal polls. Without a row there is nothing to poll and a crashed drain is invisible.
--
-- `scope` is 'tenant' or 'global'. `tenant_id` is NULL for global runs, which is also why the
-- tenant route never reads a tenant from the request body — it uses the session's.
--
-- Run BEFORE deploy. The routes answer 503 with this filename in the message if the table is
-- missing, so a deploy that lands first is degraded rather than broken.

CREATE TABLE IF NOT EXISTS public.blog_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         text NOT NULL CHECK (scope IN ('tenant', 'global')),
  -- NULL means "every tenant" (global runs). A tenant run always carries one.
  tenant_id     uuid NULL,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  -- Offers planned, offers finished, offers that failed, pages written.
  total         integer NOT NULL DEFAULT 0,
  done          integer NOT NULL DEFAULT 0,
  failed        integer NOT NULL DEFAULT 0,
  pages         integer NOT NULL DEFAULT 0,
  limit_offers  integer NOT NULL DEFAULT 5,
  budget_ms     integer NOT NULL DEFAULT 0,
  -- The plan that was actually accepted: runs, skipped (with reasons), deferred, needsLink.
  plan          jsonb NULL,
  -- One entry per offer as it finishes: {offerId, title, ok, pages, mode, error}.
  results       jsonb NOT NULL DEFAULT '[]'::jsonb,
  error         text NULL,
  requested_by  text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz NULL,
  completed_at  timestamptz NULL
);

-- The portal polls "the newest job for this tenant" and the owner polls the newest global one.
CREATE INDEX IF NOT EXISTS blog_jobs_tenant_created_idx
  ON public.blog_jobs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS blog_jobs_scope_created_idx
  ON public.blog_jobs (scope, created_at DESC);

-- One running job per scope is the invariant the drainer enforces in memory; this index makes a
-- second one visible instead of silent if two processes ever disagree.
CREATE INDEX IF NOT EXISTS blog_jobs_running_idx
  ON public.blog_jobs (scope, tenant_id) WHERE status IN ('queued', 'running');

COMMENT ON TABLE public.blog_jobs IS
  'Background blog-generation jobs. Written by the tenant/admin Optimise buttons, drained by utils/blogJobs.js.';
