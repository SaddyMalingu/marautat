/**
 * Browser Actor routes (2026-10-31)
 *
 * The agent-facing door to MoreLogin. An Alphadome agent never holds a MoreLogin
 * credential; it calls this endpoint with one shared agent key and a tenant slug,
 * and receives either an attach point or a typed error it can act on.
 *
 *   GET    /api/agents/browser/health            provider reachability (cached 30s)
 *   GET    /api/agents/browser/profiles          which tenant owns which profile (masked)
 *   POST   /api/agents/browser/sessions          lease a profile and start it
 *   GET    /api/agents/browser/sessions          active leases (tenant-filtered)
 *   GET    /api/agents/browser/sessions/:id      one lease
 *   POST   /api/agents/browser/sessions/:id/heartbeat
 *   DELETE /api/agents/browser/sessions/:id      release (and optionally close the profile)
 *   POST   /api/agents/browser/capture           one-shot: lease -> start -> read page -> release
 *   GET    /api/agents/browser/phones            cloud phone inventory
 *   POST   /api/agents/browser/phones/open       open one cloud phone
 *
 * Fail-closed by design: with no AGENT_API_KEY / ADMIN_KEY / ADMIN_PASS set the
 * router answers 503 instead of exposing a browser farm to the internet.
 */
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { BrowserActorError, toPublicError } from '../utils/browserActor/errors.js';
import {
  IDENTITY_TABLE,
  SESSION_TABLE,
  parseProfileMap,
  resolveIdentity,
  describeIdentity,
  normalizeTenantSlug
} from '../utils/browserActor/identity.js';
import { createSessionBroker, publicSession, clampLease } from '../utils/browserActor/sessions.js';
import { createMoreloginClient } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { capturePage } from '../utils/browserActor/cdp.js';

const router = Router();

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }), insert: async () => ({ data: null, error: null }) }) };

// Lazily built so a missing MoreLogin install cannot crash the monolith at boot,
// and so tests can set env before the first call.
let runtimeInstance = null;
function runtime() {
  if (!runtimeInstance) runtimeInstance = createBrowserRuntime({ client: createMoreloginClient() });
  return runtimeInstance;
}

const broker = createSessionBroker({
  onEvent: (event) => {
    if (event.type === 'session_expired') {
      console.warn(`[browser-actor] lease expired for tenant=${event.session.tenant} session=${event.session.sessionId}`);
    }
  }
});

let probeCache = { at: 0, value: null };
const PROBE_TTL_MS = 30_000;

