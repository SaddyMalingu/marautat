-- Tenant worker tokens (2026-11-02)
--
-- When a tenant's MoreLogin is a desktop install on their own machine, their profile is
-- reachable only from that machine — Render cannot drive it, and exposing the debug port
-- over a tunnel would hand anyone who finds the URL remote control of a logged-in
-- marketplace account. So the tenant runs a small worker, and the worker needs to
-- authenticate as *that tenant* and nothing else.
--
-- Stored as a hash, never as the token: a leaked database row must not become a working
-- credential. The prefix (first 8 characters) exists only so a tenant can tell two workers
-- apart in the UI ("wkr_9f2c…"), which is the same reason a bank shows the last four
-- digits of an account.
--
-- Revocation is a column, not a delete: `revoked_at` keeps the audit trail of "this worker
-- existed and was switched off", which a DELETE would lose.
--
-- RLS is on with no policies, matching browser_identities and browser_actor_sessions: only
-- the service role the server already uses may read or write.

CREATE TABLE IF NOT EXISTS public.browser_actor_agent_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES site_tenants(id) ON DELETE CASCADE,
  label        text,
  -- sha256 of the token. The token itself is shown once, at creation, and never stored.
  token_hash   text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

COMMENT ON TABLE public.browser_actor_agent_tokens IS
  'Per-tenant credential for a local worker. Hash only; the token is shown once at creation.';

CREATE INDEX IF NOT EXISTS browser_actor_agent_tokens_tenant_idx
  ON public.browser_actor_agent_tokens (tenant_id, created_at DESC);

ALTER TABLE public.browser_actor_agent_tokens ENABLE ROW LEVEL SECURITY;

-- Verification: zero rows on a clean apply.
--   select count(*) from public.browser_actor_agent_tokens;
