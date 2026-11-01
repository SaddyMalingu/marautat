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
  clearAccess,
  fingerprintSecret,
  openSecret,
  publicAccessStatus,
  readAccess,
  resolveAccessIdentity,
  sealSecret,
  secretsConfigured,
  writeAccess
} from '../utils/tenantAccess.js';
import { summarizeSignedIn } from '../utils/browserActor/signedIn.js';
import { parseProfileMap } from '../utils/browserActor/identity.js';
import { redact } from '../utils/browserActor/moreloginClient.js';

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
  env = process.env,
  now = () => Date.now()
} = {}) {
  const router = Router();
  const canStore = () => secretsConfigured(env);
  const iso = () => new Date(now()).toISOString();
  const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });

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
        defaultEnvId: env.BROWSER_ACTOR_DEFAULT_ENV_ID || ''
      });
      res.json({
        ok: true,
        ...publicAccessStatus(ctx.site.metadata, { secretConfigured: canStore() }),
        // What a run would use right now, so the tenant can tell whether they are on their
        // own profile or the operator's hosted one.
        runSource: resolved ? resolved.source : 'none'
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
        keySealed: sealSecret(apiKey, env[ACCESS_KEY_ENV]),
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

      const apiKey = access.keySealed && canStore() ? openSecret(access.keySealed, env[ACCESS_KEY_ENV]) : null;
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
      const metadata = clearAccess(ctx.site.metadata);
      await saveMetadata(ctx.site, metadata);
      console.error(`[browser-access] tenant=${ctx.site.slug} disconnected`);
      res.json({
        ok: true,
        ...publicAccessStatus(metadata, { secretConfigured: canStore() }),
        note: 'The stored key was deleted. Your MoreLogin account and profile are untouched.'
      });
    } catch (error) {
      fail(res, error.status || 500, redact(error.message || 'Could not disconnect'));
    }
  });

  return router;
}


