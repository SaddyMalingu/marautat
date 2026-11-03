/**
 * Tenant-owned browser access routes (2026-11-02)
 *
 * The BYO MoreLogin flow, in four endpoints:
 *
 *   GET  /tenant/blogger/browser-access            is a profile connected, and is it alive?
 *   POST /tenant/blogger/browser-access/connect    { apiKey, envId?, label?, runtime? }
 *   POST /tenant/blogger/browser-access/verify     start the profile once, check the sessions
 *   POST /tenant/blogger/browser-access/disconnect
 *
 * Two rules carried over from everything else in this subsystem:
 *
 *   **The key never leaves the server.** It is sealed with AES-256-GCM under
 *   `TENANT_SECRET_KEY` before it is stored, and no response contains it — not even a
 *   fingerprint. If the sealing key is absent, connecting is refused with the env name
 *   rather than storing a plaintext credential.
 *
 *   **"Verified" is evidence, not optimism.** `verify` starts the tenant's profile and
 *   reads each marketplace listing; a login wall writes `reauthRequired` so the portal can
 *   say "Reconnect" instead of the tenant quietly earning nothing.
 *
 * The provider is injected so the rules are testable without MoreLogin; see
 * utils/tenantBrowserProvider.js for the live implementation.
 */
import { Router } from 'express';
import {
  ACCESS_KEY_ENV,
  accessSecrets,
  clearAccess,
  clearWorkerBrowser,
  fingerprintSecret,
  openSecretFromEnv,
  publicAccessStatus,
  readAccess,
  resolveAccessIdentity,
  sealSecretWithEnv,
  secretsConfigured,
  writeAccess
} from '../utils/tenantAccess.js';
import { summarizeSignedIn } from '../utils/browserActor/signedIn.js';
import { parseProfileMap } from '../utils/browserActor/identity.js';
import { redact } from '../utils/browserActor/moreloginClient.js';
import { canQueue, createRunStore, isActiveStatus, isStalled, MICRO1_RUN_KIND } from '../utils/browserActor/runs.js';
import { createAgentTokenStore, describeAgentToken } from '../utils/browserActor/agentTokens.js';
import { PAIRING_TABLE } from '../utils/browserActor/pairing.js';
import {
  CAPTURE_DEFAULT_LIMIT,
  CAPTURE_MAX_LIMIT,
  SERVER_SIDE_PLATFORMS,
  defaultSpawnRun
} from '../utils/portalCapture.js';

const MIN_KEY_LENGTH = 8;

/** The marketplaces a verify pass checks. Must match MARKETPLACE_URLS in the provider. */
const MARKETPLACES = Object.freeze(['micro1', 'turing']);


/** A malformed registry must not break a read-only status call. */
function parseProfileMapSafe(raw) {
  try { return parseProfileMap(raw || ''); } catch { return {}; }
}

