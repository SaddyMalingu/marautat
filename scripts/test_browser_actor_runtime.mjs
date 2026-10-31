#!/usr/bin/env node

/**
 * Browser Actor Runtime, verified without MoreLogin, a browser or a database
 * (2026-10-31).
 *
 * An agent that can drive a fingerprinted browser is only useful if four
 * properties hold, and every one of them fails silently otherwise:
 *
 *   1. One tenant maps to one profile — never a shared one, never a guess.
 *   2. One profile has one lease — two agents on one profile corrupt cookies.
 *   3. A started profile is reachable — `debugPort` arrives as a *string* and
 *      must become the attach point the agent uses.
 *   4. Nothing leaks — a Cloud cdpUrl and the Local API key are bearer
 *      credentials and must never appear in a response, a log or an error.
 *
 * The suite drives both transports (a fake `ml-cli` and a stub Local API), a
 * fake CDP socket, and the real Express router over real HTTP.
 *
 * Usage: npm run test:browser-actor
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import http from 'node:http';
import express from 'express';
import {
  BROWSER_ACTOR_CODES,
  BrowserActorError,
  normalizeTenantSlug,
  parseProfileMap,
  resolveIdentity,
  describeIdentity,
  maskEnvId,
  isValidEnvId,
  createSessionBroker,
  publicSession,
  createMoreloginClient,
  createBrowserRuntime,
  normalizeStartResult,
  parseJsonLoose,
  redact,
  capturePage,
  CdpSession,
  buildCaptureExpression
} from '../utils/browserActor/index.js';
import { normalizeTuringItem, normalizeTuringCollection, pickReferralUrl, toOfferDraft } from '../utils/browserActor/tasks/turing.js';
import { referralForRole, isReferralUrlForHost } from '../utils/browserActor/referrals.js';
import { offerSlugFor, planOfferImport, attachReferrals } from '../utils/browserActor/offersImport.js';
import {
  REFERRAL_PACE_MS,
  TURING_CLOSE_MODAL_EXPR,
  TURING_DETAIL_REFERRAL_EXPR,
  TURING_MODAL_CANDIDATES_EXPR,
  TURING_REFERRAL_HOST,
  hasReferralCandidate,
  jobIdFromUrl,
  normalizeReferralCapture,
  planReferralBackfill,
  referralCaptureHeadline,
  turingCardProbeExpr,
  turingOpenReferralExpr
} from '../utils/browserActor/tasks/turingReferrals.js';
import { sanitizeOfferPatch } from '../utils/offerPatch.js';
import { summarizeCoverage, coverageHeadline } from '../utils/coverage.js';
import { cliArgsFor, isBusinessFailure } from '../utils/browserActor/moreloginClient.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const eq = (name, actual, expected) => ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

async function expectCode(name, fn, code) {
  try {
    await fn();
    ok(name, false, `expected ${code}, resolved instead`);
  } catch (error) {
    ok(name, error instanceof BrowserActorError && error.code === code, `got ${error?.code || error?.message}`);
  }
}

const TENANT_ENV_ID = '1673823102599682';
// maskEnvId keeps the first two and last two characters of a 16-digit id.
const MASKED_ENV_ID = `16${'*'.repeat(12)}82`;

// ---------------------------------------------------------------------------
// 1. Identity: one tenant, one profile
// ---------------------------------------------------------------------------
console.log('\n-- identity --');

eq('tenant slugs normalise to the site_tenants convention', normalizeTenantSlug('  Acme  Kenya!! '), 'acme-kenya');
eq('an empty tenant is not a tenant', normalizeTenantSlug('   '), '');
ok('a decimal envId is valid', isValidEnvId(TENANT_ENV_ID));
ok('a float-looking envId is rejected', !isValidEnvId('1673823102599682.5'));
ok('a 64-bit envId keeps every digit', parseProfileMap(`{"acme":"${TENANT_ENV_ID}"}`).acme.envId === TENANT_ENV_ID);

const map = parseProfileMap(JSON.stringify({ acme: TENANT_ENV_ID, beta: { envId: '42', runtime: 'cloud', label: 'Beta GH' } }));
eq('the plain form defaults to the local runtime', map.acme.runtime, 'local');
eq('the object form keeps its runtime', map.beta.runtime, 'cloud');

await expectCode('a malformed map fails loudly, not as "no profiles"', () => parseProfileMap('{acme:'), BROWSER_ACTOR_CODES.NOT_CONFIGURED);

const mapped = resolveIdentity({ tenantSlug: 'acme', map });
eq('the env map wins over the table', mapped.source, 'env_map');
eq('the resolved profile keeps the full envId', mapped.envId, TENANT_ENV_ID);

const fromTable = resolveIdentity({
  tenantSlug: 'gamma',
  map,
  tableRows: [{ tenant_slug: 'gamma', env_id: '777', runtime: 'local', label: 'Gamma' }]
});
eq('an unmapped tenant falls back to the identities table', fromTable.source, 'table');
eq('the table row supplies the profile', fromTable.envId, '777');

const fromDefault = resolveIdentity({ tenantSlug: 'solo', map, defaultEnvId: '999' });
eq('a single-profile deployment can use a default', fromDefault.source, 'default');

await expectCode('an unknown tenant is unmapped, never shared', () => resolveIdentity({ tenantSlug: 'nobody', map }), BROWSER_ACTOR_CODES.PROFILE_UNMAPPED);
await expectCode(
  'a non-numeric envId is a config error',
  () => resolveIdentity({ tenantSlug: 'bad', map: { bad: { envId: 'env-abc' } } }),
  BROWSER_ACTOR_CODES.NOT_CONFIGURED
);
await expectCode('a blank tenant is rejected', () => resolveIdentity({ tenantSlug: '', map }), BROWSER_ACTOR_CODES.INVALID_REQUEST);

ok('a masked id keeps the ends and hides the middle', maskEnvId(TENANT_ENV_ID) === MASKED_ENV_ID, maskEnvId(TENANT_ENV_ID));
ok('the public profile shape carries no raw envId', !('envId' in describeIdentity(mapped)), JSON.stringify(describeIdentity(mapped)));


// ---------------------------------------------------------------------------
// 2. Leases: one profile, one agent
// ---------------------------------------------------------------------------
console.log('\n-- leases --');

let clock = 1_000_000;
const broker = createSessionBroker({ now: () => clock, ttlMs: 60_000 });
const identity = { tenantSlug: 'acme', envId: TENANT_ENV_ID, runtime: 'local', label: null };
const first = broker.acquire({ identity, actor: 'aboss-capture' });

ok('a new lease hands back a write token', typeof first.leaseToken === 'string' && first.leaseToken.length > 8);
ok('the default public shape hides the token', !('leaseToken' in publicSession(first)));
ok('the creator can ask for its token', publicSession(first, { includeToken: true }).leaseToken === first.leaseToken);

await expectCode('a second agent cannot take the same profile', () => broker.acquire({ identity, actor: 'second' }), BROWSER_ACTOR_CODES.PROFILE_BUSY);

const other = broker.acquire({ identity: { ...identity, tenantSlug: 'beta', envId: '42' }, actor: 'beta-agent' });
eq('a different profile is still free', other.envId, '42');

await expectCode('a stranger cannot heartbeat the lease', () => broker.heartbeat(first.id, 'not-the-token'), BROWSER_ACTOR_CODES.LEASE_CONFLICT);
await expectCode('a stranger cannot release the lease', () => broker.release(first.id, 'not-the-token'), BROWSER_ACTOR_CODES.LEASE_CONFLICT);
await expectCode('another tenant cannot read the lease', () => broker.get(first.id, { tenantSlug: 'beta' }), BROWSER_ACTOR_CODES.SESSION_NOT_FOUND);

broker.heartbeat(first.id, first.leaseToken, 120_000);
ok('a heartbeat extends the lease', broker.get(first.id).expiresAt > clock + 60_000);

clock += 130_000;
eq('an expired lease stops blocking the profile', broker.acquire({ identity, actor: 'later' }).tenantSlug, 'acme');
eq('sweeping reclaims nothing twice', broker.sweep().length, 0);

const releasable = broker.acquire({ identity: { ...identity, envId: '555' }, actor: 'x' });
broker.release(releasable.id, releasable.leaseToken);
ok('a released lease is gone', broker.list({ tenantSlug: 'acme' }).every((s) => s.sessionId !== releasable.id));

// ---------------------------------------------------------------------------
// 3. The CLI transport: argv, exit codes, redaction
// ---------------------------------------------------------------------------
console.log('\n-- ml-cli transport --');

const calls = [];
const fakeExec = async (file, args) => {
  calls.push({ file, args });
  if (args.includes('env') && args.includes('start')) {
    return { stdout: JSON.stringify({ code: 0, msg: null, data: { envId: TENANT_ENV_ID, debugPort: '9222', webdriver: 'C:/wd/chromedriver.exe' }, requestId: 'req-cli' }), stderr: '' };
  }
  if (args.includes('doctor')) {
    return { stdout: JSON.stringify({ code: 0, data: { status: 'ready' } }), stderr: '' };
  }
  return { stdout: JSON.stringify({ code: 0, data: { dataList: [], total: 0 } }), stderr: '' };
};

const cliClient = createMoreloginClient({ transport: 'cli', cliPath: 'ml-cli', apiKey: 'local-secret', env: {}, exec: fakeExec });
const cliRuntime = createBrowserRuntime({ client: cliClient });

const started = await cliRuntime.startProfile(TENANT_ENV_ID, { headless: true, cdpEvasion: true });
eq('a string debugPort becomes a number', started.debugPort, 9222);
eq('the start call returns a local runtime', started.runtime, 'local');
eq('the webdriver path survives normalisation', started.webdriver, 'C:/wd/chromedriver.exe');

const startArgs = calls[0].args;
ok('the CLI is told to fail on a business error', startArgs.includes('--fail-on-business-error'));
ok('the CLI gets an explicit start timeout', startArgs.includes('--timeout') && Number(startArgs[startArgs.indexOf('--timeout') + 1]) >= 30);
ok('headless is passed as the documented true|false string', startArgs.includes('--is-headless') && startArgs[startArgs.indexOf('--is-headless') + 1] === 'true');
ok('CDP evasion is on by default', startArgs[startArgs.indexOf('--cdp-evasion') + 1] === 'true');
ok('no --port is invented, so IPC discovery still works', !startArgs.includes('--port'));
ok('the api key is passed to the cli, not the URL', startArgs[startArgs.indexOf('--api-key') + 1] === 'local-secret');

const missingCli = createMoreloginClient({
  transport: 'cli',
  env: {},
  exec: async () => { const error = new Error('spawn ml-cli ENOENT'); error.code = 'ENOENT'; throw error; }
});
await expectCode('a missing ml-cli is a typed config failure', () => missingCli.runCli(['env', 'list'], {}), BROWSER_ACTOR_CODES.CLI_MISSING);

const businessFailure = createMoreloginClient({
  transport: 'cli',
  env: {},
  exec: async () => { const error = new Error('exit 1'); error.code = 1; error.stdout = JSON.stringify({ code: 19099, msg: 'profile locked' }); throw error; }
});
try {
  await businessFailure.runCli(['env', 'start'], {});
  ok('a non-zero business code is not success', false, 'resolved');
} catch (error) {
  eq('a business failure surfaces as provider_error', error.code, BROWSER_ACTOR_CODES.PROVIDER_ERROR);
  eq('the vendor code is preserved for support', error.details.providerCode, 19099);
}

const noisy = createMoreloginClient({
  transport: 'cli',
  env: {},
  exec: async () => ({ stdout: 'checking client...\n{"code":0,"data":{"status":"ready"}}\n', stderr: '' })
});
eq('progress output before the JSON is tolerated', (await noisy.runCli(['doctor'], {})).data.status, 'ready');
eq('a bare JSON body parses', parseJsonLoose('{"code":0}').code, 0);
eq('a body with no JSON is null', parseJsonLoose('not json'), null);
ok('an api key is redacted out of diagnostics', !redact('ml-cli --api-key abc123 --timeout 20').includes('abc123'));

await expectCode(
  'a start with no attach point fails instead of returning null',
  () => Promise.resolve(normalizeStartResult({ data: { envId: '1' } })),
  BROWSER_ACTOR_CODES.PROVIDER_ERROR
);

// Regressions found against a live client on 2026-10-31.
{
  const boolArgs = cliArgsFor({ port: null, apiKey: '' }, ['doctor'], { '--output-json': null }, 20);
  const idx = boolArgs.indexOf('--output-json');
  ok('a null flag value emits a value-less boolean flag', idx > -1, JSON.stringify(boolArgs));
  ok('a boolean flag does not consume the next token', idx === boolArgs.length - 1, JSON.stringify(boolArgs));
  ok('a non-enveloped body is not a business failure', isBusinessFailure({ ok: true, httpStatus: 200 }) === false);
  ok('an explicit non-zero code is still a business failure', isBusinessFailure({ code: 19099 }) === true);

  const probeCalls = [];
  const probeClient = createMoreloginClient({
    transport: 'cli',
    env: {},
    exec: async (file, args) => {
      probeCalls.push(args);
      return { stdout: JSON.stringify({ httpStatus: 200, ok: true, port: 40000, statusResponse: { status: 'ok' } }), stderr: '' };
    }
  });
  const probe = await createBrowserRuntime({ client: probeClient }).probe();
  ok('probe asks the cli for json output', probeCalls[0].includes('--output-json'), JSON.stringify(probeCalls[0]));
  eq('a doctor response without a code is reachable', probe.reachable, true);
  eq('probe reads the nested status', probe.detail, 'ok');
}


// ---------------------------------------------------------------------------
// 4. CDP: the agent has to actually read the page
// ---------------------------------------------------------------------------
console.log('\n-- cdp --');

const keepAlive = setInterval(() => {}, 2000);

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
    setTimeout(() => this.onopen && this.onopen(), 0);
  }
  deliver(payload) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
  }
  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.method === 'Page.navigate') {
      setTimeout(() => {
        this.deliver({ method: 'Page.loadEventFired', params: {} });
        this.deliver({ id: message.id, result: { frameId: 'F1' } });
      }, 0);
      return;
    }
    if (message.method === 'Runtime.evaluate') {
      const value = JSON.stringify({
        title: 'Tender Portal KE',
        url: 'https://tenders.example/ke',
        description: 'Public tenders',
        headings: ['Open tenders'],
        text: 'Supply of 200 laptops',
        links: [{ text: 'Apply', href: 'https://tenders.example/ke/1' }],
        counts: { links: 1, forms: 1, buttons: 2, inputs: 3 },
        readyState: 'complete',
        capturedAt: '2026-10-31T00:00:00.000Z'
      });
      setTimeout(() => this.deliver({ id: message.id, result: { result: { type: 'string', value } } }), 0);
      return;
    }
    setTimeout(() => this.deliver({ id: message.id, result: {} }), 0);
  }
  close() {
    this.closed = true;
    if (this.onclose) this.onclose();
  }
}

const cdpFetch = async (url) => {
  const target = String(url);
  if (target.endsWith('/json/version')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ Browser: 'Chrome/124', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/B1' }) };
  }
  if (target.endsWith('/json/list')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/P1' }]) };
  }
  throw new Error('unexpected url ' + target);
};

const captured = await capturePage({
  port: 9222,
  url: 'https://tenders.example/ke',
  WebSocketImpl: FakeSocket,
  fetchImpl: cdpFetch
});

eq('capture reads the page title through CDP', captured.title, 'Tender Portal KE');
eq('capture returns the text an agent qualifies on', captured.text, 'Supply of 200 laptops');
eq('capture returns structured link counts', captured.counts.links, 1);
eq('capture reports the browser it attached to', captured.browser, 'Chrome/124');

const lastSocket = FakeSocket.instances[FakeSocket.instances.length - 1];
const navigation = lastSocket.sent.find((m) => m.method === 'Page.navigate');
ok('capture navigates to the requested url', navigation && navigation.params.url === 'https://tenders.example/ke');
ok('capture attaches to the page target, not the browser target', lastSocket.url.endsWith('/devtools/page/P1'));
ok('capture closes the socket it opened', lastSocket.closed === true);
ok('the evaluate carries a bounded snapshot', buildCaptureExpression(500, 5).includes('slice(0, 500)'));

await expectCode(
  'a profile with no page target is a clear cdp error',
  () => capturePage({
    port: 9222,
    WebSocketImpl: FakeSocket,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      text: async () => String(url).endsWith('/json/version')
        ? JSON.stringify({ Browser: 'Chrome/124', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/B1' })
        : JSON.stringify([])
    })
  }),
  BROWSER_ACTOR_CODES.CDP_ERROR
);

class SilentSocket {
  constructor() { setTimeout(() => this.onopen && this.onopen(), 0); }
  send() {}
  close() { if (this.onclose) this.onclose(); }
}
const silent = await CdpSession.open({ wsUrl: 'ws://stub/devtools/page/1', WebSocketImpl: SilentSocket, timeoutMs: 1000 });
await expectCode('a CDP call that never answers times out', () => silent.send('Runtime.evaluate', {}, { timeoutMs: 60 }), BROWSER_ACTOR_CODES.CDP_TIMEOUT);
silent.close();

class RefusingSocket {
  constructor() { setTimeout(() => this.onerror && this.onerror({ message: 'connect EPERM 127.0.0.1:9222' }), 0); }
  send() {}
  close() {}
}
await expectCode(
  'a refused CDP connection is reported, not swallowed',
  () => CdpSession.open({ wsUrl: 'ws://stub/devtools/page/1', WebSocketImpl: RefusingSocket, timeoutMs: 1000 }),
  BROWSER_ACTOR_CODES.CDP_ERROR
);

// ---------------------------------------------------------------------------
// 5. The HTTP surface: auth, tenancy, leases, no token leakage
// ---------------------------------------------------------------------------
console.log('\n-- routes --');

const AGENT_KEY = 'test-agent-key-123';
const CLOUD_TOKEN = 'cdp-secret-token-do-not-leak';

/** A port that is definitely closed, so "capture" fails the way a real agent would see. */
function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
const closedPort = await freePort();

