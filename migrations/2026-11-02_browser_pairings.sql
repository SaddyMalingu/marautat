-- Browser pairings (2026-11-02)
--
-- Why this exists
-- ---------------
-- Pasting a worker token is the step that fails most often, because it is a credential copied
-- by hand between two applications by someone who does not do this for a living. Twice in
-- production: a whole command line pasted into the prompt, and a live token pasted into a chat
-- window.
--
-- A pairing code replaces it. The portal mints a short code, puts it inside the worker it
-- hands out, and the worker exchanges it once for a real token — which it then keeps locally.
-- The code is single-use and expires, so a shared download stops working after the first run.
--
-- Hash-only, for the same reason as the tokens: a database leak must not yield anything a
-- worker could present. `used_at` + `used_token_id` keep the trail — this code became that
-- worker — which a DELETE would lose.
--
-- RLS is on with no policies, matching browser_actor_agent_tokens and browser_actor_runs:
-- only the service role the server already uses may read or write.

CREATE TABLE IF NOT EXISTS public.browser_actor_pairings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES site_tenants(id) ON DELETE CASCADE,
  label         text,
  -- sha256 of the code. The code itself is shown once, inside the download.
  code_hash     text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  -- Set the moment a worker redeems it. A second redemption is refused, not honoured.
  used_at       timestamptz,
  used_token_id uuid
);

CREATE INDEX IF NOT EXISTS browser_actor_pairings_tenant_idx
  ON public.browser_actor_pairings (tenant_id, created_at DESC);

COMMENT ON TABLE public.browser_actor_pairings IS
  'Single-use pairing codes that become a worker token. Hash only; expires in 30 minutes.';

ALTER TABLE public.browser_actor_pairings ENABLE ROW LEVEL SECURITY;

-- Verification: zero rows on a clean apply.
--   select count(*) from public.browser_actor_pairings;