export function createBrowserAccessRouter({
  tenantSessionAuth,
  tenantSiteFromSession,
  supabase,
  provider,
  spawnRun = defaultSpawnRun,
  env = process.env,
  now = () => Date.now()
} = {}) {
  const router = Router();
  const canStore = () => secretsConfigured(env);
  const iso = () => new Date(now()).toISOString();
  const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });
  const runStore = createRunStore({ table: () => supabase.from('browser_actor_runs'), now });
  const tokenStore = createAgentTokenStore({ table: () => supabase.from('browser_actor_agent_tokens'), now });

  async function saveMetadata(site, metadata) {
    const { data, error } = await supabase
      .from('site_tenants')
      .update({ metadata })
      .eq('id', site.id)
      .select('id, slug, metadata')
      .maybeSingle();
    if (error) {
      // Same honesty as the voice route: name the migration instead of pretending.
      const missingColumn = /column .*metadata/i.test(error.message || '');
      const failure = new Error(missingColumn
        ? 'site_tenants.metadata is missing on this host — run migrations/2026-10-11_add_site_tenants_multitenant.sql'
        : error.message);
      failure.status = missingColumn ? 503 : 502;
      throw failure;
    }
    return data;
  }

  router.get('/tenant/blogger/browser-access', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return fail(res, 404, 'Tenant not found');
      const resolved = resolveAccessIdentity({
        tenantSlug: ctx.site.slug,
        metadata: ctx.site.metadata,
        envMap: parseProfileMapSafe(env.BROWSER_ACTOR_PROFILES),
        defaultEnvId: env.BROWSER_ACTOR_DEFAULT_ENV_ID || '',
        // A profile reported by the tenant's own worker counts here too, otherwise this panel
        // would say "no browser is set up" on a machine that is about to run a capture.
        workerRuns: true
      });
      // Workers ride along with the status so the panel needs one request, not two. A
      // missing token table is not an error here: it means the migration is pending, and the
      // tenant should see "not set up yet" rather than a broken panel.
      let workers = [];
      let workersReady = true;
      try {
        workers = (await tokenStore.list({ tenantId: ctx.site.id })).map(describeAgentToken);
      } catch (error) {
        workersReady = false;
        console.error(`[browser-access] worker tokens unreadable for ${ctx.site.slug}: ${error?.message || error}`);
      }
      const active = workers.filter((worker) => !worker.revoked);
      res.json({
        ok: true,
        ...publicAccessStatus(ctx.site.metadata, { secretConfigured: canStore() }),
        // What a run would use right now, so the tenant can tell whether they are on their
        // own profile or the operator's hosted one.
        runSource: resolved ? resolved.source : 'none',
        workers,
        workersReady,
        activeWorkers: active.length,
        // The question the panel actually has to answer: has a worker ever checked in?
        workerLastSeenAt: active.map((worker) => worker.lastUsedAt).filter(Boolean).sort().pop() || null
      });
    } catch (error) {
      fail(res, error.status || 500, redact(error.message || 'Could not read browser access'));
    }
  });


  router.post('/tenant/blogger/browser-access/connect', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return fail(res, 404, 'Tenant not found');

      if (!canStore()) {
        return fail(res, 503, `Connecting your own browser needs ${ACCESS_KEY_ENV} on the server`, {
          hint: `Set ${ACCESS_KEY_ENV} to a random secret, then try again. Until then nothing is stored.`
        });
      }

      const apiKey = String(req.body?.apiKey || '').trim();
      if (apiKey.length < MIN_KEY_LENGTH) {
        return fail(res, 400, 'Paste the MoreLogin API key from your account settings');
      }

      const validation = await provider.validateKey({ apiKey }).catch((error) => ({
        ok: false,
        reason: 'provider_error',
        detail: redact(error?.message || String(error)),
        profiles: []
      }));
      if (!validation.ok) {
        return fail(res, 502, 'MoreLogin did not accept that key', {
          reason: validation.reason || 'provider_error',
          detail: validation.detail || null
        });
      }

      const profiles = Array.isArray(validation.profiles) ? validation.profiles : [];
      if (!profiles.length) {
        return fail(res, 409, 'That MoreLogin account has no browser profile yet', {
          hint: 'Create a profile in MoreLogin, sign into Micro1/Turing inside it, then paste the key again.'
        });
      }

      const requestedEnvId = req.body?.envId ? String(req.body.envId).trim() : null;
      if (requestedEnvId && !profiles.some((profile) => profile.envId === requestedEnvId)) {
        // A key may only ever bind a profile the key actually owns. Anything else is a
        // tenant claiming somebody else's browser.
        return fail(res, 403, 'That profile does not belong to this MoreLogin account', { profiles });
      }
      if (!requestedEnvId && profiles.length > 1) {
        return fail(res, 409, 'This MoreLogin account has more than one profile — choose one', { profiles });
      }

      const chosen = requestedEnvId
        ? profiles.find((profile) => profile.envId === requestedEnvId)
        : profiles[0];
      const runtimeType = String(req.body?.runtime || 'cloud').toLowerCase() === 'local' ? 'local' : 'cloud';

      const metadata = writeAccess(ctx.site.metadata, {
        envId: chosen.envId,
        runtime: runtimeType,
        label: req.body?.label ? String(req.body.label).slice(0, 120) : (chosen.name || null),
        keySealed: sealSecretWithEnv(apiKey, env),
        keyFingerprint: fingerprintSecret(apiKey),
        connectedAt: iso(),
        // A new key invalidates any earlier verdict: it may point at a different account.
        verifiedAt: null,
        verifiedPlatforms: [],
        reauthRequired: false,
        reauthPlatforms: [],
        lastCheckedAt: null
      });
      await saveMetadata(ctx.site, metadata);

      console.error(`[browser-access] tenant=${ctx.site.slug} connected profile=${chosen.envId} key=${fingerprintSecret(apiKey)}`);
      res.status(201).json({ ok: true, ...publicAccessStatus(metadata, { secretConfigured: true }) });
    } catch (error) {
      fail(res, error.status || 500, redact(error.message || 'Could not connect that profile'));
    }
  });

  /**
   * Start the tenant's profile once and ask each marketplace whether it is still signed in.
   *
   * This is the only endpoint that spends one of the tenant's daily starts, so it says so
   * in the response and refuses to run without a connected profile rather than starting a
   * browser to discover there is nothing to check.
   */
  router.post('/tenant/blogger/browser-access/verify', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return fail(res, 404, 'Tenant not found');

      const access = readAccess(ctx.site.metadata);
      if (!access) {
        return fail(res, 409, 'No browser is connected for this tenant yet', {
          hint: 'Connect your MoreLogin profile first.'
        });
      }

      const apiKey = access.keySealed && canStore() ? openSecretFromEnv(access.keySealed, env).value : null;
      if (!apiKey) {
        // A seal that will not open is a configuration change, not a bad tenant: the
        // credential is unusable and only reconnecting fixes it.
        return fail(res, 409, 'The stored MoreLogin key can no longer be read — reconnect the profile', {
          reason: 'reconnect_required'
        });
      }

      const platforms = Array.isArray(req.body?.platforms) && req.body.platforms.length
        ? req.body.platforms.map((value) => String(value).toLowerCase()).filter((value) => MARKETPLACES.includes(value))
        : MARKETPLACES;

      const check = await provider.checkSignedIn({
        apiKey,
        envId: access.envId,
        runtime: access.runtime,
        platforms
      });

      if (!check.ok) {
        // Starting failed (quota, still starting, provider down). Record the attempt but do
        // not convert "could not check" into "signed out" — that would alarm the tenant for
        // our own failure.
        const metadata = writeAccess(ctx.site.metadata, { lastCheckedAt: iso() });
        await saveMetadata(ctx.site, metadata);
        return fail(res, 502, check.note || 'Could not check the profile right now', {
          reason: check.reason || 'provider_error'
        });
      }

      const summary = summarizeSignedIn(check.results || {});
      const metadata = writeAccess(ctx.site.metadata, {
        verifiedAt: summary.verified.length ? iso() : access.verifiedAt,
        verifiedPlatforms: summary.verified,
        reauthRequired: summary.reauthRequired,
        reauthPlatforms: summary.reauth,
        lastCheckedAt: iso()
      });
      await saveMetadata(ctx.site, metadata);

      console.error(`[browser-access] tenant=${ctx.site.slug} verify ${JSON.stringify(summary.platforms)} (${check.elapsedMs}ms)`);
      const status = publicAccessStatus(metadata, { secretConfigured: canStore() });
      res.json({
        // Status first, so a later field with the same name wins deliberately rather than
        // by accident. `platforms` in the status means "verified platforms"; the verdicts
        // of this check are `states`, which is a different question.
        ...status,
        ok: !summary.reauthRequired,
        states: summary.platforms,
        verified: summary.verified,
        reauthPlatforms: summary.reauth,
        elapsedMs: check.elapsedMs ?? null,
        // Spelled out because it is the tenant's quota, not ours.
        note: 'One MoreLogin profile start was used for this check.'
      });

    } catch (error) {
      fail(res, error.status || 500, redact(error.message || 'Could not verify the profile'));
    }
  });

  router.post('/tenant/blogger/browser-access/disconnect', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return fail(res, 404, 'Tenant not found');
      // Both halves go: a stale profile id left behind after Disconnect would keep resolving
      // runs to a browser the tenant believes they removed. The worker re-reports it on its
      // next start, so nothing is lost when it should not be.
      const metadata = clearWorkerBrowser(clearAccess(ctx.site.metadata));
      await saveMetadata(ctx.site, metadata);
      console.error(`[browser-access] tenant=${ctx.site.slug} disconnected`);
      res.json({
        ok: true,
        ...publicAccessStatus(metadata, { secretConfigured: canStore() }),
        note: 'The stored key was deleted, and the profile your worker reported is forgotten too. Your MoreLogin account and profile are untouched.'
      });
    } catch (error) {
      fail(res, error.status || 500, redact(error.message || 'Could not disconnect'));
    }
  });

  /**
   * Start a capture now, from the portal.
   *
   * The tenant presses the button because the browser is *theirs* and lives in the cloud;
   * the portal only needs to start it and watch. Everything that can go wrong says so
   * before a single start is spent — no profile, no cloud runtime, unsupported marketplace,
   * or a run already in flight.
   */
  router.post('/tenant/blogger/browser-access/capture', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return fail(res, 404, 'Tenant not found');

      const access = readAccess(ctx.site.metadata);
      if (!access) {
        return fail(res, 409, 'Connect your own browser first — the portal can only capture on a profile you own', {
          reason: 'not_connected'
        });
      }
      // A cloud profile can be started from here. A local one cannot — so the run is queued
      // for the tenant's own worker instead of being refused. Same button, same row, and
      // the portal's existing "waiting for a runner" state already describes it honestly.
      const runsInCloud = access.runtime === 'cloud';

      const platform = String(req.body?.platform || 'micro1').toLowerCase();
      if (!SERVER_SIDE_PLATFORMS.includes(platform)) {
        return fail(res, 400, `The portal can only capture ${SERVER_SIDE_PLATFORMS.join(', ')} on its own today`, {
          supported: SERVER_SIDE_PLATFORMS
        });
      }


      const requested = Number(req.body?.limit);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), 1), CAPTURE_MAX_LIMIT)
        : CAPTURE_DEFAULT_LIMIT;

      // One run per tenant **per marketplace**: the row's kind is what the partial unique
      // index scopes, so a Turing run waiting for an operator can no longer block the
      // Micro1 capture the tenant is able to run themselves (2026-11-03 — it did, live).
      const recent = await runStore.list({ tenantId: ctx.site.id, limit: 20 }).catch(() => []);
      const gate = canQueue(recent, { kind: MICRO1_RUN_KIND, now: now() });
      if (!gate.ok) return fail(res, 409, gate.message, { reason: 'already_running', run: gate.run || null });

      // `canQueue` ignores a run whose heartbeat stopped, because a dead worker should not
      // mean "never again". The database index does not know that — `status = 'running'` still
      // holds the (tenant, kind) slot — so an abandoned run must be closed *before* the insert.
      // Skipping this returned a 500 on a duplicate key, which reads as a server fault when it
      // is really a leftover row.
      const abandoned = recent.filter((row) => (
        String(row.kind || '').toLowerCase() === MICRO1_RUN_KIND &&
        isActiveStatus(row.status) &&
        isStalled(row, now())
      ));
      for (const row of abandoned) {
        await runStore.finish({
          runId: row.id,
          status: 'failed',
          done: row.done_items,
          ok: row.ok_items,
          failed: row.failed_items,
          total: row.total_items,
          message: 'The worker stopped reporting, so this run was closed to let a new one start.',
          detail: { abandoned: true, lastHeartbeatAt: row.heartbeat_at || null }
        }).catch((error) => {
          console.error(`[browser-access] could not close abandoned run ${row.id}: ${error?.message || error}`);
        });
        console.error(`[browser-access] tenant=${ctx.site.slug} closed abandoned run ${row.id}`);
      }

      let run = null;
      try {
        run = await runStore.queue({
          tenantId: ctx.site.id,
          kind: MICRO1_RUN_KIND,
          sourceSlug: platform,
          requestedBy: 'tenant:portal',
          detail: { limit, platform, via: 'portal', runtime: access.runtime }
        });
      } catch (error) {
        // 23505 = the partial unique index. Someone queued between our read and our insert
        // (or a second tab did). That is a conflict to report, not a server error.
        if (String(error?.code || '') === '23505' || /uq_browser_actor_runs_active/.test(error?.message || '')) {
          return fail(res, 409, 'A capture is already waiting or running for this tenant — give it a moment, then try again', {
            reason: 'already_running'
          });
        }
        throw error;
      }
      if (!run?.id) return fail(res, 503, 'Run tracking is not set up on this host');

      // Local profile: queue only. The tenant's worker claims it on the machine where the
      // browser actually is; pretending to start it here would leave a row running forever.
      if (!runsInCloud) {
        console.error(`[browser-access] tenant=${ctx.site.slug} queued run=${run.id} for the tenant's local worker`);
        // Whether a worker even exists decides the message: "wait for your worker" is useless
        // advice to a tenant who has never created one.
        let hasWorker = false;
        try {
          hasWorker = (await tokenStore.list({ tenantId: ctx.site.id }))
            .some((token) => !token.revoked_at);
        } catch { /* treated as "unknown", which reads as "create one" */ }
        return res.status(202).json({
          ok: true,
          run: { id: run.id, status: 'queued', kind: MICRO1_RUN_KIND, platform, limit },
          queuedForWorker: true,
          needsWorkerToken: !hasWorker,
          note: hasWorker
            ? 'Queued for your worker — it starts as soon as your computer picks it up.'
            : 'Queued. Your profile runs on your own computer, so create a worker token below and start the worker there; it will pick this up.'
        });
      }

      let spawned = null;
      try {
        spawned = spawnRun({ slug: ctx.site.slug, runId: run.id, limit, platform });
      } catch (error) {
        await runStore.finish({
          runId: run.id,
          status: 'failed',
          done: 0, ok: 0, failed: 0, total: limit,
          message: `could not start the runner: ${redact(error?.message || error)}`
        }).catch(() => {});
        return fail(res, 502, 'Could not start the runner on this host', { detail: redact(error?.message || error) });
      }

      console.error(`[browser-access] tenant=${ctx.site.slug} portal capture run=${run.id} pid=${spawned?.pid || '?'} limit=${limit}`);
      res.status(202).json({
        ok: true,
        run: { id: run.id, status: 'queued', kind: MICRO1_RUN_KIND, platform, limit },
        // The portal polls /tenant/blogger/writer-flow for this row; the tenant does not
        // need to keep the tab open, and a redeploy will not orphan their import silently
        // because the row records what happened.
        note: `Started. It uses one MoreLogin profile start from your plan. Progress appears in Collection control.`
      });
    } catch (error) {
      fail(res, error.status || 500, redact(error.message || 'Could not start the capture'));
    }
  });

  /**
   * Worker tokens: the credential a tenant's own machine uses to claim its runs.
   *
   * Issued once and shown once. The list endpoint never returns a usable token — only a
   * prefix, so a tenant can tell two workers apart ("wkr_9f2c…") the way a bank shows the
   * last four digits of an account.
   */
  router.post('/tenant/blogger/browser-access/worker-token', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return fail(res, 404, 'Tenant not found');
      const issued = await tokenStore.issue({ tenantId: ctx.site.id, label: req.body?.label });
      console.error(`[browser-access] tenant=${ctx.site.slug} issued worker token ${issued.row?.token_prefix || ''}`);
      res.status(201).json({
        ok: true,
        // Shown once. If it is lost, revoke and create another — that is the whole point of
        // storing a hash.
        token: issued.token,
        worker: describeAgentToken(issued.row),
        command: `node scripts/browser_actor_worker.mjs --api ${req.protocol}://${req.get('host')} --token ${issued.token}`,
        note: 'Copy this now — it is not shown again. Run the command on the computer where your MoreLogin profile lives.'
      });
    } catch (error) {
      fail(res, error.status || 500, redact(error.message || 'Could not create a worker token'));
    }
  });

  router.get('/tenant/blogger/browser-access/worker-token', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return fail(res, 404, 'Tenant not found');
      const rows = await tokenStore.list({ tenantId: ctx.site.id });
      const workers = rows.map(describeAgentToken);
      res.json({
        ok: true,
        workers,
        active: workers.filter((worker) => !worker.revoked).length,
        hint: workers.some((worker) => !worker.revoked)
          ? 'Run the worker on the computer where your MoreLogin profile lives; it picks up queued runs.'
          : 'Create a worker token, then run the printed command on your own computer. Nothing is exposed to us.'
      });
    } catch (error) {
      fail(res, error.status || 500, redact(error.message || 'Could not read worker tokens'));
    }
  });

  router.delete('/tenant/blogger/browser-access/worker-token/:id', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return fail(res, 404, 'Tenant not found');
      const revoked = await tokenStore.revoke({ tenantId: ctx.site.id, id: req.params.id });
      if (!revoked) return fail(res, 404, 'No active worker token with that id');
      console.error(`[browser-access] tenant=${ctx.site.slug} revoked worker token ${revoked.token_prefix || ''}`);
      res.json({ ok: true, worker: describeAgentToken(revoked), note: 'That worker is switched off immediately.' });
    } catch (error) {
      fail(res, error.status || 500, redact(error.message || 'Could not revoke that token'));
    }
  });

  /**
   * The worker as a zip: what a non-technical tenant actually needs.
   *
   * Built on demand from the repo's own source files, so the tenant always gets the code that
   * is deployed (no stale artifact to forget about) and there is nothing tenant-specific
   * inside it — the token is typed on their machine, never shipped.
   */
  router.get('/tenant/blogger/browser-access/worker-bundle', tenantSessionAuth, async (req, res) => {
    try {
      const ctx = await tenantSiteFromSession(req);
      if (!ctx) return fail(res, 404, 'Tenant not found');
      const { buildWorkerBundle } = await import('../utils/browserActor/workerBundle.js');
      const { createPairingStore } = await import('../utils/browserActor/pairing.js');
      const base = `${req.protocol}://${req.get('host')}`;

      // The code inside the download is what saves the tenant from copying a credential
      // between two apps. If the pairing table is missing (migration not applied), fall back
      // to a download without a code rather than failing the whole setup — the worker still
      // accepts a pasted token.
      let pairCode = null;
      try {
        const issued = await createPairingStore({ table: () => supabase.from(PAIRING_TABLE), now }).issue({
          tenantId: ctx.site.id,
          label: 'download'
        });
        pairCode = issued.code;
      } catch (error) {
        console.error(`[browser-access] no pairing code for ${ctx.site.slug}: ${error?.message || error}`);
      }

      const { zip, entries } = buildWorkerBundle({ apiBase: base, pairCode });
      console.error(`[browser-access] tenant=${ctx.site.slug} downloaded the worker (${entries.length} files, ${Math.round(zip.length / 1024)}kb${pairCode ? ', paired' : ', no pairing table'})`);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="alphadome-worker.zip"');
      res.setHeader('Content-Length', String(zip.length));
      res.setHeader('Cache-Control', 'no-store');
      res.end(zip);
    } catch (error) {
      fail(res, error.status || 500, redact(error.message || 'Could not build the worker bundle'));
    }
  });

  return router;
}




