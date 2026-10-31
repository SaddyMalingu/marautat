/**
 * Minimal CDP client (2026-10-31)
 *
 * MoreLogin hands back a debug port, not a driver. Everything else — Puppeteer,
 * Playwright, Selenium — is a wrapper over the same Chrome DevTools Protocol.
 * The repo has no browser-automation dependency and this slice should not add
 * one, so the few CDP calls an agent actually needs live here:
 *
 *   Runtime.enable, Page.enable, Page.navigate and one Runtime.evaluate that
 *   returns the facts a lead-qualification or tender-capture agent works from.
 *
 * Node 22+ ships a global WebSocket, so this runs with zero installs. Both the
 * WebSocket class and fetch are injectable, which is how the test suite exercises
 * the protocol handling without a browser.
 */
import { BrowserActorError } from './errors.js';

export const CDP_HTTP_TIMEOUT_MS = 5_000;
export const CDP_CAPTURE_TIMEOUT_MS = 30_000;

async function getJson(fetchImpl, url, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new BrowserActorError('cdp_error', 'Could not reach the browser debug endpoint', {
      details: { url, reason: error?.cause?.code || error?.name || null }
    });
  }
  if (!response.ok) {
    throw new BrowserActorError('cdp_error', `Debug endpoint returned HTTP ${response.status}`, { details: { url } });
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new BrowserActorError('cdp_error', 'Debug endpoint returned a body that was not JSON', { details: { url } });
  }
}

/**
 * Discover the attach point for a started profile.
 * @returns {{browser: string|null, pageWsUrl: string|null, browserWsUrl: string|null, targetCount: number}}
 */
export async function resolveDebugTarget({
  host = '127.0.0.1',
  port,
  fetchImpl = globalThis.fetch,
  timeoutMs = CDP_HTTP_TIMEOUT_MS
} = {}) {
  if (!port) throw new BrowserActorError('invalid_request', 'resolveDebugTarget needs a debug port');
  const base = `http://${host}:${port}`;
  const version = await getJson(fetchImpl, `${base}/json/version`, timeoutMs);

  let targets = [];
  try {
    const listed = await getJson(fetchImpl, `${base}/json/list`, timeoutMs);
    targets = Array.isArray(listed) ? listed : [];
  } catch {
    targets = [];
  }
  const page = targets.find((t) => t?.type === 'page' && t?.webSocketDebuggerUrl) ||
    targets.find((t) => t?.webSocketDebuggerUrl) ||
    null;

  return {
    browser: version?.Browser ?? null,
    pageWsUrl: page?.webSocketDebuggerUrl ?? null,
    browserWsUrl: version?.webSocketDebuggerUrl ?? null,
    targetCount: targets.length
  };
}

/** One request/response channel over a CDP socket. */
export class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.closed = false;
  }

  static async open({ wsUrl, WebSocketImpl = globalThis.WebSocket, timeoutMs = CDP_HTTP_TIMEOUT_MS } = {}) {
    if (!wsUrl) throw new BrowserActorError('cdp_error', 'No CDP websocket URL to attach to');
    if (typeof WebSocketImpl !== 'function') {
      throw new BrowserActorError('cdp_error', 'This Node runtime has no WebSocket implementation', {
        details: { expected: 'Node 22+ (global WebSocket) or pass WebSocketImpl' }
      });
    }

    const socket = new WebSocketImpl(wsUrl);
    const session = new CdpSession(socket);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { socket.close(); } catch {}
        reject(new BrowserActorError('cdp_timeout', 'Timed out attaching to the browser', { details: { timeoutMs } }));
      }, timeoutMs);
      timer.unref?.();

      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = (event) => {
        clearTimeout(timer);
        reject(new BrowserActorError('cdp_error', 'The browser refused the CDP connection', {
          details: { reason: event?.message || 'socket_error' }
        }));
      };
    });

    socket.onmessage = (event) => session.handleMessage(event?.data);
    socket.onclose = () => {
      session.closed = true;
      for (const { reject } of session.pending.values()) {
        reject(new BrowserActorError('cdp_error', 'The CDP connection closed before the call answered'));
      }
      session.pending.clear();
    };
    return session;
  }

  handleMessage(raw) {
    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new BrowserActorError('cdp_error', message.error.message || 'CDP call failed', {
          details: { cdpCode: message.error.code ?? null }
        }));
      } else {
        resolve(message.result);
      }
      return;
    }
    if (message.method) {
      const list = this.waiters.get(message.method);
      if (list && list.length) list.shift()(message.params);
    }
  }

  send(method, params = {}, { timeoutMs = CDP_CAPTURE_TIMEOUT_MS } = {}) {
    if (this.closed) {
      return Promise.reject(new BrowserActorError('cdp_error', 'The CDP connection is closed', { details: { method } }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserActorError('cdp_timeout', `CDP call ${method} timed out`, { details: { method, timeoutMs } }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BrowserActorError('cdp_error', 'Could not send the CDP call', { details: { method } }));
      }
    });
  }

  /** Resolve on the next event, or null on timeout (never rejects). */
  waitFor(method, timeoutMs = 15_000) {
    return new Promise((resolve) => {
      const list = this.waiters.get(method) || [];
      let settled = false;
      let timer;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => done(null), timeoutMs);
      timer.unref?.();
      list.push(done);
      this.waiters.set(method, list);
    });
  }

  close() {
    this.closed = true;
    try { this.socket.close(); } catch {}
  }
}

/**
 * The single Runtime.evaluate an agent needs. It is deliberately one round trip:
 * a page can navigate or re-render between calls, so everything is read from the
 * same DOM snapshot.
 */
