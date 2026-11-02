/**
 * Agent endpoints for a tenant's own worker (2026-11-02)
 *
 * A worker runs where the browser is: on the tenant's machine, for a desktop MoreLogin
 * profile that Render cannot reach. This is the API it talks to, and it is deliberately
 * tiny — the worker protocol is four calls, and everything else it needs already exists in
 * `browser_actor_runs`.
 *
 *   GET  /api/agent/health              prove the token works
 *   GET  /api/agent/runs                this tenant's queued/running runs
 *   POST /api/agent/runs/:id/claim      queued -> running (atomic compare-and-set)
 *   POST /api/agent/runs/:id/progress   counters + heartbeat
 *   POST /api/agent/runs/:id/finish     close with a status and a message
 *
 * Isolation rules, all enforced by the token rather than by trusting the caller:
 *
 *   - the tenant comes from the **token**, never from the request body;
 *   - claim is `update … where id = ? and tenant_id = ? and status = 'queued'`, so two
 *     workers racing for one run means one wins and the other gets a 409 — no in-memory
 *     lock, no coordination, correct under concurrency;
 *   - a revoked token is refused even though the row still exists.
 */
import { Router } from 'express';
import { createRunStore, deriveRunStatus, RUN_STATUSES } from '../utils/browserActor/runs.js';
import { bearerTokenFromHeader, createAgentTokenStore } from '../utils/browserActor/agentTokens.js';

export function createAgentRunsRouter({
  supabase,
  tokenTable = 'browser_actor_agent_tokens',
  runTable = 'browser_actor_runs',
  now = () => Date.now()
} = {}) {
  const router = Router();
  const tokens = createAgentTokenStore({ table: () => supabase.from(tokenTable), now });
  const runs = createRunStore({ table: () => supabase.from(runTable), now });

  const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });

  /** Resolve the token to a tenant, or refuse. Nothing downstream may guess it. */
  async function authenticate(req, res) {
    const token = bearerTokenFromHeader(req.get('authorization'));
    if (!token) {
      fail(res, 401, 'Missing bearer token — run the worker with --token, or create one in the portal');
      return null;
    }
    const row = await tokens.findLive(token).catch((error) => {
      fail(res, 500, error.message || 'Could not verify the token');
      return null;
    });
    if (!row) {
      // One message for "never existed" and "revoked": telling them apart would help a
      // token guesser more than a legitimate worker.
      fail(res, 401, 'This worker token is not valid. Create a new one in the portal.');
      return null;
    }
    const { data: site, error } = await supabase
      .from('site_tenants').select('id, slug').eq('id', row.tenant_id).maybeSingle();
    if (error) { fail(res, 500, error.message); return null; }
    if (!site) { fail(res, 401, 'This token belongs to a tenant that no longer exists'); return null; }
    tokens.touch({ id: row.id });
    return { tokenId: row.id, tenantId: site.id, tenantSlug: site.slug };
  }

  /** Health first: a worker should fail at startup, not halfway through a claim loop. */
  router.get('/api/agent/health', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    res.json({ ok: true, tenant: auth.tenantSlug, serverTime: new Date(now()).toISOString() });
  });

  router.get('/api/agent/runs', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      // Everything this worker may act on: what is waiting, and what it already claimed.
      const all = await runs.list({ tenantId: auth.tenantId, limit: 20 });
      const relevant = all.filter((run) => ['queued', 'running'].includes(String(run.status)));
      res.json({ ok: true, tenant: auth.tenantSlug, runs: relevant });
    } catch (error) {
      fail(res, 500, error.message || 'Could not list runs');
    }
  });

  router.post('/api/agent/runs/:id/claim', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const id = String(req.params.id || '');
      // Compare-and-set in one statement: the `status = 'queued'` filter is what makes two
      // racing workers safe, and the tenant filter is what keeps one tenant out of another.
      const { data, error } = await supabase
        .from(runTable)
        .update({
          status: 'running',
          started_at: new Date(now()).toISOString(),
          heartbeat_at: new Date(now()).toISOString()
        })
        .eq('id', id)
        .eq('tenant_id', auth.tenantId)
        .eq('status', 'queued')
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return fail(res, 409, 'That run is not queued for this tenant any more (claimed, cancelled or finished)');
      }
      res.json({ ok: true, run: data });
    } catch (error) {
      fail(res, 500, error.message || 'Could not claim the run');
    }
  });

  /** Progress is a heartbeat too: the portal decides "stalled" from it. */
  router.post('/api/agent/runs/:id/progress', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const run = await findRunForTenant(auth, req.params.id);
      if (!run) return fail(res, 404, 'Run not found for this tenant');
      await runs.progress({
        runId: run.id,
        done: req.body?.done,
        ok: req.body?.ok,
        failed: req.body?.failed,
        total: req.body?.total,
        message: req.body?.message ? String(req.body.message).slice(0, 300) : null
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, 500, error.message || 'Could not record progress');
    }
  });

  router.post('/api/agent/runs/:id/finish', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const run = await findRunForTenant(auth, req.params.id);
      if (!run) return fail(res, 404, 'Run not found for this tenant');

      const requested = String(req.body?.status || '').toLowerCase();
      // A worker may report a status, but only a real one; otherwise the counters decide.
      const status = RUN_STATUSES.includes(requested)
        ? requested
        : deriveRunStatus({
          done: req.body?.done,
          ok: req.body?.ok,
          failed: req.body?.failed,
          total: req.body?.total
        });
      const closed = await runs.finish({
        runId: run.id,
        status,
        done: req.body?.done,
        ok: req.body?.ok,
        failed: req.body?.failed,
        total: req.body?.total,
        message: req.body?.message ? String(req.body.message).slice(0, 300) : null,
        detail: req.body?.detail && typeof req.body.detail === 'object' ? req.body.detail : null
      });
      res.json({ ok: true, run: closed });
    } catch (error) {
      fail(res, 500, error.message || 'Could not close the run');
    }
  });

  /** Tenant-scoped lookup for the two routes where the id comes from the URL. */
  async function findRunForTenant(auth, id) {
    const all = await runs.list({ tenantId: auth.tenantId, limit: 50 });
    return all.find((row) => row.id === String(id || '')) || null;
  }

  return router;
}