const providerState = { calls: [] };
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch {}
    providerState.calls.push({ path: req.url, body: json, auth: req.headers.authorization || null });
    const send = (payload) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    switch (req.url) {
      case '/api/env/page':
        return send({ code: 0, msg: null, data: { dataList: [{ envId: TENANT_ENV_ID, envName: 'acme-ke', groupName: 'tenants', proxyName: 'ke-mobile' }], total: 1 } });
      case '/api/env/start':
        return send({ code: 0, msg: null, data: { envId: json.envId, debugPort: String(closedPort), type: 'chrome', version: 1, webdriver: 'C:/ml/chromedriver.exe' }, requestId: 'req-start' });
      case '/api/env/close':
        return send({ code: 0, msg: null, data: null });
      case '/api/cloudbrowser/start':
        return send({ code: 0, msg: null, data: { cloudBrowserStatus: 'RUNNING' } });
      case '/api/cloudbrowser/connect':
        return send({ code: 0, msg: null, data: { cdpUrl: `https://runtime1.morelogin.com:16167?token=${CLOUD_TOKEN}` } });
      case '/api/cloudphone/page':
        return send({ code: 0, msg: null, data: { dataList: [{ id: '9001', name: 'android-ke-1', status: 'RUNNING' }], total: 1 } });
      default:
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end('{"code":404}');
    }
  });
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const providerPort = provider.address().port;