export function buildCaptureExpression(maxChars = 4000, maxLinks = 40) {
  const chars = Math.max(200, Math.min(Number(maxChars) || 4000, 20000));
  const links = Math.max(1, Math.min(Number(maxLinks) || 40, 200));
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const meta = (name) => {
    const el = document.querySelector('meta[name="' + name + '"]');
    return el ? clean(el.getAttribute('content')) : null;
  };
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  return JSON.stringify({
    title: clean(document.title),
    url: String(location.href),
    description: meta('description'),
    headings: Array.from(document.querySelectorAll('h1,h2')).slice(0, 15).map((el) => clean(el.textContent)).filter(Boolean),
    text: clean(document.body ? document.body.innerText : '').slice(0, ${chars}),
    links: anchors.slice(0, ${links}).map((a) => ({ text: clean(a.textContent).slice(0, 120), href: String(a.href) })),
    counts: {
      links: anchors.length,
      forms: document.forms ? document.forms.length : 0,
      buttons: document.querySelectorAll('button').length,
      inputs: document.querySelectorAll('input').length
    },
    readyState: document.readyState,
    capturedAt: new Date().toISOString()
  });
})()`;
}

/**
 * Attach to a started profile and return page facts.
 *
 * `wsUrl` is optional: without it the debug port is resolved through
 * /json/version + /json/list, which is how a local profile is found.
 */
export async function capturePage({
  host = '127.0.0.1',
  port = null,
  wsUrl = null,
  url = null,
  timeoutMs = CDP_CAPTURE_TIMEOUT_MS,
  maxChars = 4000,
  maxLinks = 40,
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch
} = {}) {
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || CDP_CAPTURE_TIMEOUT_MS);
  const remaining = () => Math.max(1000, deadline - Date.now());

  let attachUrl = wsUrl || null;
  let browser = null;
  if (!attachUrl) {
    const target = await resolveDebugTarget({ host, port, fetchImpl, timeoutMs: Math.min(remaining(), CDP_HTTP_TIMEOUT_MS) });
    browser = target.browser;
    attachUrl = target.pageWsUrl;
    if (!attachUrl) {
      throw new BrowserActorError('cdp_error', 'The started profile exposed no page target to attach to', {
        details: { port, targetCount: target.targetCount, hasBrowserEndpoint: Boolean(target.browserWsUrl) }
      });
    }
  }

  const session = await CdpSession.open({ wsUrl: attachUrl, WebSocketImpl, timeoutMs: Math.min(remaining(), 10_000) });
  try {
    await session.send('Page.enable', {}, { timeoutMs: Math.min(remaining(), 10_000) });
    await session.send('Runtime.enable', {}, { timeoutMs: Math.min(remaining(), 10_000) });

    if (url) {
      // Do not await the load event before navigating: it can fire first.
      const loaded = session.waitFor('Page.loadEventFired', Math.min(remaining(), 20_000));
      await session.send('Page.navigate', { url }, { timeoutMs: Math.min(remaining(), 20_000) });
      // A page that never fires load (SPA, long-poll) must not fail the capture;
      // the evaluate below still reads whatever rendered.
      await loaded;
    }

    const evaluation = await session.send(
      'Runtime.evaluate',
      { expression: buildCaptureExpression(maxChars, maxLinks), returnByValue: true, awaitPromise: false },
      { timeoutMs: remaining() }
    );

    if (evaluation?.exceptionDetails) {
      throw new BrowserActorError('cdp_error', 'The page could not be read', {
        details: { reason: evaluation.exceptionDetails.text || 'evaluation_failed' }
      });
    }

    const raw = evaluation?.result?.value;
    const facts = typeof raw === 'string' ? safeParse(raw) : raw;
    if (!facts || typeof facts !== 'object') {
      throw new BrowserActorError('cdp_error', 'The page returned an empty snapshot', { details: { url } });
    }

    return { ok: true, browser, ...facts };
  } finally {
    session.close();
  }
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Screenshot the page the profile is showing (2026-10-31).
 *
 * Added for selector discovery: `capturePage` returns text, which is enough for a
 * report but not enough to know where a listing actually lives in the DOM. A PNG
 * plus the structural probe in scripts/browser_actor_inspect.mjs is how an adapter
 * gets written against the real page instead of an assumption.
 *
 * Returns base64 so the caller decides where it lands; this module keeps doing no
 * file IO.
 */
export async function captureScreenshot({
  host = '127.0.0.1',
  port = null,
  wsUrl = null,
  timeoutMs = CDP_CAPTURE_TIMEOUT_MS,
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  format = 'png',
  fullPage = true,
  quality = undefined
} = {}) {
  let attachUrl = wsUrl || null;
  if (!attachUrl) {
    const target = await resolveDebugTarget({ host, port, fetchImpl, timeoutMs: CDP_HTTP_TIMEOUT_MS });
    attachUrl = target.pageWsUrl;
    if (!attachUrl) {
      throw new BrowserActorError('cdp_error', 'The started profile exposed no page target to screenshot', {
        details: { port, targetCount: target.targetCount }
      });
    }
  }

  const session = await CdpSession.open({ wsUrl: attachUrl, WebSocketImpl, timeoutMs: Math.min(timeoutMs, 10_000) });
  try {
    await session.send('Page.enable', {}, { timeoutMs: 10_000 });
    const params = { format, captureBeyondViewport: fullPage };
    if (format === 'jpeg' && Number.isFinite(quality)) params.quality = quality;
    const result = await session.send('Page.captureScreenshot', params, { timeoutMs });
    if (!result?.data) {
      throw new BrowserActorError('cdp_error', 'The page produced no screenshot data');
    }
    return { format, data: result.data };
  } finally {
    session.close();
  }
}

