/**
 * /apply — the tenant's own page for a ChatterApply run (2026-11-14)
 *
 * Separate from `/admin/apply` on purpose. That one is the operator console: an admin key, the operator's
 * machine, the operator's profile. This one is the tenant's, and it has to work for somebody whose MoreLogin
 * profile lives on their own computer, or for a tenant we have never met.
 *
 * So it does two things, and says which one it is doing:
 *
 *   1. **Queue** a run for the tenant's worker (`browser_actor_runs`, kind `apply`, platform `chatterapply`).
 *      The worker claims it, drives their profile, and the log comes back through `/api/agent/runs/:id/progress`.
 *   2. **Hand off** to the operator console's in-process runner when the caller has the admin key — which is how
 *      the same page works today on the machine that holds the profile, without a worker.
 *
 * Scope is the tenant's own rows, always: the key identifies the tenant and every query is filtered by it. A run
 * id from another tenant is a 404, not a 403, because the caller has no business knowing it exists.
 */
import path from 'node:path';
import express from 'express';
import { createRunStore } from '../utils/browserActor/runs.js';
import { APPLY_KIND, applyRunView, buildApplyDetail, MAX_LOG_LINES } from '../utils/applyRuns.js';
import { workAndaFor, buildOnboardingRequest, appendRequest } from '../utils/workAnda.js';

/** Statuses that mean "an apply run is already in flight for this tenant". */
const ACTIVE_STATUSES = Object.freeze(['queued', 'running']);

export function isApplyRunActive(run) {
  return Boolean(run) && ACTIVE_STATUSES.includes(String(run.status || '').toLowerCase());
}

