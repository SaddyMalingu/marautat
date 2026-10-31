/**
 * MoreLogin runtime operations (2026-10-31)
 *
 * The transport in moreloginClient.js speaks HTTP or argv; this file speaks
 * "start a profile and tell me how to attach". It exists so the shapes the
 * vendor returns are normalised in exactly one place:
 *
 *   local  POST /api/env/start       -> { debugPort: "9222", webdriver }
 *   cloud  POST /cloudbrowser/connect -> { cdpUrl }   (a bearer credential)
 *
 * Two vendor facts drive the design:
 *   1. `debugPort` is a STRING. Agents attach with a number, so it is parsed
 *      once here and never re-derived downstream.
 *   2. A cloud `cdpUrl` carries the access token. It is returned to the caller
 *      but never logged, never cached in a list response, never persisted.
 */
import { BrowserActorError } from './errors.js';
import { START_TIMEOUT_MS, PHONE_TIMEOUT_MS } from './moreloginClient.js';

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

/** Pull the first array out of the several shapes the API uses for paging. */
export function extractList(parsed) {
  const data = parsed?.data;
  if (Array.isArray(data)) return data;
  const list = pickFirst(data?.dataList, data?.list, data?.records, data?.items, data?.rows);
  return Array.isArray(list) ? list : [];
}

export function extractTotal(parsed) {
  const data = parsed?.data ?? {};
  const total = pickFirst(data.total, data.totalCount, data.count, data.totalSize, parsed?.total);
  return Number.isFinite(Number(total)) && total !== null ? Number(total) : null;
}

/**
 * `doctor`/`status` answer either { status: "ok" } or
 * { httpStatus, ok, port, statusResponse: { status } } depending on the command.
 * Read whichever shape arrived instead of asserting one.
 */
function statusLabel(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed.statusResponse?.status ?? parsed.status ?? (parsed.ok === true ? 'ok' : null);
}

/**
 * Normalise a start/connect response into the attach contract.
 * @returns {{envId: string|null, debugPort: number|null, host: string, webdriver: string|null,
 *            cdpUrl: string|null, type: string|null, version: number|string|null, requestId: string|null}}
 */
export function normalizeStartResult(parsed, { host = '127.0.0.1', envId = null } = {}) {
  const data = parsed?.data ?? {};
  const portRaw = pickFirst(data.debugPort, data.debug_port, data.port, data.remoteDebuggingPort, data.cdpPort);
  const port = portRaw === null ? null : Number.parseInt(String(portRaw), 10);
  const debugPort = Number.isFinite(port) ? port : null;
  const cdpUrl = pickFirst(data.cdpUrl, data.cdp_url);

  if (debugPort === null && !cdpUrl) {
    // A start call that succeeds but hands back nothing usable is a failure for
    // the agent: it cannot attach. Fail loudly rather than return a silent null.
    throw new BrowserActorError('provider_error', 'MoreLogin started the profile but returned no debug port or cdpUrl', {
      details: { envId: envId ?? data.envId ?? null, returnedKeys: Object.keys(data).slice(0, 12) }
    });
  }

  return {
    envId: data.envId ? String(data.envId) : envId ? String(envId) : null,
    debugPort,
    host,
    webdriver: pickFirst(data.webdriver, data.webDriverPath, data.webdriverPath),
    cdpUrl: cdpUrl ? String(cdpUrl) : null,
    type: data.type ? String(data.type) : null,
    version: pickFirst(data.version, null),
    requestId: parsed?.requestId ?? null
  };
}

