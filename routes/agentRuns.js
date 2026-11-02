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
import { applyCaptures, readCoverage } from '../utils/browserActor/applyCaptures.js';
import { resolveRunnerIdentity } from '../utils/tenantRunnerIdentity.js';

const MAX_CAPTURES_PER_RESULT = 50;
const MAX_TEXT = 20_000;

function clampText(value, max = 500) {
  if (value == null) return null;
  return String(value).slice(0, max);
}

function cleanUrl(value) {
  const raw = clampText(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // A worker is untrusted input, so only real web links survive: `javascript:` and `file:`
    // have no business in a URL that ends up in a tenant's offer page.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * What a worker is allowed to say about a capture.
 *
 * Everything is coerced and bounded here rather than at the insert, because this body comes
 * from a machine we do not control: unknown fields are dropped, absurd lengths are cut, and a
 * non-web URL is discarded instead of being stored and rendered later.
 */
export function sanitizeAgentCaptures(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_CAPTURES_PER_RESULT).map((item) => ({
    title: clampText(item?.title, 300),
    jobId: clampText(item?.jobId, 64),
    externalId: clampText(item?.externalId, 120),
    url: cleanUrl(item?.url),
    referralUrl: cleanUrl(item?.referralUrl),
    content: clampText(item?.content, MAX_TEXT),
    summary: clampText(item?.summary, 2000),
    rate: clampText(item?.rate, 80),
    reason: clampText(item?.reason, 120),
    descriptionChars: Number.isFinite(Number(item?.descriptionChars)) ? Number(item.descriptionChars) : null
  })).filter((item) => item.title && item.jobId);
}

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

  /**
   * Everything the tenant's machine needs to run this job — and nothing more.
   *
   * Deliberately absent: the MoreLogin API key. A desktop profile is driven through the
   * MoreLogin client already signed in on that machine, so the key never leaves the server —
   * which means a stolen worker token cannot be turned into control of a marketplace account.
   *
   * The profile must be the **tenant's own and local**. Anything else is refused instead of
   * silently driving an operator's browser from a stranger's laptop.
   */
  router.get('/api/agent/runs/:id/context', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const run = await findRunForTenant(auth, req.params.id);
      if (!run) return fail(res, 404, 'Run not found for this tenant');

      const { data: tenantRow, error: tenantError } = await supabase
        .from('site_tenants').select('id, slug, name').eq('id', auth.tenantId).maybeSingle();
      if (tenantError) throw tenantError;
      if (!tenantRow) return fail(res, 404, 'Tenant not found');

      let identity;
      try {
        identity = await resolveRunnerIdentity({ supabase, tenantSlug: auth.tenantSlug });
      } catch (error) {
        // The resolver knows what to do about it; the worker does not, and neither does the
        // tenant reading a 409 that says "no browser is mapped". Carry the fix through.
        const fix = error?.details?.fix
          || 'Connect your MoreLogin profile in the portal (Your own browser), or ask Alphadome to map a hosted profile for this tenant.';
        console.error(`[agent] context refused run=${run.id} tenant=${auth.tenantSlug}: ${error?.message || error} — ${fix}`);
        return fail(res, 409, `${error?.message || 'No browser is set up for this tenant yet'}. ${fix}`);
      }
      // Only a cloud profile is out of reach for a worker: the browser is not on any machine
      // the tenant owns, so the portal has to start it. Everything else — the tenant's own
      // profile, an operator-hosted one, or the single-profile default — is driven by
      // `ml-cli` on whatever machine holds it, which is exactly what a worker is for.
      //
      // Refusing `hosted` outright (the first version did) broke the operator's own tenant:
      // their profile IS a local desktop profile, and the worker runs on that same machine.
      if (identity.runtime !== 'local') {
        console.error(`[agent] context refused run=${run.id} tenant=${auth.tenantSlug}: runtime=${identity.runtime}`);
        return fail(res, 409, 'That profile runs in the cloud, so the portal should run it — press Capture now again');
      }
      console.error(`[agent] context run=${run.id} tenant=${auth.tenantSlug} source=${identity.source} profile=${identity.envId} → allowed`);

      const { data: offers, error: offersError } = await supabase
        .from('opportunities').select('title, slug, external_id').eq('tenant_id', auth.tenantId);
      if (offersError) throw offersError;

      const platform = String(run.platform || 'micro1');
      const { data: sourceRow } = await supabase
        .from('opportunity_sources').select('id, slug').eq('slug', platform).maybeSingle();

      res.json({
        ok: true,
        run: { id: run.id, status: run.status, platform, limit: Number(run.detail?.limit) || 12 },
        tenant: { slug: tenantRow.slug, name: tenantRow.name || null },
        // envId identifies the profile; the key stays here. `source` tells the worker whose
        // profile this is, so its log says `source=hosted` instead of leaving the operator
        // guessing which browser just moved.
        identity: { envId: identity.envId, runtime: identity.runtime, source: identity.source },
        sourceSlug: platform,
        sourceId: sourceRow?.id || null,
        // Titles/slugs only: enough to skip roles the tenant already has, and all of it their
        // own data.
        known: Array.isArray(offers) ? offers : []
      });
    } catch (error) {
      fail(res, 500, error.message || 'Could not build the run context');
    }
  });

  /**
   * The captures come back here to be written.
   *
   * This is why the tenant's machine needs no database credential: it reports what it saw,
   * and the server — which already holds the privilege — verifies each link and inserts the
   * offers. A valid token proves *who* sent this, not that it is safe, so the payload is
   * sanitised and every link is re-checked before it is attached.
   */
  router.post('/api/agent/runs/:id/result', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const run = await findRunForTenant(auth, req.params.id);
      if (!run) return fail(res, 404, 'Run not found for this tenant');
      if (!['queued', 'running'].includes(String(run.status))) {
        return fail(res, 409, `That run is already ${run.status} — nothing was written`);
      }

      const captures = sanitizeAgentCaptures(req.body?.captures);
      if (!captures.length) return fail(res, 400, 'That result contained no usable captures');

      const { data: tenantRow, error: tenantError } = await supabase
        .from('site_tenants').select('id, slug, name').eq('id', auth.tenantId).maybeSingle();
      if (tenantError) throw tenantError;
      if (!tenantRow) return fail(res, 404, 'Tenant not found');

      const platform = String(run.platform || 'micro1');
      const { data: offers } = await supabase
        .from('opportunities').select('id, title, slug, external_id, referral_url, description, status')
        .eq('tenant_id', auth.tenantId);
      const { data: sourceRow } = await supabase
        .from('opportunity_sources').select('id').eq('slug', platform).maybeSingle();

      const applied = await applyCaptures({
        supabase,
        tenant: tenantRow,
        offers: Array.isArray(offers) ? offers : [],
        sourceId: sourceRow?.id || null,
        sourceSlug: platform,
        captures,
        apply: true
      });
      const coverage = await readCoverage(supabase, tenantRow.id);

      const total = captures.length;
      const links = captures.filter((capture) => capture.referralUrl).length;
      const failed = Math.max(0, total - applied.inserted);
      const closed = await runs.finish({
        runId: run.id,
        status: deriveRunStatus({ done: total, ok: applied.inserted, failed, total }),
        done: total,
        ok: applied.inserted,
        failed,
        total,
        message: `${applied.inserted} imported of ${total} captured, ${applied.withLinks} with a verified link${applied.error ? ` (${applied.error})` : ''}`.slice(0, 300),
        detail: {
          captured: total,
          links,
          inserted: applied.inserted,
          planned: applied.planned,
          skipped: applied.skipped?.length || 0,
          withoutLinks: applied.withoutLinks || 0,
          listing: req.body?.listing && typeof req.body.listing === 'object' ? req.body.listing : null
        }
      }).catch((error) => {
        console.error(`[agent] run ${run.id} could not be closed: ${error?.message || error}`);
        return null;
      });

      res.json({
        ok: true,
        applied: {
          planned: applied.planned,
          inserted: applied.inserted,
          skipped: applied.skipped,
          withLinks: applied.withLinks,
          withoutLinks: applied.withoutLinks,
          verification: applied.verification,
          error: applied.error
        },
        coverage,
        run: closed
      });
    } catch (error) {
      fail(res, 500, error.message || 'Could not apply the result');
    }
  });

  /** Tenant-scoped lookup for the two routes where the id comes from the URL. */
  async function findRunForTenant(auth, id) {
    const all = await runs.list({ tenantId: auth.tenantId, limit: 50 });
    return all.find((row) => row.id === String(id || '')) || null;
  }

  return router;
}