export function createApplyPortalRouter({
  root = process.cwd(),
  table = null,
  resolveTenant = null,
  resolveTenantByPhone = null,
  saveOnboarding = null,
  pageDir = path.join(root, 'admin')
} = {}) {
  const router = express.Router();
  const store = table ? createRunStore({ table }) : null;

  const keyFor = (req) => String(req.get('x-tenant-key') || req.get('x-admin-key') || req.query.key || '').trim();
  const acceptedKeys = () => [
    process.env.TENANT_DASHBOARD_PASS,
    process.env.ADMIN_KEY,
    process.env.ADMIN_PASS
  ].filter(Boolean);

  /**
   * Who is asking. Two credentials are accepted, both already in use: the shared tenant-dashboard key (what the
   * tenant dashboard uses) and the admin key. With the shared key the tenant names its slug; resolveTenant turns
   * that into a row, and an unknown slug is refused rather than created.
   */
  const caller = async (req) => {
    const supplied = keyFor(req);
    if (!supplied) return { error: 'missing key', status: 401 };
    const accepted = acceptedKeys();
    if (!accepted.length) return { error: 'no tenant key is configured on this server', status: 503 };
    if (!accepted.includes(supplied)) return { error: 'unknown key', status: 401 };
    const slug = String(req.query.tenant || req.body?.tenant || '').trim().toLowerCase();
    if (!slug) return { error: 'tenant is required', status: 400 };
    if (typeof resolveTenant !== 'function') return { error: 'tenant lookup is not configured', status: 503 };
    const tenant = await resolveTenant(slug);
    if (!tenant?.id) return { error: `no tenant "${slug}"`, status: 404 };
    /**
     * Work_Anda is a paid upgrade, so this is where it is enforced for *runs*. The section itself is visible to
     * every tenant — that is how the upgrade sells itself — but queueing, reading or cancelling a run requires
     * it, so a visible button is never the only thing between a tenant and an agent acting with their identity
     * on a site they have not bought.
     */
    const upgrade = workAndaFor(slug);
    if (!upgrade.enabled) {
      return { error: 'Work_Anda is not enabled for this tenant', status: 403, upgrade };
    }
    return { tenant, upgrade, role: supplied === process.env.TENANT_DASHBOARD_PASS ? 'tenant' : 'operator' };
  };

  /**
   * What the dashboard shows for this tenant. Outside `caller`, because a tenant *without* the upgrade still gets
   * the section: templates to see, and the onboarding form. Refusing this call would hide the only way to buy.
   */
  const section = async (req, res) => {
    const supplied = keyFor(req);
    const accepted = acceptedKeys();
    if (!supplied) return res.status(401).json({ error: 'missing key' });
    if (!accepted.length) return res.status(503).json({ error: 'no tenant key is configured on this server' });
    if (!accepted.includes(supplied)) return res.status(401).json({ error: 'unknown key' });
    const slug = String(req.query.tenant || '').trim().toLowerCase();
    const phone = String(req.query.phone || '').trim();
    if (!slug && !phone) return res.status(400).json({ error: 'tenant or phone is required' });
    let tenant = null;
    try {
      if (slug && typeof resolveTenant === 'function') tenant = await resolveTenant(slug);
      else if (phone && typeof resolveTenantByPhone === 'function') tenant = await resolveTenantByPhone(phone);
    } catch (error) {
      return res.status(500).json({ error: `could not look the tenant up: ${error.message}` });
    }
    if (!tenant?.id) return res.status(404).json({ error: 'tenant not found' });
    return res.json(workAndaFor(tenant.slug || slug));
  };

  router.get('/api/work-anda', section);
  // The old path, so a dashboard tab open across the rename keeps working.
  router.get('/api/work-under', section);

  /**
   * "Onboard a system": the site, an HTML dump of the pages that matter, and what the work is.
   *
   * This is the door for a tenant who wants an agent nobody has built yet, so it is open to every tenant — asking
   * is how they buy. The request is kept on their own tenant row (`metadata.workAnda.requests`), newest five,
   * because that needs no migration and lands where support already looks.
   */
  router.post('/api/work-anda/requests', async (req, res) => {
    const supplied = keyFor(req);
    const accepted = acceptedKeys();
    if (!supplied) return res.status(401).json({ error: 'missing key' });
    if (!accepted.length) return res.status(503).json({ error: 'no tenant key is configured on this server' });
    if (!accepted.includes(supplied)) return res.status(401).json({ error: 'unknown key' });

    const slug = String(req.query.tenant || req.body?.tenant || '').trim().toLowerCase();
    const phone = String(req.query.phone || req.body?.phone || '').trim();
    if (!slug && !phone) return res.status(400).json({ error: 'tenant or phone is required' });
    let tenant = null;
    try {
      if (slug && typeof resolveTenant === 'function') tenant = await resolveTenant(slug);
      else if (phone && typeof resolveTenantByPhone === 'function') tenant = await resolveTenantByPhone(phone);
    } catch (error) {
      return res.status(500).json({ error: `could not look the tenant up: ${error.message}` });
    }
    if (!tenant?.id) return res.status(404).json({ error: 'tenant not found' });

    const { request, errors } = buildOnboardingRequest(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    if (typeof saveOnboarding !== 'function') {
      return res.status(503).json({ error: 'onboarding storage is not configured on this server' });
    }
    try {
      const kept = await saveOnboarding(tenant, request);
      return res.status(202).json({
        ok: true,
        request: { id: request.id, at: request.at, siteUrl: request.siteUrl, status: request.status },
        kept: Array.isArray(kept) ? kept.length : 1,
        note: 'Received. We build the agent against this site and dump, and come back to you before it runs anything.'
      });
    } catch (error) {
      return res.status(500).json({ error: `could not save the request: ${error.message}` });
    }
  });

  // The page holds nothing: served without a key, needs one to do anything.
  router.get('/apply', (req, res) => res.sendFile(path.join(pageDir, 'apply_portal.html')));

  /** Recent runs for this tenant, newest first, plus the active one if any. */
  router.get('/api/apply/runs', async (req, res) => {
    const auth = await caller(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (!store) return res.status(503).json({ error: 'the run store is not configured' });
    try {
      const rows = await store.list({ tenantId: auth.tenant.id, limit: 10, kinds: [APPLY_KIND] });
      const views = rows.map(applyRunView);
      return res.json({ runs: views, active: views.find((run) => ACTIVE_STATUSES.includes(run.status)) || null });
    } catch (error) {
      return res.status(500).json({ error: `could not read runs: ${error.message}` });
    }
  });


  /** Queue a run for this tenant's worker. */
  router.post('/api/apply/runs', async (req, res) => {
    const auth = await caller(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (!store) return res.status(503).json({ error: 'the run store is not configured' });

    const { detail, errors, rejected } = buildApplyDetail(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('; '), rejected });

    try {
      const existing = await store.list({ tenantId: auth.tenant.id, limit: 5, kinds: [APPLY_KIND] });
      const active = existing.find(isApplyRunActive);
      if (active) {
        return res.status(409).json({ error: 'a ChatterApply run is already in flight', active: applyRunView(active) });
      }
      const row = await store.queue({
        tenantId: auth.tenant.id,
        kind: APPLY_KIND,
        sourceSlug: APPLY_KIND,
        requestedBy: `tenant:${auth.tenant.slug || ''}`.slice(0, 120),
        detail
      });
      return res.status(202).json({
        run: applyRunView(row),
        queued: true,
        note: 'Your worker claims this within about 15 seconds while its window is open. The prompts that need you appear here and in the browser window on that machine.'
      });
    } catch (error) {
      return res.status(500).json({ error: `could not queue: ${error.message}` });
    }
  });

  /** Cancel a queued or running run of this tenant's. */
  router.post('/api/apply/runs/:id/cancel', async (req, res) => {
    const auth = await caller(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (!store) return res.status(503).json({ error: 'the run store is not configured' });
    try {
      const rows = await store.list({ tenantId: auth.tenant.id, limit: 10, kinds: [APPLY_KIND] });
      const mine = rows.find((row) => row.id === req.params.id);
      if (!mine) return res.status(404).json({ error: 'no such run' });
      if (!isApplyRunActive(mine)) return res.status(409).json({ error: 'that run is already finished' });
      const cancelled = await store.cancel({ runId: mine.id, tenantId: auth.tenant.id });
      return res.json({ run: applyRunView(cancelled || mine), cancelled: true });
    } catch (error) {
      return res.status(500).json({ error: `could not cancel: ${error.message}` });
    }
  });

  // How much log the page should expect, so it can say "N of M lines" honestly.
  router.get('/api/apply/meta', (req, res) => res.json({ logLines: MAX_LOG_LINES, kind: APPLY_KIND }));

  return router;
}

export default createApplyPortalRouter;
