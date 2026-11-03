-- Micro1 runs need their own kind (2026-11-03)
--
-- Why: `browser_actor_runs_kind_check` was written when the only runner was Turing, so the
-- allowed kinds are collect/import/referrals/verify. Micro1 captures were queued as
-- `referrals` — the same kind as Turing — and the partial unique index
-- `uq_browser_actor_runs_active (tenant_id, kind)` therefore let a Turing run waiting for an
-- operator block a Micro1 capture the tenant could actually run. Observed live on 2026-11-03:
-- the tenant pressed Capture Micro1 links and got "already waiting" while nothing was running
-- for Micro1 at all.
--
-- The code now queues Micro1 runs as kind `micro1`, which needs this one line of DDL. The
-- route degrades safely without it (falls back to `collect`, never `referrals`, and reports
-- `kindFallback: true`), so applying this is what makes the audit trail exact rather than what
-- makes the button work.
--
-- Idempotent: safe to run twice, and safe to run after the constraint has already been widened.

ALTER TABLE public.browser_actor_runs
  DROP CONSTRAINT IF EXISTS browser_actor_runs_kind_check;

ALTER TABLE public.browser_actor_runs
  ADD CONSTRAINT browser_actor_runs_kind_check
  CHECK (kind IN ('collect', 'import', 'referrals', 'verify', 'micro1'));

-- Verification: four rows, each `true`.
--   select pg_get_constraintdef(oid) like '%micro1%' as widened
--   from pg_constraint where conname = 'browser_actor_runs_kind_check';