export function createBrowserRuntime({ client }) {
  if (!client?.cfg) throw new BrowserActorError('not_configured', 'createBrowserRuntime needs a MoreLogin client');

  /** Is MoreLogin actually usable from this host right now? */
  async function probe() {
    const startedAt = Date.now();
    try {
      const parsed = await client.request({
        cli: { tokens: ['doctor'], flags: { '--output-json': null } },
        http: { path: '/api/env/page', body: { pageNo: 1, pageSize: 1 } }
      });
      return {
        reachable: parsed?.ok !== false,
        transport: client.cfg.transport,
        latencyMs: Date.now() - startedAt,
        detail: parsed?.data?.status ?? statusLabel(parsed) ?? 'ok'
      };
    } catch (error) {
      return {
        reachable: false,
        transport: client.cfg.transport,
        latencyMs: Date.now() - startedAt,
        error: error instanceof BrowserActorError ? error.code : 'provider_unavailable',
        message: error?.message || 'MoreLogin is not reachable'
      };
    }
  }

  async function listProfiles({ pageNo = 1, pageSize = 20, keyword = null } = {}) {
    const parsed = await client.request({
      cli: {
        tokens: ['env', 'list'],
        flags: { '--page-no': pageNo, '--page-size': pageSize, ...(keyword ? { '--keyword': keyword } : {}) }
      },
      http: { path: '/api/env/page', body: { pageNo, pageSize, ...(keyword ? { keyword } : {}) } }
    });
    const items = extractList(parsed).map((item) => ({
      envId: item.envId ? String(item.envId) : item.id ? String(item.id) : null,
      envName: item.envName ?? item.name ?? null,
      groupName: item.groupName ?? null,
      proxy: item.proxyName ?? item.proxy?.proxyName ?? null,
      running: pickFirst(item.running, item.isRunning, item.status)
    }));
    return { items, total: extractTotal(parsed) };
  }

  /**
   * Start a profile and return the attach contract.
   * Local profiles answer with a debug port; cloud profiles need a second call
   * and may still be provisioning, which is reported as `pending`.
   */
  async function startProfile(envId, { headless = true, cdpEvasion = true, encryptKey = null, runtime = 'local' } = {}) {
    if (!envId) throw new BrowserActorError('invalid_request', 'startProfile needs an envId');

    if (runtime === 'cloud') {
      const started = await client.request({
        cli: { tokens: ['cloud-browser', 'start'], flags: { '--env-id': envId } },
        http: { path: '/api/cloudbrowser/start', body: { envId } },
        timeoutMs: START_TIMEOUT_MS
      });
      let connected = null;
      try {
        connected = await client.request({
          cli: { tokens: ['cloud-browser', 'connect'], flags: { '--env-id': envId } },
          http: { path: '/api/cloudbrowser/connect', body: { envId } },
          timeoutMs: START_TIMEOUT_MS
        });
      } catch {
        // Cloud start is asynchronous: connecting before RUNNING fails, and the
        // caller is expected to poll. Keep the accepted start result.
        connected = null;
      }
      const status = started?.data?.cloudBrowserStatus ?? started?.data?.status ?? 'STARTING';
      const normalized = connected?.data?.cdpUrl
        ? normalizeStartResult(connected, { host: client.cfg.host, envId })
        : { envId: String(envId), debugPort: null, host: client.cfg.host, webdriver: null, cdpUrl: null, type: null, version: null, requestId: null };
      return { ...normalized, runtime: 'cloud', status: String(status), pending: !normalized.cdpUrl };
    }

    const parsed = await client.request({
      cli: {
        tokens: ['env', 'start'],
        flags: {
          '--env-id': envId,
          '--is-headless': String(Boolean(headless)),
          '--cdp-evasion': String(Boolean(cdpEvasion)),
          ...(encryptKey ? { '--encrypt-key': encryptKey } : {})
        }
      },
      http: {
        path: '/api/env/start',
        body: {
          envId,
          isHeadless: Boolean(headless),
          cdpEvasion: Boolean(cdpEvasion),
          ...(encryptKey ? { encryptKey } : {})
        }
      },
      timeoutMs: START_TIMEOUT_MS
    });

    return {
      ...normalizeStartResult(parsed, { host: client.cfg.host, envId }),
      runtime: 'local',
      status: 'RUNNING',
      pending: false
    };
  }

  /**
   * Stop a profile. The docs expose `close` on the Local API; older CLI builds
   * only ship `stop`, so a clap "unexpected argument" falls back once.
   */
  async function closeProfile(envId) {
    if (!envId) throw new BrowserActorError('invalid_request', 'closeProfile needs an envId');
    try {
      return await client.request({
        cli: { tokens: ['env', 'close'], flags: { '--env-id': envId } },
        http: { path: '/api/env/close', body: { envId } }
      });
    } catch (error) {
      const looksLikeMissingSubcommand =
        error instanceof BrowserActorError &&
        error.code === 'provider_unavailable' &&
        /unexpected argument|unrecogni[sz]ed|unknown subcommand|invalid subcommand/i.test(error.details?.stderr || '');
      if (!looksLikeMissingSubcommand) throw error;
      return client.request({
        cli: { tokens: ['env', 'stop'], flags: { '--env-id': envId } },
        http: { path: '/api/env/close', body: { envId } }
      });
    }
  }

  /** Cloud phones are a separate resource group: `cloudphone` in the CLI. */
  async function listPhones({ pageNo = 1, pageSize = 20, keyword = null } = {}) {
    const parsed = await client.request({
      cli: {
        tokens: ['cloudphone', 'list'],
        flags: { '--page-no': pageNo, '--page-size': pageSize, ...(keyword ? { '--keyword': keyword } : {}) }
      },
      http: { path: '/api/cloudphone/page', body: { pageNo, pageSize, ...(keyword ? { keyword } : {}) } }
    });
    const items = extractList(parsed).map((item) => ({
      id: item.id ? String(item.id) : item.phoneId ? String(item.phoneId) : null,
      name: item.name ?? item.phoneName ?? null,
      status: pickFirst(item.status, item.phoneStatus, item.running) ?? null,
      groupName: item.groupName ?? null
    }));
    return { items, total: extractTotal(parsed) };
  }

  /**
   * Open a cloud phone — the phone counterpart of env start.
   * Requires exactly one target: `ml-cli` refuses an ambiguous name.
   */
  async function openPhone({ id = null, keyword = null, headless = true } = {}) {
    if (!id && !keyword) throw new BrowserActorError('invalid_request', 'openPhone needs an id or a keyword');
    if (id && keyword) throw new BrowserActorError('invalid_request', 'openPhone accepts an id or a keyword, not both');
    if (client.cfg.transport !== 'cli') {
      throw new BrowserActorError('unsupported_transport', 'Opening a cloud phone needs the cli transport', {
        details: { transport: client.cfg.transport, expected: 'MORELOGIN_TRANSPORT=cli' }
      });
    }
    const parsed = await client.runCli(
      ['cloudphone', 'open'],
      {
        ...(id ? { '--id': id } : { '--keyword': keyword }),
        '--headless': String(Boolean(headless))
      },
      PHONE_TIMEOUT_MS
    );
    return {
      opened: true,
      target: id || keyword,
      headless: Boolean(headless),
      // Opening succeeds as a request, not as proof the device finished booting.
      note: 'Request accepted. Streaming readiness must be verified separately.',
      requestId: parsed?.requestId ?? null
    };
  }

  return { probe, listProfiles, startProfile, closeProfile, listPhones, openPhone, client };
}