function sendError(res, error) {
  const { status, body } = toPublicError(error);
  if (status >= 500) console.error('[browser-actor]', body.error, body.message, body.details || '');
  res.status(status).json(body);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requireAgentKey(req, res, next) {
  const configured = process.env.AGENT_API_KEY || process.env.ADMIN_KEY || process.env.ADMIN_PASS || '';
  if (!configured) {
    return res.status(503).json({
      ok: false,
      error: 'not_configured',
      message: 'Set AGENT_API_KEY (or ADMIN_KEY / ADMIN_PASS) before exposing browser actors'
    });
  }
  const header = req.headers['x-agent-key'];
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const provided = header || bearer || req.query.key;
  if (!safeEqual(provided, configured)) {
    return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Invalid agent key' });
  }
  next();
}

router.use(requireAgentKey);

function tenantOf(req) {
  return normalizeTenantSlug(req.body?.tenant ?? req.query?.tenant);
}

/** Env map first, then the identities table. Never guesses from a shared default. */
async function identityFor(tenant) {
  const map = parseProfileMap(process.env.BROWSER_ACTOR_PROFILES || '');
  if (map[tenant]) return resolveIdentity({ tenantSlug: tenant, map });

  let rows = [];
  try {
    const result = await supabase.from(IDENTITY_TABLE).select('*').eq('is_active', true).limit(500);
    rows = Array.isArray(result?.data) ? result.data : [];
  } catch {
    rows = [];
  }
  return resolveIdentity({
    tenantSlug: tenant,
    map,
    tableRows: rows,
    defaultEnvId: process.env.BROWSER_ACTOR_DEFAULT_ENV_ID || ''
  });
}

async function audit(row) {
  try {
    await supabase.from(SESSION_TABLE).insert([
      { ...row, created_at: new Date().toISOString() }
    ]);
  } catch (error) {
    // Audit is never allowed to fail a browser operation.
  }
}

function attachInfo(started, { includeCdpUrl = false } = {}) {
  if (started?.debugPort) {
    return {
      host: started.host || '127.0.0.1',
      port: started.debugPort,
      browserURL: `http://${started.host || '127.0.0.1'}:${started.debugPort}`,
      webdriver: started.webdriver || null,
      wsUrl: null,
      note: 'Attach with Puppeteer (browserURL) or Playwright (connectOverCDP) on this host.'
    };
  }
  return {
    host: null,
    port: null,
    browserURL: null,
    webdriver: null,
    // A Cloud cdpUrl is a short-lived bearer credential: it is handed to the
    // agent that just created the lease and to nobody else. It is never stored
    // in the audit row and never returned by the list/detail endpoints.
    wsUrl: includeCdpUrl ? started?.cdpUrl || null : null,
    note: started?.pending
      ? `Cloud runtime is ${started.status || 'STARTING'}; poll POST /sessions/:id until RUNNING, then re-attach.`
      : started?.cdpUrl
        ? 'Attach with Playwright connectOverCDP(wsUrl). Treat wsUrl as a secret.'
        : 'No attach point was returned.'
  };
}


// ---------------------------------------------------------------------------
// Health and inventory
// ---------------------------------------------------------------------------

router.get('/health', async (_req, res) => {
  try {
    const fresh = Date.now() - probeCache.at < PROBE_TTL_MS && probeCache.value;
    const provider = fresh || (await runtime().probe());
    probeCache = { at: Date.now(), value: provider };
    res.json({
      ok: true,
      service: 'alphadome-browser-actor',
      provider,
      sessions: broker.stats(),
      configured: {
        transport: provider.transport || null,
        profilesFromEnv: Object.keys(parseProfileMap(process.env.BROWSER_ACTOR_PROFILES || '')).length
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/profiles', async (_req, res) => {
  try {
    const map = parseProfileMap(process.env.BROWSER_ACTOR_PROFILES || '');
    let rows = [];
    try {
      const result = await supabase.from(IDENTITY_TABLE).select('*').eq('is_active', true).limit(500);
      rows = Array.isArray(result?.data) ? result.data : [];
    } catch {
      rows = [];
    }
    const fromTable = rows
      .map((row) =>
        describeIdentity({
          tenantSlug: normalizeTenantSlug(row.tenant_slug),
          envId: String(row.env_id ?? ''),
          runtime: row.runtime || 'local',
          label: row.label,
          phoneId: row.phone_id,
          source: 'table'
        })
      )
      .filter((row) => row.tenant);
    const fromEnv = Object.values(map).map((entry) => describeIdentity({ ...entry, source: 'env_map' }));

    res.json({
      ok: true,
      profiles: [...fromEnv, ...fromTable],
      defaultConfigured: Boolean(process.env.BROWSER_ACTOR_DEFAULT_ENV_ID)
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

router.post('/sessions', async (req, res) => {
  try {
    const tenant = tenantOf(req);
    if (!tenant) throw new BrowserActorError('invalid_request', 'tenant is required');
    const identity = await identityFor(tenant);

    const ttlSeconds = Number(req.body?.ttlSeconds);
    const session = broker.acquire({
      identity,
      actor: req.body?.actor || 'agent',
      leaseMs: Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? clampLease(ttlSeconds * 1000) : undefined,
      purpose: req.body?.purpose || null
    });

    let started;
    try {
      started = await runtime().startProfile(identity.envId, {
        headless: req.body?.headless !== false,
        cdpEvasion: req.body?.cdpEvasion !== false,
        runtime: identity.runtime
      });
    } catch (error) {
      // The lease must not outlive a failed start, or the profile looks busy
      // until the TTL expires and the next agent is blocked for nothing.
      broker.release(session.id, session.leaseToken, 'start_failed');
      throw error;
    }

    broker.attach(session.id, session.leaseToken, started);
    await audit({
      id: session.id,
      tenant_slug: tenant,
      env_id: identity.envId,
      runtime: identity.runtime,
      actor: session.actor,
      status: started.pending ? 'starting' : 'opened',
      provider_debug_port: started.debugPort ?? null,
      lease_expires_at: new Date(session.expiresAt).toISOString(),
      metadata: { purpose: session.purpose, providerStatus: started.status || null }
    });

    res.status(started.pending ? 202 : 201).json({
      ok: true,
      session: publicSession(session, { includeToken: true, includeCdp: true }),
      attach: attachInfo(started, { includeCdpUrl: true }),
      provider: { runtime: identity.runtime, status: started.status, pending: Boolean(started.pending) }
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/sessions', (req, res) => {
  try {
    const tenant = tenantOf(req);
    res.json({ ok: true, sessions: broker.list({ tenantSlug: tenant || null }) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/sessions/:id', (req, res) => {
  try {
    const tenant = tenantOf(req);
    const session = broker.get(req.params.id, { tenantSlug: tenant || null });
    res.json({ ok: true, session: publicSession(session, { includeCdp: true }) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/sessions/:id/heartbeat', (req, res) => {
  try {
    const token = req.body?.leaseToken || req.headers['x-lease-token'];
    const ttlSeconds = Number(req.body?.ttlSeconds);
    const session = broker.heartbeat(
      req.params.id,
      token,
      Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? clampLease(ttlSeconds * 1000) : undefined
    );
    res.json({ ok: true, session: publicSession(session, { includeCdp: true }) });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/sessions/:id', async (req, res) => {
  try {
    const token = req.body?.leaseToken || req.headers['x-lease-token'];
    const session = broker.release(req.params.id, token, req.query.reason || 'released');

    let closed = false;
    // Closing the profile is the default because a leaked running profile keeps
    // burning proxy bandwidth and can hold a logged-in session open.
    if (req.query.close !== 'false' && req.query.close !== '0') {
      try {
        await runtime().closeProfile(session.envId);
        closed = true;
      } catch (error) {
        closed = false;
      }
    }
    await audit({
      id: session.id,
      tenant_slug: session.tenantSlug,
      env_id: session.envId,
      runtime: session.runtime,
      actor: session.actor,
      status: 'closed',
      provider_debug_port: session.cdp?.debugPort ?? null,
      lease_expires_at: new Date(session.expiresAt).toISOString(),
      metadata: { reason: String(req.query.reason || 'released'), profileClosed: closed }
    });

    res.json({ ok: true, released: publicSession(session), profileClosed: closed });
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------------
// One-shot capture: the primitive an agent actually calls
// ---------------------------------------------------------------------------

function assertSafeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new BrowserActorError('invalid_request', 'url is required');
  if (value.length > 2048) throw new BrowserActorError('invalid_request', 'url is too long');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserActorError('invalid_request', 'url is not a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserActorError('invalid_request', 'url must be http or https', { details: { protocol: parsed.protocol } });
  }
  return parsed.toString();
}

router.post('/capture', async (req, res) => {
  let session = null;
  let identity = null;
  const shouldClose = req.body?.close !== false && req.query.close !== 'false';

  try {
    const tenant = tenantOf(req);
    if (!tenant) throw new BrowserActorError('invalid_request', 'tenant is required');
    const url = assertSafeUrl(req.body?.url);
    const maxChars = Number(req.body?.maxChars) || 4000;
    const maxLinks = Number(req.body?.maxLinks) || 40;
    const timeoutMs = Number(req.body?.timeoutMs) || 30_000;

    identity = await identityFor(tenant);
    session = broker.acquire({ identity, actor: req.body?.actor || 'agent', purpose: `capture ${url}`.slice(0, 200) });

    const started = await runtime().startProfile(identity.envId, {
      headless: req.body?.headless !== false,
      cdpEvasion: req.body?.cdpEvasion !== false,
      runtime: identity.runtime
    });
    if (!started.debugPort) {
      throw new BrowserActorError('provider_error', 'The profile is not ready to capture yet', {
        details: { runtime: identity.runtime, status: started.status, pending: Boolean(started.pending) }
      });
    }
    broker.attach(session.id, session.leaseToken, started);

    const page = await capturePage({
      host: started.host,
      port: started.debugPort,
      url,
      timeoutMs,
      maxChars,
      maxLinks
    });

    await audit({
      id: session.id,
      tenant_slug: tenant,
      env_id: identity.envId,
      runtime: identity.runtime,
      actor: session.actor,
      status: 'captured',
      provider_debug_port: started.debugPort,
      lease_expires_at: new Date(session.expiresAt).toISOString(),
      metadata: { url, title: page.title || null, links: page.counts?.links ?? null }
    });

    res.json({
      ok: true,
      page,
      session: publicSession(session, { includeCdp: true })
    });
  } catch (error) {
    sendError(res, error);
  } finally {
    if (session) {
      try { broker.release(session.id, session.leaseToken, 'capture_complete'); } catch {}
    }
    if (shouldClose && identity && identity.runtime === 'local') {
      try { await runtime().closeProfile(identity.envId); } catch {}
    }
  }
});

// ---------------------------------------------------------------------------
// Cloud phones
// ---------------------------------------------------------------------------

router.get('/phones', async (req, res) => {
  try {
    const pageNo = Number(req.query.pageNo) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const keyword = req.query.keyword ? String(req.query.keyword) : null;
    res.json({ ok: true, ...(await runtime().listPhones({ pageNo, pageSize, keyword })) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/phones/open', async (req, res) => {
  try {
    const result = await runtime().openPhone({
      id: req.body?.id ? String(req.body.id) : null,
      keyword: req.body?.keyword ? String(req.body.keyword) : null,
      headless: req.body?.headless !== false
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    sendError(res, error);
  }
});

// Anything the handlers did not catch (e.g. a body-parser failure) still gets
// the typed envelope rather than Express's HTML page.
router.use((error, _req, res, _next) => {
  sendError(res, error);
});

export default router;

