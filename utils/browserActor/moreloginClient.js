/**
 * MoreLogin client adapter (2026-10-31)
 *
 * Wraps the two ways MoreLogin can be driven from an Alphadome host:
 *
 *   cli  — the documented `ml-cli` binary (CLI 2.8.3). It discovers the desktop
 *          client's Local API port over a named pipe, which matters because the
 *          port is not stable between launches. This is the default.
 *   http — the Local API directly (http://127.0.0.1:40000 by default). It is
 *          what `ml-cli` itself calls, and it is what the test suite drives,
 *          so the runtime can be verified on a host with no MoreLogin install.
 *
 * Both transports return the same normalised shapes, so nothing downstream
 * needs to know which one is in use.
 *
 * Contract notes taken from the vendor docs (verified 2026-10-31):
 *   POST /api/env/start -> data { envId, debugPort: "9222", type, version, webdriver }
 *   POST /api/env/close  { envId }
 *   POST /api/env/page   { pageNo, pageSize }
 *   POST /api/cloudphone/page
 *   ids are decimal STRINGS (64-bit integers) — never parseInt them.
 *   `env start`/`cloudphone open` need ~30s/~120s timeouts, not the 15s default.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserActorError } from './errors.js';

const execFileAsync = promisify(execFile);

const CLI_INSTALL_URL = 'https://guide.morelogin.com/cli';
const CLI_SOURCE_VERSION = '2.8.3';
const LOCAL_API_BASE_PORT = 40000;

export const DEFAULT_TIMEOUT_MS = 20_000;
export const START_TIMEOUT_MS = 45_000;
export const PHONE_TIMEOUT_MS = 150_000;

/** Never let a bearer token reach a log line, an error message or an HTTP body. */
export function redact(value) {
  return String(value ?? '')
    .replace(/(api-key|apiKey|access_token|token)([=\s:]+)([^\s&"']+)/gi, '$1$2[redacted]')
    .replace(/--api-key\s+\S+/gi, '--api-key [redacted]');
}

export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // ml-cli may print progress on stdout before the JSON document.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function resolveConfig(overrides = {}) {
  const env = overrides.env || process.env;
  const transport = String(overrides.transport || env.MORELOGIN_TRANSPORT || 'cli').toLowerCase();
  if (transport !== 'cli' && transport !== 'http') {
    throw new BrowserActorError('not_configured', `Unknown MORELOGIN_TRANSPORT "${transport}"`, {
      details: { expected: 'cli | http' }
    });
  }
  // Only forward --port when an operator set it: passing a guessed port would
  // defeat the CLI's IPC discovery and break every host whose client picked a
  // different one.
  const configuredPort = overrides.port ?? env.MORELOGIN_PORT ?? env.ML_PORT;
  return {
    transport,
    cliPath: overrides.cliPath || env.MORELOGIN_CLI_PATH || 'ml-cli',
    host: overrides.host || env.MORELOGIN_HOST || '127.0.0.1',
    port: configuredPort ? Number(configuredPort) : transport === 'http' ? LOCAL_API_BASE_PORT : null,
    apiKey: overrides.apiKey ?? env.MORELOGIN_API_KEY ?? env.ML_API_KEY ?? '',
    timeoutMs: Number(overrides.timeoutMs || env.MORELOGIN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  };
}

export function providerError(parsed, fallbackMessage) {
  const providerCode = parsed?.code ?? parsed?.statusCode ?? null;
  return new BrowserActorError('provider_error', fallbackMessage || `MoreLogin returned code ${providerCode}`, {
    details: { providerCode, providerMessage: redact(parsed?.msg ?? parsed?.message ?? '') || null }
  });
}

export function cliArgsFor(cfg, tokens, flags, timeoutSec) {
  const args = [];
  if (cfg.port) args.push('--port', String(cfg.port));
  if (cfg.apiKey) args.push('--api-key', cfg.apiKey);
  args.push('--timeout', String(timeoutSec));
  // Ask the CLI to exit non-zero on a business failure: an HTTP 2xx with a
  // non-zero `code` must never be read as success.
  args.push('--fail-on-business-error');
  args.push(...tokens);
  for (const [flag, value] of Object.entries(flags || {})) {
    // undefined omits the flag; null emits a value-less boolean flag
    // (e.g. --output-json, --fail-on-business-error).
    if (value === undefined) continue;
    if (value === null) {
      args.push(flag);
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) args.push(flag, String(item));
  }
  return args;
}

/**
 * Only an actual envelope can carry a business failure.
 *
 * `env`/`cloudphone` calls answer { code, msg, data }, but `doctor`, `status`
 * and `agent-bootstrap` answer a bare object with no `code` at all. Treating a
 * missing `code` as failure made a healthy client look broken.
 */
export function isBusinessFailure(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(parsed, 'code')) return false;
  return Number(parsed.code) !== 0;
}

export function createMoreloginClient(options = {}) {
  const cfg = resolveConfig(options);
  const exec = typeof options.exec === 'function' ? options.exec : execFileAsync;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;

  async function runCli(tokens, flags, timeoutMs = cfg.timeoutMs) {
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000) + 5);
    const args = cliArgsFor(cfg, tokens, flags, timeoutSec);
    let result;
    try {
      result = await exec(cfg.cliPath, args, {
        timeout: timeoutMs + 15_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new BrowserActorError('cli_missing', 'ml-cli is not installed on this host', {
          details: { cliPath: cfg.cliPath, install: CLI_INSTALL_URL, verifiedAgainst: CLI_SOURCE_VERSION }
        });
      }
      if (error?.killed || error?.signal || error?.code === 'ETIMEDOUT') {
        throw new BrowserActorError('provider_timeout', 'ml-cli did not answer in time', {
          details: { timeoutMs, command: tokens.join(' ') }
        });
      }
      // execFile rejects on a non-zero exit, but the JSON body is still on stdio
      // and that is where the real reason lives.
      const parsed = parseJsonLoose(error?.stdout);
      if (parsed && isBusinessFailure(parsed)) throw providerError(parsed);
      if (parsed) return parsed;
      throw new BrowserActorError('provider_unavailable', 'ml-cli failed to run', {
        details: {
          command: tokens.join(' '),
          exitCode: error?.code ?? null,
          stderr: redact(error?.stderr || '').slice(0, 400) || null
        }
      });
    }

    const parsed = parseJsonLoose(result?.stdout);
    if (!parsed) {
      throw new BrowserActorError('provider_error', 'ml-cli returned output that was not JSON', {
        details: { command: tokens.join(' '), stdout: redact(result?.stdout || '').slice(0, 400) || null }
      });
    }
    if (isBusinessFailure(parsed)) throw providerError(parsed);
    return parsed;
  }

  async function httpPost(path, payload, timeoutMs = cfg.timeoutMs) {
    if (!cfg.port) {
      throw new BrowserActorError('not_configured', 'The http transport needs MORELOGIN_PORT', {
        details: { expected: `Local API port, default ${LOCAL_API_BASE_PORT}` }
      });
    }
    const url = `http://${cfg.host}:${cfg.port}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
        },
        body: JSON.stringify(payload || {}),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new BrowserActorError('provider_timeout', 'The MoreLogin Local API did not answer in time', {
          details: { path, timeoutMs }
        });
      }
      throw new BrowserActorError('provider_unavailable', 'Could not reach the MoreLogin Local API', {
        details: { path, host: cfg.host, port: cfg.port, reason: error?.cause?.code || error?.name || null }
      });
    }

    const text = await response.text();
    const parsed = parseJsonLoose(text);
    if (!response.ok) {
      throw new BrowserActorError('provider_error', `Local API returned HTTP ${response.status}`, {
        details: { path, status: response.status, providerMessage: redact(text).slice(0, 300) || null }
      });
    }
    if (!parsed) {
      throw new BrowserActorError('provider_error', 'Local API returned a body that was not JSON', { details: { path } });
    }
    if (isBusinessFailure(parsed)) throw providerError(parsed);
    return parsed;
  }

  /** Route a call to whichever transport is configured. */
  function request({ cli, http, timeoutMs }) {
    return cfg.transport === 'http'
      ? httpPost(http.path, http.body, timeoutMs)
      : runCli(cli.tokens, cli.flags, timeoutMs);
  }

  return { cfg, runCli, httpPost, request };
}
