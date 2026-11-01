/**
 * The real MoreLogin provider for tenant-owned access (2026-11-02)
 *
 * Two operations, both driven by the tenant's own API key:
 *
 *   validateKey   — is this key real, and which profiles does it own?
 *   checkSignedIn — start the tenant's profile once and ask each marketplace whether it
 *                   still has a session
 *
 * Everything here talks to a live vendor, so the router takes this as an **injectable
 * dependency** and the tests substitute a fake. That keeps the rules (refuse an unknown
 * profile, never store an unusable key, never claim "verified" without evidence) testable
 * without a browser.
 *
 * One honest caveat, recorded in BROWSER_ACTOR_RUNTIME.md: the cloud attach path below is
 * written against the documented `cdpUrl` contract but has not been exercised live yet —
 * this host's plan is out of daily starts (OPEN_FLAGS #16), and malingu-ventures runs a
 * hosted local profile rather than a BYO one.
 */
import { createMoreloginClient } from './browserActor/moreloginClient.js';
import { createBrowserRuntime } from './browserActor/runtime.js';
import { CdpSession, resolveDebugTarget } from './browserActor/cdp.js';
import { signedInProbeFor } from './browserActor/signedIn.js';
import { MICRO1_PLATFORM } from './browserActor/tasks/micro1.js';
import { TURING_PLATFORM } from './browserActor/tasks/turing.js';

/** Where each marketplace keeps its listing. */
export const MARKETPLACE_URLS = Object.freeze({
  micro1: MICRO1_PLATFORM.listUrl,
  turing: TURING_PLATFORM.listUrl
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A websocket attach point for a started profile.
 *
 * Local profiles expose a debug port on the machine that started them; cloud profiles
 * expose a `cdpUrl`, which may be an http(s) discovery URL or a ready ws:// endpoint.
 */
async function attachPoint(started) {
  if (started?.debugPort) {
    const target = await resolveDebugTarget({ host: started.host, port: started.debugPort });
    if (!target.pageWsUrl) throw new Error('the profile exposed no page target');
    return target.pageWsUrl;
  }
  const cdpUrl = String(started?.cdpUrl || '');
  if (!cdpUrl) throw new Error('the profile started without a debug port or cdpUrl');
  if (/^wss?:\/\//i.test(cdpUrl)) return cdpUrl;
  const base = cdpUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/json/version`, { headers: { accept: 'application/json' } });
  const body = await response.json();
  const wsUrl = body?.webSocketDebuggerUrl || body?.wsUrl || null;
  if (!wsUrl) throw new Error('the cloud profile returned no websocket endpoint');
  return wsUrl;
}

async function evaluateJson(session, expression) {
  const result = await session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 30_000 });
  const raw = result?.result?.value;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** Navigate and wait for a rendered document over an existing session. */
async function openPage(session, url, { settleMs = 2_500 } = {}) {
  await session.send('Page.enable', {}, { timeoutMs: 10_000 }).catch(() => {});
  await session.send('Page.navigate', { url }, { timeoutMs: 30_000 });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const state = await evaluateJson(session, 'JSON.stringify({ s: document.readyState })').catch(() => null);
    if (state?.s === 'complete') break;
    await sleep(300);
  }
  // The listings are client-rendered, so `complete` is when they *start* filling in.
  await sleep(settleMs);
}

export function createTenantBrowserProvider({ now = () => Date.now() } = {}) {
  const runtimeFor = (apiKey) => createBrowserRuntime({ client: createMoreloginClient({ apiKey }) });

  return {
    /** Is this key real, and what does it own? */
    async validateKey({ apiKey }) {
      const runtime = runtimeFor(apiKey);
      const probe = await runtime.probe().catch((error) => ({ reachable: false, detail: error?.message || String(error) }));
      if (probe && probe.reachable === false) {
        return { ok: false, reason: 'provider_unreachable', detail: probe.detail || null, profiles: [] };
      }
      const list = await runtime.listProfiles({ pageNo: 1, pageSize: 50 });
      const profiles = (list.items || [])
        .map((item) => ({
          envId: String(item.envId || item.id || ''),
          name: item.envName || item.name || null,
          platform: item.platform || null
        }))
        .filter((profile) => /^\d{1,20}$/.test(profile.envId));
      return { ok: true, transport: probe?.transport || null, latencyMs: probe?.latencyMs ?? null, profiles };
    },

    /**
     * Start the tenant's profile once and report, per marketplace, whether it is still
     * signed in. One start covers both marketplaces — the same economy rule the runners
     * follow, now on the tenant's quota instead of ours.
     */
    async checkSignedIn({ apiKey, envId, runtime: runtimeType = 'cloud', platforms = Object.keys(MARKETPLACE_URLS) } = {}) {
      const requested = (Array.isArray(platforms) ? platforms : []).filter((platform) => MARKETPLACE_URLS[platform]);
      if (!requested.length) return { ok: false, reason: 'no_platforms', results: {} };

      const runtime = runtimeFor(apiKey);
      let session = null;
      const startedAt = now();
      try {
        const started = await runtime.startProfile(envId, {
          runtime: runtimeType === 'local' ? 'local' : 'cloud',
          headless: true
        });
        if (started.pending || (!started.debugPort && !started.cdpUrl)) {
          return {
            ok: false,
            reason: 'profile_starting',
            results: {},
            note: 'The profile is still starting — run Verify again in a minute.'
          };
        }

        const wsUrl = await attachPoint(started);
        session = await CdpSession.open({ wsUrl, timeoutMs: 15_000 });

        const results = {};
        for (const platform of requested) {
          const probe = signedInProbeFor(platform);
          if (!probe) {
            results[platform] = { ok: false, cards: 0, signals: [] };
            continue;
          }
          try {
            await openPage(session, MARKETPLACE_URLS[platform]);
            results[platform] = await evaluateJson(session, probe);
          } catch (error) {
            // One marketplace failing must not hide the other's verdict.
            results[platform] = { ok: false, cards: 0, signals: [], error: String(error?.message || error) };
          }
        }

        return { ok: true, results, startedAt, elapsedMs: now() - startedAt, runtime: started.runtime || runtimeType };
      } finally {
        if (session) { try { session.close(); } catch {} }
        try { await runtime.closeProfile(envId); } catch {}
      }
    }
  };
}