process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.MORELOGIN_TRANSPORT = 'http';
process.env.MORELOGIN_PORT = String(providerPort);
process.env.AGENT_API_KEY = AGENT_KEY;
process.env.BROWSER_ACTOR_PROFILES = JSON.stringify({
  acme: TENANT_ENV_ID,
  cloudco: { envId: '888', runtime: 'cloud', label: 'Cloud Co' }
});
delete process.env.BROWSER_ACTOR_DEFAULT_ENV_ID;

// Imported after the env is set: config resolves lazily, but the Supabase client
// is created at import time.
const { default: browserActorsRouter } = await import('../routes/browserActors.js');
const app = express();
app.use(express.json());
app.use('/api/agents/browser', browserActorsRouter);
const api = http.createServer(app);
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${api.address().port}/api/agents/browser`;

async function call(path, { method = 'GET', body = null, key = AGENT_KEY } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-agent-key'] = key;
  const res = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, text };
}

const anonymous = await call('/health', { key: null });
eq('no agent key is refused', anonymous.status, 401);
eq('a wrong agent key is refused', (await call('/health', { key: 'nope' })).status, 401);

const health = await call('/health');
eq('health answers', health.status, 200);
eq('health reports a reachable provider', health.body.provider.reachable, true);
eq('health reports the http transport', health.body.provider.transport, 'http');

const profiles = await call('/profiles');
eq('profiles lists the mapped tenant', profiles.status, 200);
ok('profiles never expose a raw envId', !profiles.text.includes(TENANT_ENV_ID), profiles.text.slice(0, 200));
ok('profiles keep a masked id for correlation', profiles.text.includes(MASKED_ENV_ID), profiles.text.slice(0, 200));

const created = await call('/sessions', { method: 'POST', body: { tenant: 'acme', purpose: 'tender-capture' } });
eq('a mapped tenant gets a session', created.status, 201);
eq('the session carries the attach port as a number', created.body.attach.port, closedPort);
ok('the session hands the owner a lease token', typeof created.body.session.leaseToken === 'string');
ok('the session does not echo the raw envId', !created.text.includes(TENANT_ENV_ID), created.text.slice(0, 300));
const sessionId = created.body.session.sessionId;
const leaseToken = created.body.session.leaseToken;

const busy = await call('/sessions', { method: 'POST', body: { tenant: 'acme' } });
eq('a second agent is told the profile is busy', busy.status, 409);
eq('the busy error is typed', busy.body.error, 'profile_busy');

const listed = await call('/sessions?tenant=acme');
eq('the active lease is listed', listed.body.sessions.length, 1);
ok('the list never hands out the lease token', !listed.text.includes(leaseToken));

const wrongToken = await call(`/sessions/${sessionId}`, { method: 'DELETE', body: { leaseToken: 'nope' } });
eq('a stranger cannot release the lease over http', wrongToken.status, 409);
eq('the lease conflict is typed', wrongToken.body.error, 'lease_conflict');

const released = await call(`/sessions/${sessionId}`, { method: 'DELETE', body: { leaseToken } });
eq('the owner releases the lease', released.status, 200);
eq('releasing closes the profile by default', released.body.profileClosed, true);
ok('closing the profile reached the provider', providerState.calls.some((c) => c.path === '/api/env/close'));

const unmapped = await call('/sessions', { method: 'POST', body: { tenant: 'stranger' } });
eq('an unmapped tenant is refused', unmapped.status, 409);
eq('the unmapped error tells the operator what to do', unmapped.body.error, 'profile_unmapped');

const badScheme = await call('/capture', { method: 'POST', body: { tenant: 'acme', url: 'file:///c:/secrets.txt' } });
eq('capture refuses a non-http url', badScheme.status, 400);
eq('the url rejection is typed', badScheme.body.error, 'invalid_request');

const captureFailed = await call('/capture', { method: 'POST', body: { tenant: 'acme', url: 'https://tenders.example/ke' } });
eq('capture reports an unreachable browser as a cdp error', captureFailed.status, 502);
eq('the capture error is typed', captureFailed.body.error, 'cdp_error');
eq('a failed capture still returns the lease', (await call('/sessions?tenant=acme')).body.sessions.length, 0);

const cloud = await call('/sessions', { method: 'POST', body: { tenant: 'cloudco' } });
eq('a cloud tenant gets a session', cloud.status, 201);
eq('the cloud runtime is reported', cloud.body.provider.runtime, 'cloud');
ok('the creator receives the cloud attach url', cloud.text.includes(CLOUD_TOKEN));
const cloudList = await call('/sessions?tenant=cloudco');
ok('the list never exposes the cloud cdp token', !cloudList.text.includes(CLOUD_TOKEN), cloudList.text.slice(0, 300));
await call(`/sessions/${cloud.body.session.sessionId}`, { method: 'DELETE', body: { leaseToken: cloud.body.session.leaseToken } });

const phones = await call('/phones');
eq('phones list the cloud phone inventory', phones.status, 200);
eq('a phone keeps its string id', phones.body.items[0].id, '9001');

const phoneOpen = await call('/phones/open', { method: 'POST', body: { id: '9001' } });
eq('opening a phone over http is refused, not faked', phoneOpen.status, 501);
eq('the refusal is typed', phoneOpen.body.error, 'unsupported_transport');

// ---------------------------------------------------------------------------
// 6. Turing adapter: parsing pinned to the live page's real strings
// ---------------------------------------------------------------------------
console.log('\n-- turing adapter --');

// These are the exact values the live profile produced on 2026-10-31.
const liveCard = {
  metaText: 'Priority $750',
  titleText: 'Project Lead - AI Training',
  summaryText: 'Lead large-scale AI annotation projects while managing clients and teams.'
};

{
  const item = normalizeTuringItem(liveCard);
  eq('a live card yields its title', item.title, 'Project Lead - AI Training');
  eq('a live card yields its rate', item.rate, '$750');
  eq('a live card is flagged priority', item.priority, true);
  eq('a live card keeps its summary verbatim', item.summary, liveCard.summaryText);
  eq('the id is a stable slug of the title', item.externalId, 'turing:project-lead-ai-training');
  ok('the id is not the page url', item.externalId !== item.url);
  eq('the card points at the listing because it has no href', item.url, 'https://work.turing.com/jobs');
}
{
  const noPriority = normalizeTuringItem({ metaText: '$100', titleText: 'Business Analyst - US' });
  eq('a card without the priority badge is not priority', noPriority.priority, false);
  eq('a plain rate is still parsed', noPriority.rate, '$100');
}
{
  const hourly = normalizeTuringItem({ metaText: 'Priority $100-150/hr', titleText: 'Senior Software Engineer' });
  eq('an hourly range survives parsing', hourly.rate, '$100-150/hr');
}
{
  const enDash = normalizeTuringItem({ metaText: 'Priority $200', titleText: 'Medical Expert \u2013 Dermatology' });
  eq('an en dash in a title still slugs cleanly', enDash.externalId, 'turing:medical-expert-dermatology');
}
eq('a card with no title is dropped', normalizeTuringItem({ metaText: 'Priority $750' }), null);

{
  const twice = normalizeTuringCollection({
    ok: true,
    url: 'https://work.turing.com/jobs',
    totals: { all: 231, priority: 12, newest: 29 },
    items: [liveCard, liveCard, { metaText: '$100', titleText: 'Business Analyst - US' }, { metaText: 'x' }]
  });
  eq('a duplicate role is counted once', twice.count, 2);
  eq('totals pass through untouched', twice.totals.all, 231);
  ok('a failed read is not reported as success', normalizeTuringCollection({ ok: false }).ok === false);
}

// ---------------------------------------------------------------------------
// 7. Refer-and-earn: the tenant's link is the CTA, so picking it must be safe
// ---------------------------------------------------------------------------
console.log('\n-- referral link --');

{
  const picked = pickReferralUrl([
    'https://work.turing.com/dashboard',
    'https://work.turing.com/jobs',
    'https://www.turing.com/referral?ref=SADDY123'
  ]);
  eq('the referral link beats dashboard and jobs', picked, 'https://www.turing.com/referral?ref=SADDY123');

  eq('a bare ?ref= link still wins', pickReferralUrl(['https://turing.com/jobs', 'https://turing.com/x?ref=abc']), 'https://turing.com/x?ref=abc');
  eq('an invite path wins', pickReferralUrl(['https://turing.com/jobs', 'https://turing.com/invite/abcd']), 'https://turing.com/invite/abcd');
  eq('another domain is never chosen', pickReferralUrl(['https://evil.example.com/?ref=x']), null);
  eq('no candidates means no link, not a guess', pickReferralUrl([]), null);
  eq('only navigation urls means no link', pickReferralUrl(['https://work.turing.com/jobs', 'https://work.turing.com/dashboard']), null);
}

{
  const draft = toOfferDraft(
    {
      externalId: 'turing:project-lead-ai-training',
      title: 'Project Lead - AI Training',
      rate: '$750',
      priority: true,
      summary: 'Lead large-scale AI annotation projects while managing clients and teams.'
    },
    { referralUrl: 'https://www.turing.com/referral?ref=SADDY123', tenantSlug: 'writers-flow' }
  );
  eq('an offer keeps the role title', draft.title, 'Project Lead - AI Training');
  eq('an offer is a job, so the existing career copy applies', draft.offer_type, 'job');
  eq('an offer starts as a draft, never published', draft.status, 'draft');
  eq('the rate becomes compensation_max', draft.compensation_max, 750);
  eq('compensation is USD, as the marketplace pays', draft.compensation_currency, 'USD');
  eq('the CTA is the tenant referral link', draft.referral_url, 'https://www.turing.com/referral?ref=SADDY123');
  eq('the slug comes from the external id', draft.slug, 'project-lead-ai-training');
  eq('the offer is tenant-scoped', draft.tenant_slug, 'writers-flow');
  eq('a role without a title makes no offer', toOfferDraft({ rate: '$750' }, { tenantSlug: 'malingu-ventures' }), null);
  eq('a role without a referral link keeps it null rather than inventing one',
    toOfferDraft({ title: 'X' }, { tenantSlug: 'malingu-ventures' }).referral_url, null);

  // The live session belongs to one tenant. An offer that loses its tenant either
  // vanishes from their portal or surfaces in someone else's — refuse, never guess.
  let refused = false;
  try {
    toOfferDraft({ title: 'Project Lead - AI Training', rate: '$750' });
  } catch (error) {
    refused = /tenant slug/i.test(String(error && error.message));
  }
  ok('an offer without a tenant is refused, not defaulted', refused);

  const scoped = toOfferDraft({ title: 'Project Lead - AI Training' }, { tenantSlug: 'malingu-ventures' });
  eq('the live identity maps to the right tenant', scoped.tenant_slug, 'malingu-ventures');
}

// ---------------------------------------------------------------------------
// 8. A referral link belongs to ONE OFFER, never to a tenant or a platform
// ---------------------------------------------------------------------------
console.log('\n-- per-offer referral link --');

{
  // Two Turing roles, each with its OWN link. Picking "the newest Turing link"
  // would put role A's link on role B's page — the tenant gets paid for the wrong
  // job and the candidate lands on a page that does not match.
  const offersOfTenant = [
    { id: 'o1', external_id: 'turing:project-lead-ai-training', title: 'Project Lead - AI Training',
      referral_url: 'https://www.turing.com/referral?ref=MV-LEAD' },
    { id: 'o2', external_id: 'turing:business-analyst-us', title: 'Business Analyst - US',
      referral_url: 'https://www.turing.com/referral?ref=MV-BA' },
    { id: 'o3', external_id: 'micro1:writer', title: 'Writer',
      referral_url: 'https://refer.micro1.ai/?ref=MV-MICRO' }
  ];

  const lead = referralForRole(offersOfTenant, { externalId: 'turing:project-lead-ai-training', host: 'turing.com' });
  const analyst = referralForRole(offersOfTenant, { externalId: 'turing:business-analyst-us', host: 'turing.com' });
  eq('the lead role gets its own link', lead.referralUrl, 'https://www.turing.com/referral?ref=MV-LEAD');
  eq('a different role gets a different link', analyst.referralUrl, 'https://www.turing.com/referral?ref=MV-BA');
  ok('two roles never share a link', lead.referralUrl !== analyst.referralUrl);
  eq('the match reports how it was made', lead.matchedBy, 'external_id');
  eq('the match names the offer row', lead.offerId, 'o1');

  eq('an unknown role gets no link, not a neighbour\u2019s',
    referralForRole(offersOfTenant, { externalId: 'turing:brand-new-role', host: 'turing.com' }).matchedBy, null);
  eq('and no url either',
    referralForRole(offersOfTenant, { externalId: 'turing:brand-new-role', host: 'turing.com' }).referralUrl, null);

  // Offers created before the adapter existed have a title but no external id.
  const legacy = [{ id: 'o9', title: 'Project Lead - AI Training', referral_url: 'https://www.turing.com/referral?ref=MV-LEGACY' }];
  eq('a legacy offer matches by title', referralForRole(legacy, { title: 'Project Lead  -  AI Training', host: 'turing.com' }).matchedBy, 'title');
  eq('a legacy match still returns its link', referralForRole(legacy, { title: 'Project Lead - AI Training', host: 'turing.com' }).referralUrl, 'https://www.turing.com/referral?ref=MV-LEGACY');

  // Cross-platform safety: a Micro1 link can never answer for a Turing role.
  eq('a Micro1 link is never used for a Turing role',
    referralForRole(
      [{ id: 'x', external_id: 'turing:x', referral_url: 'https://refer.micro1.ai/?ref=MV' }],
      { externalId: 'turing:x', host: 'turing.com' }
    ).referralUrl, null);

  ok('a subdomain counts as the same platform', isReferralUrlForHost('https://work.turing.com/r/abc', 'turing.com'));
  ok('a lookalike domain does not count', isReferralUrlForHost('https://notturing.com.evil.example/x', 'turing.com') === false);
  ok('a junk string does not count', isReferralUrlForHost('not a url', 'turing.com') === false);
  eq('an empty history means no link', referralForRole([], { externalId: 'turing:x', host: 'turing.com' }).referralUrl, null);

  // End to end: the role's own link becomes that offer's CTA.
  const draft = toOfferDraft(
    { externalId: 'turing:business-analyst-us', title: 'Business Analyst - US', rate: '$100' },
    { referralUrl: analyst.referralUrl, tenantSlug: 'malingu-ventures' }
  );
  eq('the role\u2019s own link lands on its offer as the CTA', draft.referral_url, 'https://www.turing.com/referral?ref=MV-BA');
}



// ---------------------------------------------------------------------------
// 9. Import planning: idempotent, tenant-scoped, never overwrites a link
// ---------------------------------------------------------------------------
console.log('\n-- offer import --');

{
  const role = { title: 'Project Lead - AI Training', rate: '$750', summary: 'Lead AI annotation projects.' };

  const a = offerSlugFor({ tenantSlug: 'malingu-ventures', sourceSlug: 'turing', title: role.title });
  const b = offerSlugFor({ tenantSlug: 'malingu-ventures', sourceSlug: 'turing', title: role.title });
  const otherTenant = offerSlugFor({ tenantSlug: 'another-tenant', sourceSlug: 'turing', title: role.title });
  eq('the slug is deterministic', a, b);
  eq('the slug encodes the tenant', a, 'malingu-ventures-turing-project-lead-ai-training');
  ok('two tenants never fight over one globally-unique slug', a !== otherTenant);

  const plan = planOfferImport({
    items: [role, { title: 'Business Analyst - US', rate: '$100' }],
    existingOffers: [],
    tenantSlug: 'malingu-ventures',
    tenantId: 'site-1',
    sourceSlug: 'turing'
  });
  eq('both roles are planned', plan.create.length, 2);
  eq('an imported offer is a draft', plan.create[0].status, 'draft');
  eq('an imported offer is scoped to the tenant', plan.create[0].tenant_id, 'site-1');
  ok('the row carries only real opportunity columns',
    'external_id' in plan.create[0] && !('source_slug' in plan.create[0]),
    Object.keys(plan.create[0]).join(','));
  eq('the role id is stored so a link can be matched exactly', plan.create[0].external_id, null);
  eq('the rate becomes compensation_max', plan.create[0].compensation_max, 750);
  eq('a fresh import has no referral link yet', plan.create[0].referral_url, null);
  eq('the missing links are reported for the tenant', plan.needsReferral.length, 2);

  // Re-running must create nothing: that is what protects a tenant's link.
  const rerun = planOfferImport({
    items: [role],
    existingOffers: plan.create,
    tenantSlug: 'malingu-ventures',
    tenantId: 'site-1',
    sourceSlug: 'turing'
  });
  eq('a second run creates nothing', rerun.create.length, 0);
  eq('and says why', rerun.skipped[0].reason, 'exists');

  // An offer the tenant made by hand under a different slug still counts.
  const manual = planOfferImport({
    items: [role],
    existingOffers: [{ slug: 'my-own-slug', title: 'Project Lead  -  AI Training', referral_url: 'https://www.turing.com/referral?ref=KEEP' }],
    tenantSlug: 'malingu-ventures',
    tenantId: 'site-1',
    sourceSlug: 'turing'
  });
  eq('a hand-made offer is not duplicated', manual.create.length, 0);
  eq('the reason names the title match', manual.skipped[0].reason, 'exists_by_title');

  // The planner has no update path at all, which is how a link survives.
  ok('the plan never emits an update for an existing row',
    planOfferImport({ items: [role], existingOffers: plan.create, tenantSlug: 'malingu-ventures', tenantId: 'site-1' }).create.length === 0);

  const batch = planOfferImport({
    items: [role, role, { title: '' }],
    tenantSlug: 'malingu-ventures',
    tenantId: 'site-1',
    sourceSlug: 'turing'
  });
  eq('a duplicate inside one batch is created once', batch.create.length, 1);
  eq('a role with no title is skipped', batch.skipped.filter((s) => s.reason === 'no_title').length, 1);

  let refusedTenant = false;
  try { planOfferImport({ items: [role], tenantSlug: '', tenantId: 'site-1' }); }
  catch (error) { refusedTenant = /tenant slug/i.test(String(error.message)); }
  ok('planning without a tenant is refused', refusedTenant);

  let refusedId = false;
  try { planOfferImport({ items: [role], tenantSlug: 'malingu-ventures', tenantId: '' }); }
  catch (error) { refusedId = /tenant id/i.test(String(error.message)); }
  ok('planning without a tenant id is refused', refusedId);

  // Referrals are attached per role, never borrowed from a neighbour.
  const history = [
    { title: 'Project Lead - AI Training', referral_url: 'https://www.turing.com/referral?ref=LEAD' },
    { title: 'Business Analyst - US', referral_url: 'https://www.turing.com/referral?ref=BA' }
  ];
  const linked = attachReferrals(plan, { existingOffers: history, referralForRole, host: 'turing.com' });
  eq('the lead keeps its own link', linked.create[0].referral_url, 'https://www.turing.com/referral?ref=LEAD');
  eq('the analyst keeps its own link', linked.create[1].referral_url, 'https://www.turing.com/referral?ref=BA');
  ok('two roles still never share a link', linked.create[0].referral_url !== linked.create[1].referral_url);

  const partial = attachReferrals(
    planOfferImport({ items: [role, { title: 'Brand New Role' }], tenantSlug: 'malingu-ventures', tenantId: 'site-1', sourceSlug: 'turing' }),
    { existingOffers: history, referralForRole, host: 'turing.com' }
  );
  eq('a role with no history stays unlinked', partial.create[1].referral_url, null);
  eq('and is reported so the tenant can paste it', partial.needsReferral.join(','), 'Brand New Role');
}

// ---------------------------------------------------------------------------
// 10. Offer patch allowlist: a tenant can set a link, never a slug or status
// ---------------------------------------------------------------------------
console.log('\n-- offer patch --');

{
  const lead = sanitizeOfferPatch({ referral_url: 'https://www.turing.com/referral?ref=MV-LEAD' });
  eq('a referral link is patchable', lead.patch.referral_url, 'https://www.turing.com/referral?ref=MV-LEAD');
  eq('a clean patch has no errors', lead.errors.length, 0);

  const clears = sanitizeOfferPatch({ referral_url: '' });
  eq('a blank link clears rather than storing an empty string', clears.patch.referral_url, null);

  const locked = sanitizeOfferPatch({ slug: 'hijack', status: 'published', tenant_id: 'other', id: 'x',
    referral_url: 'https://turing.com/r/a' });
  ok('slug is never patchable', !('slug' in locked.patch) && locked.ignored.includes('slug'));
  ok('status is never patchable through edit', !('status' in locked.patch) && locked.ignored.includes('status'));
  ok('tenant_id is never patchable', !('tenant_id' in locked.patch));
  eq('the referral link still lands alongside the ignored fields', locked.patch.referral_url, 'https://turing.com/r/a');

  eq('a javascript: url is refused', sanitizeOfferPatch({ referral_url: 'javascript:alert(1)' }).errors.length, 1);
  eq('a non-http destination is refused', sanitizeOfferPatch({ destination_url: 'ftp://x/y' }).errors.length, 1);

  const money = sanitizeOfferPatch({ compensation_max: '750' });
  eq('a numeric string becomes a number', money.patch.compensation_max, 750);
  eq('a negative amount is refused', sanitizeOfferPatch({ compensation_max: -5 }).errors.length, 1);

  eq('an unknown offer_type is refused', sanitizeOfferPatch({ offer_type: 'scam' }).errors.length, 1);
  eq('a known offer_type is accepted', sanitizeOfferPatch({ offer_type: 'Job' }).patch.offer_type, 'job');
  eq('an empty title is refused', sanitizeOfferPatch({ title: '   ' }).errors.length, 1);
  eq('an empty body says so instead of silently succeeding', sanitizeOfferPatch({}).errors[0], 'nothing to update');
}

// ---------------------------------------------------------------------------
// 11. Coverage: what the tenant captured, and what still earns nothing
// ---------------------------------------------------------------------------
console.log('\n-- coverage --');

{
  const rows = [
    { status: 'draft', referral_url: null, source: { slug: 'turing', name: 'Turing' } },
    { status: 'draft', referral_url: 'https://turing.com/r/a', source: { slug: 'turing', name: 'Turing' } },
    { status: 'published', referral_url: 'https://turing.com/r/b', source: { slug: 'turing', name: 'Turing' } },
    { status: 'draft', referral_url: null, source: { slug: 'micro1', name: 'Micro1' } },
    { status: 'draft', referral_url: null, source: null }
  ];
  const summary = summarizeCoverage(rows);
  eq('coverage counts every offer', summary.total, 5);
  eq('published is counted separately', summary.published, 1);
  eq('drafts are the rest', summary.drafts, 4);
  eq('offers with no referral link are surfaced', summary.missingReferral, 3);
  eq('offers are grouped by marketplace', summary.sources.length, 3);
  eq('the biggest marketplace comes first', summary.sources[0].slug, 'turing');
  eq('per-marketplace missing links are counted', summary.sources[0].missingReferral, 1);
  ok('an offer with no source is not silently dropped', summary.sources.some((s) => s.slug === 'unsourced'));
  const fallback = summarizeCoverage([{ status: 'draft', referral_url: null, slug: 'malingu-ventures-turing-illustrator' }]);
  eq('a missing source row falls back to the slug convention', fallback.sources[0].slug, 'turing');
  eq('and carries a readable name', fallback.sources[0].name, 'Turing');
  eq('an empty tenant reports zero', summarizeCoverage([]).total, 0);
  ok('the headline names the marketplace', coverageHeadline(summary).includes('Turing'));
  eq('an empty tenant gets a useful headline', coverageHeadline({ total: 0 }), 'No marketplace roles captured yet.');
}

// ---------------------------------------------------------------------------
// Per-role referral capture (Turing mints one link per JOB, not per account)
// ---------------------------------------------------------------------------
{
  const probe = turingCardProbeExpr(3);
  ok('the card probe is a page expression, not a driver call', typeof probe === 'string' && probe.includes('location.href'));
  ok('the card probe scopes to the listing container', probe.includes('div.grid.gap-6.grid-cols-1'));
  ok('the card probe clicks nothing', !probe.includes('.click()'));

  const open = turingOpenReferralExpr(0);
  ok('opening a role climbs the documented routes', open.includes('referral') && open.includes('details') && open.includes('amount'));
  ok('the modal reader prefers the dialog over the whole document',
    TURING_MODAL_CANDIDATES_EXPR.includes('[role="dialog"]') && TURING_MODAL_CANDIDATES_EXPR.includes('inDialog'));
  ok('closing is attempted before the next card', TURING_CLOSE_MODAL_EXPR.includes('Escape'));

  // The id must match what the importer wrote, or the link lands on nothing.
  const capture = normalizeReferralCapture({
    index: 0,
    title: 'Project Lead - AI Training',
    candidates: [
      'https://work.turing.com/dashboard/job_referral',
      'https://work.turing.com/jobs?ref=6f0c',
      'https://evil.example.com/?ref=6f0c'
    ]
  });
  eq('the captured id is the importer id', capture.externalId, 'turing:project-lead-ai-training');
  eq('the per-job link wins over the dashboard', capture.referralUrl, 'https://work.turing.com/jobs?ref=6f0c');
  eq('a pick is reported as picked', capture.reason, 'picked');

  const dashboardOnly = normalizeReferralCapture({
    title: 'Data Annotator',
    candidates: ['https://work.turing.com/dashboard/job_referral']
  });
  eq('a dashboard link is never accepted as a referral', dashboardOnly.referralUrl, null);
  eq('and the reason says so', dashboardOnly.reason, 'no_confident_pick');

  const otherHost = normalizeReferralCapture({
    title: 'Data Annotator',
    candidates: ['https://micro1.ai/r/ABC123']
  });
  eq('another marketplace\'s link is refused', otherHost.referralUrl, null);

  const empty = normalizeReferralCapture({ title: 'Data Annotator', candidates: [] });
  eq('an unreadable modal is admitted, not guessed', empty.reason, 'no_candidates');

  const offers = [
    { id: 'o1', title: 'Project Lead - AI Training', external_id: 'turing:project-lead-ai-training', referral_url: null },
    { id: 'o2', title: 'Business Analyst - US', external_id: 'turing:business-analyst-us', referral_url: null },
    { id: 'o3', title: 'Medical Expert', external_id: 'turing:medical-expert', referral_url: 'https://work.turing.com/jobs?ref=KEPT' }
  ];

  const planned = planReferralBackfill({
    offers,
    captures: [
      capture,
      normalizeReferralCapture({ title: 'Business Analyst - US', candidates: ['https://work.turing.com/jobs?ref=BA99'] }),
      normalizeReferralCapture({ title: 'Medical Expert', candidates: ['https://work.turing.com/jobs?ref=NEW'] }),
      normalizeReferralCapture({ title: 'Role We Never Imported', candidates: ['https://work.turing.com/jobs?ref=GHOST'] }),
      normalizeReferralCapture({ title: 'Business Analyst - US', candidates: ['https://work.turing.com/jobs?ref=DUP'] })
    ]
  });

  eq('only unlinked offers are updated', planned.updates.length, 2);
  eq('the link goes to the offer that created it', planned.updates[0].id, 'o1');
  ok('an offer that already has a link is a conflict, not an overwrite',
    planned.conflicts.some((row) => row.id === 'o3' && row.existing === 'https://work.turing.com/jobs?ref=KEPT'));
  ok('a role with no offer writes nothing', planned.skipped.some((row) => row.reason === 'offer_not_found'));
  ok('one link cannot be attached twice',
    planned.conflicts.some((row) => ['already_has_a_different_link', 'duplicate_link', 'offer_already_assigned'].includes(row.reason)));
  eq('an offer captured twice is queued once', planned.updates.filter((row) => row.id === 'o2').length, 1);

  const same = planReferralBackfill({ offers, captures: [
    normalizeReferralCapture({ title: 'Medical Expert', candidates: ['https://work.turing.com/jobs?ref=KEPT'] })
  ] });
  eq('re-capturing the same link is not a write', same.updates.length, 0);
  ok('and it is reported as already linked', same.skipped.some((row) => row.reason === 'already_linked'));

  const two = planReferralBackfill({
    offers: [
      { id: 'a', title: 'One', external_id: 'turing:one', referral_url: null },
      { id: 'b', title: 'Two', external_id: 'turing:two', referral_url: null }
    ],
    captures: [
      normalizeReferralCapture({ title: 'One', candidates: ['https://work.turing.com/jobs?ref=SAME'] }),
      normalizeReferralCapture({ title: 'Two', candidates: ['https://work.turing.com/jobs?ref=SAME'] })
    ]
  });
  eq('the same link on two roles is a bug, not data', two.updates.length, 1);
  ok('and the second is surfaced as a duplicate', two.conflicts.some((row) => row.reason === 'duplicate_link'));

  ok('the headline is readable', referralCaptureHeadline(planned).startsWith('2 links ready'));
  eq('an empty plan still explains itself', referralCaptureHeadline({}), '0 links ready');

  // Verified live 2026-10-31: a card click navigates to a job detail page.
  eq('the real job id is read off the detail url', jobIdFromUrl('https://work.turing.com/jobs?jobId=112467'), '112467');
  eq('the plain listing has no job id', jobIdFromUrl('https://work.turing.com/jobs'), null);
  eq('a junk url is not a job id', jobIdFromUrl('not a url'), null);
  ok('the detail expression excludes the Refer & Earn nav link',
    TURING_DETAIL_REFERRAL_EXPR.includes('isNavReferEarn') && TURING_DETAIL_REFERRAL_EXPR.includes('referral\\s*bonus'));
  // Live DOM (jobId=112467): "Referral Bonus · $750" is a span LABEL; the clickable
  // is <button>Share & earn $750</button>. Matching only "referral bonus" found
  // nothing on a page that plainly offers a referral.
  ok('the detail expression clicks the control that actually exists',
    TURING_DETAIL_REFERRAL_EXPR.includes('share') && TURING_DETAIL_REFERRAL_EXPR.includes("by: 'share_and_earn'"));
  ok('the card expression reports which affordance it clicked',
    turingOpenReferralExpr(0).includes("by: 'referral_link'"));

  const evidential = normalizeReferralCapture({
    title: 'Project Lead - AI Training',
    pageUrl: 'https://work.turing.com/jobs?jobId=112467',
    candidates: ['https://work.turing.com/jobs?jobId=112467'],
    clickedBy: 'amount',
    modalText: 'Explore roles',
    buttons: ['Apply Now']
  });
  eq('a capture carries the job id', evidential.jobId, '112467');
  eq('a capture carries what was clicked', evidential.clickedBy, 'amount');
  ok('a capture always keeps the page text as evidence', evidential.modalText === 'Explore roles');
  ok('a capture always keeps the card buttons', evidential.buttons.length === 1);

  // Live shape, verified from the share dialog's readonly input:
  //   https://work.turing.com/r/xako-8LrQK   (jobId=112467)
  const liveLink = 'https://work.turing.com/r/xako-8LrQK';
  ok('the live per-role link shape is recognised', hasReferralCandidate([liveLink]));
  ok('a dialog that is merely open is not enough', !hasReferralCandidate([]));
  ok('the referral dashboard is not a per-role link',
    !hasReferralCandidate(['https://work.turing.com/dashboard/job_referral']));
  const liveCapture = normalizeReferralCapture({ title: 'Project Lead - AI Training', candidates: [liveLink] });
  eq('the live link is picked, not rejected', liveCapture.referralUrl, liveLink);
  eq('and it reports a confident pick', liveCapture.reason, 'picked');

  // Two roles must never collapse to one link: that is the whole per-role premise.
  const perRole = planReferralBackfill({
    offers: [
      { id: 'r1', title: 'Project Lead - AI Training', external_id: 'turing:project-lead-ai-training', referral_url: null },
      { id: 'r2', title: 'Business Analyst - US', external_id: 'turing:business-analyst-us', referral_url: null }
    ],
    captures: [
      normalizeReferralCapture({ title: 'Project Lead - AI Training', candidates: [liveLink] }),
      normalizeReferralCapture({ title: 'Business Analyst - US', candidates: ['https://work.turing.com/r/Qm3t-Zp8W'] })
    ]
  });
  eq('each role gets its own link', perRole.updates.length, 2);
  ok('the two links are different',
    perRole.updates[0].referral_url !== perRole.updates[1].referral_url);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
clearInterval(keepAlive);
await new Promise((resolve) => api.close(resolve));
await new Promise((resolve) => provider.close(resolve));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
