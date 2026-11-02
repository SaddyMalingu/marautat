#!/usr/bin/env node

/**
 * Tenant-owned browser access, verified without MoreLogin (2026-11-02).
 *
 * The BYO flow has one job: let a tenant hand over a *key* without ever handing over a
 * password, and without the key becoming readable from outside. So the tests are about
 * three properties, each of which fails silently otherwise:
 *
 *   1. **The key is sealed, and a seal that will not open is unusable** — never "no key",
 *      and never a reason to keep running with a stale one.
 *   2. **No response carries the key**, its ciphertext, or its fingerprint.
 *   3. **A profile can only be bound by the key that owns it**, and a login wall is written
 *      down as `reauthRequired` instead of quietly producing an empty run.
 *
 * Usage: npm run test:browser-access
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  ACCESS_KEY_ENV,
  ACCESS_KEY_PREVIOUS_ENV,
  accessSecrets,
  clearAccess,
  fingerprintSecret,
  openSecret,
  openSecretFromEnv,
  publicAccessStatus,
  readAccess,
  resolveAccessIdentity,
  sealSecret,
  sealSecretWithEnv,
  secretsConfigured,
  writeAccess
} from '../utils/tenantAccess.js';
import { classifySignedIn, summarizeSignedIn, signedInProbeFor } from '../utils/browserActor/signedIn.js';
import { createBrowserAccessRouter } from '../routes/browserAccess.js';
import { createAgentRunsRouter } from '../routes/agentRuns.js';
import {
  createAgentToken,
  bearerTokenFromHeader,
  tokenMatchesHash,
  describeAgentToken
} from '../utils/browserActor/agentTokens.js';
import { resolveRunnerIdentity } from '../utils/tenantRunnerIdentity.js';
import { buildWorkerBundle } from '../utils/browserActor/workerBundle.js';
import { buildZipStore, listZipEntries } from '../utils/zipStore.js';
import { sanitizeAgentCaptures } from '../routes/agentRuns.js';
import { applyCaptures } from '../utils/browserActor/applyCaptures.js';

let pass = 0;
let fail = 0;
function ok(name, condition) {
  if (condition) { pass += 1; console.log(`PASS  ${name}`); } else { fail += 1; console.log(`FAIL  ${name}`); }
}
function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) console.log(`      got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  ok(name, same);
}

const SECRET = 'test-sealing-key-not-a-real-one';
const KEY = 'ml-api-key-2f8a1c';

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

const sealed = sealSecret(KEY, SECRET);
ok('a key seals into a versioned blob', /^v1\./.test(sealed));
ok('the ciphertext does not contain the key', !sealed.includes(KEY));
eq('and it opens again', openSecret(sealed, SECRET), KEY);
eq('a different secret cannot open it', openSecret(sealed, 'another-secret'), null);
const tampered = `${sealed.slice(0, -4)}AAAA`;
eq('a tampered seal opens to nothing', openSecret(tampered, SECRET), null);
eq('a malformed seal opens to nothing', openSecret('not-a-seal', SECRET), null);

let threw = false;
try { sealSecret(KEY, ''); } catch { threw = true; }
ok('sealing without a server secret refuses rather than storing plaintext', threw);

ok('the fingerprint is stable', fingerprintSecret(KEY) === fingerprintSecret(KEY));
ok('the fingerprint is not the key', !fingerprintSecret(KEY).includes(KEY));
// ---------------------------------------------------------------------------
// The stored record
// ---------------------------------------------------------------------------

const connectedMetadata = writeAccess({ voice: 'warm-direct' }, {
  envId: '2116562908359495680',
  runtime: 'cloud',
  label: 'Acme Studio',
  keySealed: sealed,
  keyFingerprint: fingerprintSecret(KEY),
  connectedAt: '2026-11-02T10:00:00.000Z',
  verifiedAt: null,
  verifiedPlatforms: [],
  reauthRequired: false,
  reauthPlatforms: [],
  lastCheckedAt: null
});

eq('writing access leaves other settings alone', connectedMetadata.voice, 'warm-direct');
eq('the record is readable back', readAccess(connectedMetadata).envId, '2116562908359495680');
eq('an empty record reads as null', readAccess({ voice: 'x' }), null);
eq('a record without an envId reads as null', readAccess({ browserAccess: { keySealed: sealed } }), null);

const status = publicAccessStatus(connectedMetadata, { secretConfigured: true });
ok('the status says connected', status.connected === true);
ok('the envId is masked', /^[0-9]{2}\*+[0-9]{2}$/.test(status.envIdMasked));
ok('the status never carries the seal', !JSON.stringify(status).includes('v1.'));
ok('the status never carries the key', !JSON.stringify(status).includes(KEY));
ok('the status never carries the fingerprint', !JSON.stringify(status).includes('sha256:'));
ok('an unverified profile is described as unverified', /not yet verified/i.test(status.hint));

const reauthStatus = publicAccessStatus(
  writeAccess(connectedMetadata, { reauthRequired: true, reauthPlatforms: ['turing'] }),
  { secretConfigured: true }
);
ok('a re-auth requirement is stated plainly', /expired[\s\S]*sign in again/i.test(reauthStatus.hint));

const noSecrets = publicAccessStatus({}, { secretConfigured: false });
ok('without a server secret the tenant is told which env var is missing',
  noSecrets.hint.includes(ACCESS_KEY_ENV) && noSecrets.canStore === false);
ok('secretsConfigured reads the env', secretsConfigured({ [ACCESS_KEY_ENV]: 'x' }) && !secretsConfigured({}));

eq('disconnecting removes only the access field',
  Object.keys(clearAccess(connectedMetadata)), ['voice']);

// ---------------------------------------------------------------------------
// Which identity a run uses
// ---------------------------------------------------------------------------

const hostedMap = { acme: { envId: '999', runtime: 'local' } };
eq('a tenant-owned profile wins over the hosted one',
  resolveAccessIdentity({ tenantSlug: 'acme', metadata: connectedMetadata, envMap: hostedMap }).source, 'tenant');
eq('without a connection the hosted profile is used',
  resolveAccessIdentity({ tenantSlug: 'acme', metadata: {}, envMap: hostedMap }).source, 'hosted');
eq('the default profile is the last resort',
  resolveAccessIdentity({ tenantSlug: 'other', metadata: {}, envMap: {}, defaultEnvId: '42' }).source, 'default');
eq('a tenant with no mapping at all resolves to nothing',
  resolveAccessIdentity({ tenantSlug: 'other', metadata: {}, envMap: {} }), null);

// A seal made with another server's key must never be treated as a working credential.
const foreignSeal = writeAccess({}, { envId: '2116562908359495680', keySealed: sealSecret(KEY, 'a-different-server-key') });
eq('a seal from another server cannot be opened', openSecret(readAccess(foreignSeal).keySealed, SECRET), null);

// ---------------------------------------------------------------------------
// "Is this profile still signed in?"
// ---------------------------------------------------------------------------

eq('cards mean signed in', classifySignedIn({ cards: 12, signals: [] }), 'signed_in');
// A signed-in page can still contain the word "login" in its chrome; cards decide.
eq('cards win over stray login words', classifySignedIn({ cards: 3, signals: ['login'] }), 'signed_in');
eq('a wall with no cards is a login wall', classifySignedIn({ cards: 0, signals: ['sign in'] }), 'login_wall');
eq('neither signal is unknown, not healthy', classifySignedIn({ cards: 0, signals: [] }), 'unknown');
eq('a failed probe is unknown', classifySignedIn({ ok: false }), 'unknown');

const bothExpired = summarizeSignedIn({ micro1: { cards: 0, signals: ['log in'] }, turing: { cards: 0, signals: ['sign in'] } });
ok('two walls require a reconnect', bothExpired.reauthRequired === true);
const oneAlive = summarizeSignedIn({ micro1: { cards: 12, signals: [] }, turing: { cards: 0, signals: ['sign in'] } });
ok('one live session is not a reconnect requirement', oneAlive.reauthRequired === false);
eq('but the dead one is still named', oneAlive.reauth, ['turing']);
const unknownOnly = summarizeSignedIn({ micro1: { cards: 0, signals: [] } });
ok('unknown alone does not alarm the tenant', unknownOnly.reauthRequired === false);

for (const platform of ['micro1', 'turing']) {
  const probe = signedInProbeFor(platform);
  let valid = true;
  try { new Function(probe); } catch { valid = false; }
  ok(`the ${platform} signed-in probe is valid JavaScript`, valid);
  ok(`the ${platform} probe has no unexpanded interpolation`, !probe.includes('${'));
}
// ---------------------------------------------------------------------------
// The endpoints, over real HTTP
// ---------------------------------------------------------------------------

function fakeSite(metadata = {}) {
  const row = { id: 'site-1', slug: 'acme', metadata: { ...metadata } };
  const db = {
    row,
    from() {
      return {
        update(patch) {
          const api = {
            eq: () => api,
            select: () => api,
            maybeSingle: async () => {
              Object.assign(row, patch);
              return { data: { id: row.id, slug: row.slug, metadata: row.metadata }, error: null };
            }
          };
          return api;
        }
      };
    }
  };
  return db;
}

async function withServer({ db, provider, env }) {
  const app = express();
  app.use(express.json());
  app.use('/', createBrowserAccessRouter({
    tenantSessionAuth: (req, _res, next) => next(),
    tenantSiteFromSession: async () => ({ site: { id: db.row.id, slug: db.row.slug, metadata: db.row.metadata } }),
    supabase: db,
    provider,
    env: env || { [ACCESS_KEY_ENV]: SECRET }
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

const goodProvider = {
  validateKey: async () => ({ ok: true, profiles: [{ envId: '2116562908359495680', name: 'Acme Studio' }] }),
  checkSignedIn: async () => ({
    ok: true,
    elapsedMs: 1200,
    results: { micro1: { cards: 12, signals: [] }, turing: { cards: 30, signals: [] } }
  })
};

// --- happy path ------------------------------------------------------------
{
  const db = fakeSite({ voice: 'warm-direct' });
  const server = await withServer({ db, provider: goodProvider });
  try {
    const before = await call(server.base, 'GET', '/tenant/blogger/browser-access');
    eq('a tenant with nothing connected is told so', before.body.connected, false);
    ok('and is told what to do', /connect your own morelogin/i.test(before.body.hint));

    const connect = await call(server.base, 'POST', '/tenant/blogger/browser-access/connect', { apiKey: KEY });
    eq('connecting returns 201', connect.status, 201);
    eq('and the response says connected', connect.body.connected, true);
    ok('the response carries no key', !JSON.stringify(connect.body).includes(KEY));
    ok('the response carries no seal', !JSON.stringify(connect.body).includes('v1.'));
    ok('the key IS stored, sealed', /^v1\./.test(db.row.metadata.browserAccess.keySealed));
    ok('the stored seal is not the key', db.row.metadata.browserAccess.keySealed !== KEY);
    eq('other metadata survives the write', db.row.metadata.voice, 'warm-direct');

    const verify = await call(server.base, 'POST', '/tenant/blogger/browser-access/verify', {});
    eq('verify returns 200', verify.status, 200);
    eq('both marketplaces are reported', verify.body.states, { micro1: 'signed_in', turing: 'signed_in' });
    ok('verifiedAt is recorded', Boolean(db.row.metadata.browserAccess.verifiedAt));
    ok('and the tenant is told a start was spent', /one morelogin profile start/i.test(verify.body.note));

    const statusAfter = await call(server.base, 'GET', '/tenant/blogger/browser-access');
    eq('the status reflects the verification', statusAfter.body.platforms.length, 2);
    eq('and says the tenant runs their own profile', statusAfter.body.runSource, 'tenant');

    const disconnect = await call(server.base, 'POST', '/tenant/blogger/browser-access/disconnect', {});
    eq('disconnecting succeeds', disconnect.status, 200);
    eq('the access record is gone', db.row.metadata.browserAccess, undefined);
    eq('the rest of metadata is untouched', db.row.metadata.voice, 'warm-direct');
  } finally {
    await server.close();
  }
}

// --- refusals --------------------------------------------------------------
{
  const db = fakeSite();
  const noSecret = await withServer({ db, provider: goodProvider, env: {} });
  try {
    const res = await call(noSecret.base, 'POST', '/tenant/blogger/browser-access/connect', { apiKey: KEY });
    eq('connecting without a server secret is refused', res.status, 503);
    ok('and names the env var', String(res.body.error).includes(ACCESS_KEY_ENV));
    eq('nothing was stored', db.row.metadata.browserAccess, undefined);
  } finally {
    await noSecret.close();
  }
}

{
  const db = fakeSite();
  const server = await withServer({ db, provider: goodProvider });
  try {
    eq('a short key is refused',
      (await call(server.base, 'POST', '/tenant/blogger/browser-access/connect', { apiKey: 'x' })).status, 400);
    eq('verify before connecting is refused',
      (await call(server.base, 'POST', '/tenant/blogger/browser-access/verify', {})).status, 409);
  } finally {
    await server.close();
  }
}

{
  const db = fakeSite();
  const rejecting = {
    validateKey: async () => ({ ok: false, reason: 'provider_error', detail: 'bad key' }),
    checkSignedIn: async () => ({ ok: false })
  };
  const server = await withServer({ db, provider: rejecting });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/connect', { apiKey: KEY });
    eq('a rejected key is a 502, not a stored credential', res.status, 502);
    eq('nothing was stored', db.row.metadata.browserAccess, undefined);
  } finally {
    await server.close();
  }
}

{
  const db = fakeSite();
  const empty = {
    validateKey: async () => ({ ok: true, profiles: [] }),
    checkSignedIn: async () => ({ ok: true, results: {} })
  };
  const server = await withServer({ db, provider: empty });
  try {
    eq('an account with no profile is refused',
      (await call(server.base, 'POST', '/tenant/blogger/browser-access/connect', { apiKey: KEY })).status, 409);
  } finally {
    await server.close();
  }
}

{
  // Two profiles: the tenant must choose, and the choice must be one they own.
  const db = fakeSite();
  const twoProfiles = {
    validateKey: async () => ({ ok: true, profiles: [{ envId: '111', name: 'A' }, { envId: '222', name: 'B' }] }),
    checkSignedIn: async () => ({ ok: true, results: {} })
  };
  const server = await withServer({ db, provider: twoProfiles });
  try {
    const ambiguous = await call(server.base, 'POST', '/tenant/blogger/browser-access/connect', { apiKey: KEY });
    eq('an ambiguous account must choose', ambiguous.status, 409);
    eq('and is shown the profiles', ambiguous.body.profiles.length, 2);

    const foreign = await call(server.base, 'POST', '/tenant/blogger/browser-access/connect', { apiKey: KEY, envId: '999' });
    eq('a profile the key does not own is refused', foreign.status, 403);
    eq('nothing was stored', db.row.metadata.browserAccess, undefined);

    const chosen = await call(server.base, 'POST', '/tenant/blogger/browser-access/connect', { apiKey: KEY, envId: '222' });
    eq('choosing an owned profile works', chosen.status, 201);
    eq('and the chosen profile is the one stored', db.row.metadata.browserAccess.envId, '222');
  } finally {
    await server.close();
  }
}

// --- a login wall is recorded; a failed check is not a sign-out -----------
{
  const db = fakeSite();
  const expired = {
    validateKey: async () => ({ ok: true, profiles: [{ envId: '2116562908359495680' }] }),
    checkSignedIn: async () => ({
      ok: true,
      results: { micro1: { cards: 0, signals: ['log in'] }, turing: { cards: 0, signals: ['sign in'] } }
    })
  };
  const server = await withServer({ db, provider: expired });
  try {
    await call(server.base, 'POST', '/tenant/blogger/browser-access/connect', { apiKey: KEY });
    const verify = await call(server.base, 'POST', '/tenant/blogger/browser-access/verify', {});
    eq('an expired session is not ok', verify.body.ok, false);
    ok('and is recorded as reauth required', db.row.metadata.browserAccess.reauthRequired === true);
    eq('naming the marketplaces', [...db.row.metadata.browserAccess.reauthPlatforms].sort(), ['micro1', 'turing']);
  } finally {
    await server.close();
  }
}

{
  const db = fakeSite();
  const quota = {
    validateKey: async () => ({ ok: true, profiles: [{ envId: '2116562908359495680' }] }),
    checkSignedIn: async () => ({ ok: false, reason: 'provider_quota', note: 'daily startup limit is exceeded' })
  };
  const server = await withServer({ db, provider: quota });
  try {
    await call(server.base, 'POST', '/tenant/blogger/browser-access/connect', { apiKey: KEY });
    const verify = await call(server.base, 'POST', '/tenant/blogger/browser-access/verify', {});
    eq('a failed check is a 502', verify.status, 502);
    // The important part: "could not check" must never become "signed out".
    ok('a failed check does not mark the tenant as needing to reconnect',
      db.row.metadata.browserAccess.reauthRequired === false);
    eq('the reason is passed through', verify.body.reason, 'provider_quota');
  } finally {
    await server.close();
  }
}

// --- a seal that cannot be opened demands a reconnect ---------------------
{
  const db = fakeSite({
    browserAccess: {
      provider: 'morelogin',
      envId: '2116562908359495680',
      runtime: 'cloud',
      keySealed: sealSecret(KEY, 'a-key-this-server-does-not-have'),
      connectedAt: '2026-11-02T10:00:00.000Z'
    }
  });
  const server = await withServer({ db, provider: goodProvider });
  try {
    const verify = await call(server.base, 'POST', '/tenant/blogger/browser-access/verify', {});
    eq('an unopenable seal is refused', verify.status, 409);
    eq('with a reason the UI can act on', verify.body.reason, 'reconnect_required');
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Which browser a runner drives
// ---------------------------------------------------------------------------

const tenantDb = (metadata) => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { id: 'site-1', slug: 'acme', metadata }, error: null })
      })
    })
  })
});

const runnerEnv = { [ACCESS_KEY_ENV]: SECRET, BROWSER_ACTOR_PROFILES: JSON.stringify({ hostedco: '777' }) };

const byoRunner = await resolveRunnerIdentity({ supabase: tenantDb(connectedMetadata), tenantSlug: 'acme', env: runnerEnv });
eq('a connected tenant runs on their own profile', byoRunner.source, 'tenant');
eq('with their own key, decrypted', byoRunner.apiKey, KEY);
eq('and their own runtime', byoRunner.runtime, 'cloud');

const hostedRunner = await resolveRunnerIdentity({ supabase: tenantDb({}), tenantSlug: 'hostedco', env: runnerEnv });
eq('a tenant with no connection falls back to the hosted profile', hostedRunner.source, 'hosted');
eq('and carries no key', hostedRunner.apiKey, null);

const defaultRunner = await resolveRunnerIdentity({ supabase: null, tenantSlug: 'whatever', env: { BROWSER_ACTOR_DEFAULT_ENV_ID: '42' } });
eq('the default profile is the last resort', defaultRunner.source, 'default');

let unmapped = null;
try { await resolveRunnerIdentity({ supabase: tenantDb({}), tenantSlug: 'stranger', env: {} }); } catch (error) { unmapped = error; }
eq('a tenant with no browser at all is refused', unmapped?.code, 'profile_unmapped');

let wrongKey = null;
const badSeal = writeAccess({}, { envId: '2116562908359495680', keySealed: sealSecret(KEY, 'another-server') });
try { await resolveRunnerIdentity({ supabase: tenantDb(badSeal), tenantSlug: 'acme', env: { [ACCESS_KEY_ENV]: SECRET } }); } catch (error) { wrongKey = error; }
// Falling back to the hosted profile here would silently run as the wrong account.
eq('a key that cannot be opened stops the run', wrongKey?.code, 'profile_unmapped');
eq('and says reconnecting is the fix', wrongKey?.details?.reason, 'reconnect_required');

let noSecret = null;
try { await resolveRunnerIdentity({ supabase: tenantDb(connectedMetadata), tenantSlug: 'acme', env: {} }); } catch (error) { noSecret = error; }
eq('without the sealing key the run refuses rather than guessing', noSecret?.code, 'not_configured');

// ---------------------------------------------------------------------------
// Rotating the sealing key without breaking every tenant
// ---------------------------------------------------------------------------

const OLD = 'the-old-sealing-key';
const NEW = 'the-new-sealing-key';
const sealedWithOld = sealSecret(KEY, OLD);

eq('the new key alone cannot open an old seal', openSecret(sealedWithOld, NEW), null);
// This is the whole point of TENANT_SECRET_KEY_PREVIOUS: a rotation can be rolled out
// without making every stored key unreadable in the same minute.
const rotating = openSecretFromEnv(sealedWithOld, { [ACCESS_KEY_ENV]: NEW, [ACCESS_KEY_PREVIOUS_ENV]: OLD });
eq('but with the retiring key configured it opens', rotating.value, KEY);
eq('and the source says it is still on the old key', rotating.source, 'previous');

const finished = openSecretFromEnv(sealSecretWithEnv(KEY, { [ACCESS_KEY_ENV]: NEW }), { [ACCESS_KEY_ENV]: NEW });
eq('a fresh seal opens with the current key', finished.value, KEY);
eq('and is reported as current', finished.source, 'current');

const unknown = openSecretFromEnv(sealedWithOld, { [ACCESS_KEY_ENV]: NEW });
eq('without the retiring key an old seal is unreadable', unknown.value, null);
eq('and has no source', unknown.source, null);

eq('accessSecrets normalises the pair', accessSecrets({ [ACCESS_KEY_ENV]: ' a ', [ACCESS_KEY_PREVIOUS_ENV]: ' ' }), { current: 'a', previous: null });

let noEnv = false;
try { sealSecretWithEnv(KEY, {}); } catch { noEnv = true; }
ok('sealing with no key configured still refuses', noEnv);

// ---------------------------------------------------------------------------
// The portal starting a capture itself — only for a cloud profile the tenant owns
// ---------------------------------------------------------------------------

/**
 * A database with both tables the capture route touches: the tenant row it reads metadata
 * from, and `browser_actor_runs`, where the queued row must be visible and closable.
 */
function fakeCaptureDb(metadata = {}) {
  const site = { id: 'site-1', slug: 'acme', metadata: { ...metadata } };
  const runs = [];
  const tokens = [];
  const makeTokens = () => {
    const filters = [];
    const chain = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      eq: (col, val) => { filters.push([col, val]); return chain; },
      is: (col, val) => { filters.push([col, val]); return chain; },
      insert(row) {
        const created = { id: `tok-${tokens.length + 1}`, created_at: new Date().toISOString(), revoked_at: null, ...row };
        tokens.push(created);
        return { select: () => ({ maybeSingle: async () => ({ data: created, error: null }) }) };
      },
      update(patch) {
        const hit = tokens.filter((row) => filters.every(([col, val]) => row[col] === val));
        hit.forEach((row) => Object.assign(row, patch));
        return chain;
      },
      maybeSingle: async () => ({ data: tokens.filter((row) => filters.every(([col, val]) => row[col] === val))[0] || null, error: null }),
      then: (resolve) => resolve({ data: tokens.filter((row) => filters.every(([col, val]) => row[col] === val)), error: null })
    };
    return chain;
  };
  const makeRuns = () => {
    const api = {
      insert(row) {
        const created = { id: `run-${runs.length + 1}`, created_at: new Date().toISOString(), ...row };
        runs.push(created);
        return { select: () => ({ maybeSingle: async () => ({ data: created, error: null }) }) };
      },
      select() {
        const filters = [];
        const chain = {
          eq: (col, val) => { filters.push([col, val]); return chain; },
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: runs.filter((r) => filters.every(([c, v]) => r[c] === v))[0] || null, error: null }),
          then: (resolve) => resolve({ data: runs.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null })
        };
        return chain;
      },
      update(patch) {
        const filters = [];
        const chain = {
          eq: (col, val) => { filters.push([col, val]); return chain; },
          select: () => chain,
          maybeSingle: async () => {
            const hit = runs.filter((r) => filters.every(([c, v]) => r[c] === v))[0] || null;
            if (hit) Object.assign(hit, patch);
            return { data: hit, error: null };
          }
        };
        return chain;
      }
    };
    return api;
  };
  return {
    site,
    runs,
    tokens,
    from(table) {
      if (table === 'browser_actor_runs') return makeRuns();
      if (table === 'browser_actor_agent_tokens') return makeTokens();
      return {
        update(patch) {
          const chain = {
            eq: () => chain,
            select: () => chain,
            maybeSingle: async () => {
              Object.assign(site, patch);
              return { data: site, error: null };
            }
          };
          return chain;
        }
      };
    }
  };
}

async function withCaptureServer({ db, spawnRun }) {
  const app = express();
  app.use(express.json());
  app.use('/', createBrowserAccessRouter({
    tenantSessionAuth: (req, _res, next) => next(),
    tenantSiteFromSession: async () => ({ site: { id: db.site.id, slug: db.site.slug, metadata: db.site.metadata } }),
    supabase: db,
    provider: goodProvider,
    spawnRun,
    env: { [ACCESS_KEY_ENV]: SECRET }
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const cloudAccess = { browserAccess: { provider: 'morelogin', envId: '2116562908359495680', runtime: 'cloud', keySealed: sealed, connectedAt: '2026-11-02T10:00:00.000Z' } };
const localAccess = { browserAccess: { provider: 'morelogin', envId: '2116562908359495680', runtime: 'local', keySealed: sealed, connectedAt: '2026-11-02T10:00:00.000Z' } };

{
  const db = fakeCaptureDb({});
  const server = await withCaptureServer({ db, spawnRun: () => { throw new Error('should not spawn'); } });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1' });
    eq('a tenant with no browser cannot start a capture', res.status, 409);
    eq('and is told why', res.body.reason, 'not_connected');
  } finally {
    await server.close();
  }
}

{
  // A local profile cannot be started from Render — so the run is queued for the tenant's
  // own worker instead of being refused. Same button, same row, honest status.
  const db = fakeCaptureDb(localAccess);
  const spawned = [];
  const server = await withCaptureServer({ db, spawnRun: (args) => { spawned.push(args); return { pid: 1 }; } });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1' });
    eq('a local profile queues instead of failing', res.status, 202);
    eq('and says it is waiting for the worker', res.body.queuedForWorker, true);
    // No token exists yet, so the honest next step is "create one", not "wait".
    eq('and tells a tenant with no worker to create one', res.body.needsWorkerToken, true);
    eq('nothing was spawned here', spawned.length, 0);
    eq('but a run row exists for the worker to claim', db.runs.length, 1);
    eq('and it is queued', db.runs[0].status, 'queued');

    // Once a worker exists the message changes: waiting is now true advice.
    const token = await call(server.base, 'POST', '/tenant/blogger/browser-access/worker-token', { label: 'pc' });
    eq('a worker token can be created', token.status, 201);
    ok('the token is shown once, prefixed', String(token.body.token || '').startsWith('wkr_'));
    ok('and the command to run is printed', /browser_actor_worker\.mjs --api .* --token wkr_/.test(token.body.command || ''));
    ok('the response says it will not be shown again', /not shown again/i.test(token.body.note || ''));
    eq('the stored row is a hash, not the token', db.tokens[0].token_hash === token.body.token, false);

    const status = await call(server.base, 'GET', '/tenant/blogger/browser-access');
    eq('the panel can see the worker', status.body.activeWorkers, 1);
    ok('but never a usable token', !JSON.stringify(status.body).includes(token.body.token));

    const revisited = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1' });
    // Same local profile, second capture: the first run is still queued, so this is the
    // one-at-a-time guard doing its job — not a worker problem.
    eq('a second capture is refused while the first is queued', revisited.status, 409);
  } finally {
    await server.close();
  }
}



{
  const db = fakeCaptureDb(cloudAccess);
  const server = await withCaptureServer({ db, spawnRun: () => ({ pid: 1 }) });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'turing' });
    eq('an unsupported marketplace is refused', res.status, 400);
    eq('and lists what is supported', res.body.supported, ['micro1']);
  } finally {
    await server.close();
  }
}

{
  const db = fakeCaptureDb(cloudAccess);
  const spawned = [];
  const server = await withCaptureServer({ db, spawnRun: (args) => { spawned.push(args); return { pid: 4242 }; } });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1', limit: 999 });
    eq('a cloud capture is accepted', res.status, 202);
    eq('a run row is created', db.runs.length, 1);
    eq('the run starts queued so the portal can watch it', db.runs[0].status, 'queued');
    eq('the runner is started with the run id', spawned[0].runId, db.runs[0].id);
    // A hard cap keeps a single portal-triggered run short.
    eq('the limit is clamped rather than trusted', spawned[0].limit, 24);
    ok('the tenant is told a start was spent', /one morelogin profile start/i.test(res.body.note));

    const again = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1' });
    eq('a second capture is refused while one is queued', again.status, 409);
    eq('with the reason the UI acts on', again.body.reason, 'already_running');
  } finally {
    await server.close();
  }
}

{
  const db = fakeCaptureDb(cloudAccess);
  const server = await withCaptureServer({ db, spawnRun: () => { throw new Error('spawn failed'); } });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1' });
    eq('a runner that cannot start is a 502', res.status, 502);
    // Leaving the row queued would make the portal wait for a process that is not there.
    eq('and the run is closed as failed', db.runs[0].status, 'failed');
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// The guide lives in the portal, not in an operator's chat message
// ---------------------------------------------------------------------------

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const dash = fs.readFileSync(path.join(root, 'admin/tenant_dashboard.html'), 'utf8');

ok('the connect panel is mounted in the portal', dash.includes("access.id = 'wfAccess'"));
ok('the five-step guide is rendered inside it', /How to connect \(5 minutes\)/.test(dash));
ok('step 1 says to create a MoreLogin account', /Create a MoreLogin account/.test(dash));
// The one promise this whole design rests on must be visible to the tenant, not just true.
ok('step 2 promises we never see the password', /never sees your password/.test(dash));
ok('step 3 says where the API key comes from', /account settings[\s\S]{0,60}API/.test(dash));
ok('step 4 is Verify sessions', /Verify sessions/.test(dash));
ok('step 5 is Capture now', /Capture now \(Micro1\)/.test(dash));
ok('the cost of a capture is stated in the portal', /one<\/strong> MoreLogin profile start/i.test(dash));
ok('and the reconnect remedy is stated', /sign in again inside MoreLogin/.test(dash));
// A guide that cannot tell you where you are is documentation, not a checklist.
ok('the guide marks the current step', /function wfAccessGuide/.test(dash) && /const current = !d\.connected/.test(dash));
// The worker UI: without it, a tenant whose plan has no cloud browser has no way to run
// anything, and "queuedForWorker" would be a dead end in the interface.
ok('the panel offers a worker token', /data-wfact="worker-create"/.test(dash));
ok('a created token shows a copyable command', /data-wfact="worker-copy"/.test(dash) && /not shown again/.test(dash));
ok('an existing worker can be revoked', /data-wfact="worker-revoke"/.test(dash));
ok('the panel says whether a worker has checked in', /last seen|never connected/.test(dash));
ok('a queued-for-worker capture is not reported as started', /queuedForWorker/.test(dash) && /needsWorkerToken/.test(dash));


// ---------------------------------------------------------------------------
// Worker tokens and the agent API
// ---------------------------------------------------------------------------

const issued = createAgentToken({ label: 'workshop pc' });
ok('a token is prefixed so it is recognisable in a log', issued.token.startsWith('wkr_'));
ok('the hash is not the token', issued.tokenHash !== issued.token && !issued.tokenHash.includes(issued.token));
ok('the prefix is short and safe to display', issued.tokenPrefix.length <= 9);
eq('two tokens differ', createAgentToken().token === createAgentToken().token, false);
eq('a bearer header is parsed', bearerTokenFromHeader('Bearer wkr_abc'), 'wkr_abc');
eq('a non-bearer header is refused', bearerTokenFromHeader('wkr_abc'), null);
ok('the right token matches its hash', tokenMatchesHash(issued.token, issued.tokenHash));
ok('a wrong token does not', !tokenMatchesHash(`${issued.token}x`, issued.tokenHash));
eq('a row is described without its hash', describeAgentToken({ id: 't1', token_prefix: 'wkr_ab', token_hash: 'deadbeef' }).prefix, 'wkr_ab');
ok('and the hash never appears in the description',
  !JSON.stringify(describeAgentToken({ id: 't1', token_prefix: 'wkr_ab', token_hash: 'deadbeef' })).includes('deadbeef'));

/** Just enough database for the agent routes: filters, update, and a thenable chain. */
function fakeAgentDb({ runs = [], tokens = [], site = { id: 'tenant-1', slug: 'acme' } } = {}) {
  const table = (name) => {
    const state = { filters: [], patch: null, mode: 'select' };
    const matches = (row) => state.filters.every(([col, kind, val]) => (
      kind === 'is' ? (val === null ? row[col] == null : row[col] === val) : row[col] === val
    ));
    const rows = () => (name === 'browser_actor_runs' ? runs : name === 'site_tenants' ? [site] : tokens);
    const apply = () => {
      if (state.mode === 'update') {
        const hit = rows().filter(matches);
        hit.forEach((row) => Object.assign(row, state.patch));
        return { data: hit, error: null };
      }
      return { data: rows().filter(matches), error: null };
    };
    const api = {
      select: () => api,
      order: () => api,
      limit: () => api,
      eq: (col, val) => { state.filters.push([col, 'eq', val]); return api; },
      is: (col, val) => { state.filters.push([col, 'is', val]); return api; },
      update: (patch) => { state.mode = 'update'; state.patch = patch; return api; },
      maybeSingle: async () => {
        const result = apply();
        const list = Array.isArray(result.data) ? result.data : [result.data];
        return { data: list[0] || null, error: null };
      },
      then: (resolve) => Promise.resolve().then(() => resolve(apply()))
    };
    return api;
  };
  return { runs, tokens, site, from: table };
}

async function withAgentServer(db) {
  const app = express();
  app.use(express.json());
  app.use('/', createAgentRunsRouter({ supabase: db }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function agentCall(base, method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

const liveToken = createAgentToken({ label: 'pc' });
const deadToken = createAgentToken({ label: 'old pc' });
const tokenRows = [
  { id: 'tok-1', tenant_id: 'tenant-1', token_hash: liveToken.tokenHash, token_prefix: liveToken.tokenPrefix, revoked_at: null },
  { id: 'tok-2', tenant_id: 'tenant-1', token_hash: deadToken.tokenHash, token_prefix: deadToken.tokenPrefix, revoked_at: '2026-11-01T00:00:00.000Z' }
];

{
  const db = fakeAgentDb({
    tokens: tokenRows,
    runs: [{ id: 'run-1', tenant_id: 'tenant-1', kind: 'referrals', status: 'queued', detail: { limit: 12 } }]
  });
  const server = await withAgentServer(db);
  try {
    eq('no token is refused', (await agentCall(server.base, 'GET', '/api/agent/health')).status, 401);
    eq('a bad token is refused',
      (await agentCall(server.base, 'GET', '/api/agent/health', { token: 'wkr_nope' })).status, 401);
    // A revoked token must not work just because the row still exists.
    eq('a revoked token is refused',
      (await agentCall(server.base, 'GET', '/api/agent/health', { token: deadToken.token })).status, 401);

    const health = await agentCall(server.base, 'GET', '/api/agent/health', { token: liveToken.token });
    eq('a live token identifies the tenant', health.body.tenant, 'acme');

    const listed = await agentCall(server.base, 'GET', '/api/agent/runs', { token: liveToken.token });
    eq('the worker sees its queued run', listed.body.runs.length, 1);

    const claimed = await agentCall(server.base, 'POST', '/api/agent/runs/run-1/claim', { token: liveToken.token });
    eq('claiming works', claimed.status, 200);
    eq('and puts the run in progress', claimed.body.run.status, 'running');
    // Two workers racing: the loser gets a 409 rather than the same run twice.
    eq('a second claim is refused',
      (await agentCall(server.base, 'POST', '/api/agent/runs/run-1/claim', { token: liveToken.token })).status, 409);
    // Another tenant's run is invisible through this token.
    eq("another tenant's run cannot be claimed",
      (await agentCall(server.base, 'POST', '/api/agent/runs/run-9/claim', { token: liveToken.token })).status, 409);

    const finished = await agentCall(server.base, 'POST', '/api/agent/runs/run-1/finish', {
      token: liveToken.token,
      body: { done: 12, ok: 10, failed: 2, total: 12 }
    });
    eq('finishing derives partial from the counters', finished.body.run.status, 'partial');
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// The worker a tenant downloads: no secrets in it, and nothing to install
// ---------------------------------------------------------------------------

{
  const bundle = buildWorkerBundle({ apiBase: 'https://portal.example' });
  const entries = listZipEntries(bundle.zip);
  const names = entries.map((entry) => entry.name);
  const textOf = (name) => entries.find((entry) => entry.name === name)?.data.toString('utf8') || '';
  const allText = entries.map((entry) => entry.data.toString('utf8')).join('\n');
  const codeText = entries
    .filter((entry) => entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))
    .map((entry) => entry.data.toString('utf8'))
    .join('\n');

  ok('the zip is a zip a tenant can open', entries.length > 10 && bundle.bytes > 10_000);
  for (const required of ['Start Worker.cmd', 'README.txt', 'worker-config.json',
    'scripts/browser_actor_worker.mjs', 'scripts/browser_actor_micro1.mjs',
    'utils/browserActor/applyCaptures.js', 'utils/tenantAccess.js']) {
    ok(`the zip contains ${required}`, names.includes(required));
  }

  // The whole point of the bundle: the machine that browses holds no credential.
  ok('no JWT in the zip', !/eyJhbGciOi/.test(allText));
  ok('no private key in the zip', !/BEGIN [A-Z ]*PRIVATE KEY/.test(allText));
  ok('no worker token in the zip', !/wkr_[A-Za-z0-9_-]{8,}/.test(allText));
  ok('no .env in the zip', !names.some((name) => /(^|\/)\.env/.test(name)));
  ok('no service-role key assignment in the zip', !/SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S/.test(allText));
  eq('the config holds the portal address and nothing else',
    Object.keys(JSON.parse(textOf('worker-config.json'))), ['api']);
  // Zero install: a bundled module that imports a bare package name would need node_modules.
  // `node:*` is a builtin, so it is excluded — and dotenv is only ever a dynamic import.
  const bareImport = /^\s*import\s+[^(]*from\s+['"](?!\.|\/|node:)/m;
  const bareSideEffect = /^\s*import\s+['"](?!\.|\/|node:)/m;
  ok('the worker imports no npm package statically',
    !bareImport.test(codeText) && !bareSideEffect.test(codeText));
  ok('the capture script reaches Supabase only in operator mode',
    /agentMode/.test(textOf('scripts/browser_actor_micro1.mjs')) &&
    /await import\('@supabase\/supabase-js'\)/.test(textOf('scripts/browser_actor_micro1.mjs')));
  ok('the worker passes the portal and the token to the capture in agent mode',
    /--agent-api/.test(textOf('scripts/browser_actor_worker.mjs')) &&
    /TENANT_WORKER_TOKEN: token/.test(textOf('scripts/browser_actor_worker.mjs')));
  ok('the worker does not put the token on a command line',
    !/--agent-token', token/.test(textOf('scripts/browser_actor_worker.mjs')));
  ok('the readme tells the tenant it never sees a password',
    /never sees or stores a marketplace password/i.test(textOf('README.txt')));
  ok('the readme explains the revoke step', /Revoke/.test(textOf('README.txt')));

  // A zip that can write outside its own folder is how "download the worker" becomes
  // "overwrite something in Program Files".
  let escaped = false;
  try { buildZipStore([{ name: '../evil.txt', data: 'x' }]); } catch { escaped = true; }
  ok('the zip writer refuses a path that escapes the folder', escaped);
}

// ---------------------------------------------------------------------------
// What a worker is allowed to say, and where it is allowed to say it
// ---------------------------------------------------------------------------

{
  const cleaned = sanitizeAgentCaptures([
    {
      title: 'Role A', jobId: 'abc', url: 'https://micro1.ai/x',
      referralUrl: 'javascript:alert(1)', content: 'x'.repeat(30_000), junk: 'drop me'
    },
    { title: '', jobId: '' },
    { title: 'Role B', jobId: 'def', referralUrl: 'https://micro1.ai/post/abc' }
  ]);
  eq('a capture without a title and job id is dropped', cleaned.length, 2);
  eq('a javascript: link is refused', cleaned[0].referralUrl, null);
  ok('unknown fields are dropped', !('junk' in cleaned[0]));
  eq('a very long body is cut', cleaned[0].content.length, 20_000);
  eq('a normal link survives', cleaned[1].referralUrl, 'https://micro1.ai/post/abc');
  eq('more than 50 captures are cut', sanitizeAgentCaptures(new Array(80).fill({ title: 't', jobId: 'j' })).length, 50);
  eq('a body that is not an array yields nothing', sanitizeAgentCaptures({ captures: [] }), []);
}

function fakeOfferDb() {
  const rows = [];
  return {
    rows,
    from(table) {
      if (table !== 'opportunities') throw new Error(`unexpected table ${table}`);
      return {
        insert(list) {
          rows.push(...list);
          return {
            select: async () => ({
              data: list.map((row, i) => ({ id: `offer-${i}`, title: row.title, slug: row.slug, referral_url: row.referral_url })),
              error: null
            })
          };
        },
        select() {
          const query = { eq: () => query, then: (resolve) => resolve({ data: rows, error: null }) };
          return query;
        }
      };
    }
  };
}

{
  const db = fakeOfferDb();
  const applied = await applyCaptures({
    supabase: db,
    tenant: { id: 'tenant-1', slug: 'acme' },
    offers: [{ id: 'x', title: 'Existing Role', slug: 'acme-micro1-existing-role', external_id: 'micro1:aaa' }],
    sourceId: null,
    sourceSlug: 'micro1',
    captures: [
      { title: 'New Role', jobId: 'bbb', externalId: 'micro1:bbb', url: 'https://micro1.ai/post/bbb', referralUrl: 'https://micro1.ai/post/bbb', content: 'body text' },
      { title: 'Existing Role', jobId: 'aaa', externalId: 'micro1:aaa', referralUrl: null }
    ],
    verify: async () => ({ verdict: 'match' })
  });
  eq('a role the tenant already has is skipped', applied.skipped.length, 1);
  eq('only the new role is inserted', applied.inserted, 1);
  eq('and it carries the verified link', db.rows[0].referral_url, 'https://micro1.ai/post/bbb');
  eq('with the captured body, not the summary', db.rows[0].description, 'body text');
  eq('and it is a draft, never published', db.rows[0].status, 'draft');
  eq('and it belongs to that tenant', db.rows[0].tenant_id, 'tenant-1');

  const mismatchDb = fakeOfferDb();
  const wrong = await applyCaptures({
    supabase: mismatchDb,
    tenant: { id: 'tenant-1', slug: 'acme' },
    offers: [],
    sourceSlug: 'micro1',
    captures: [{ title: 'Role C', jobId: 'ccc', externalId: 'micro1:ccc', referralUrl: 'https://micro1.ai/post/zzz' }],
    verify: async () => ({ verdict: 'mismatch', resolvedTitle: 'A Different Role' })
  });
  eq('a link that lands on a different job is not attached', mismatchDb.rows[0].referral_url, null);
  eq('and the verdict is recorded for the tenant to see', wrong.verification[0].verdict, 'mismatch');

  let refusedNoTenant = false;
  try {
    await applyCaptures({ supabase: fakeOfferDb(), tenant: { slug: 'acme' }, sourceSlug: 'micro1', captures: [] });
  } catch { refusedNoTenant = true; }
  ok('writing without a tenant id is refused', refusedNoTenant);
}

{
  // The result endpoint is where a tenant's machine can cause writes, so its guards matter
  // more than its happy path: no token, wrong run, closed run, empty payload.
  const runs = [
    { id: 'run-open', tenant_id: 'tenant-1', status: 'running', kind: 'referrals', platform: 'micro1', detail: { limit: 12 } },
    { id: 'run-done', tenant_id: 'tenant-1', status: 'partial', kind: 'referrals', platform: 'micro1', detail: { limit: 12 } }
  ];
  const created = createAgentToken({ label: 'pc' });
  const tokens = [{ id: 'tok-1', tenant_id: 'tenant-1', token_hash: created.tokenHash, token_prefix: created.tokenPrefix, revoked_at: null }];
  const db = fakeAgentDb({ runs, tokens });
  const server = await withAgentServer(db);
  try {
    eq('the result endpoint needs a token',
      (await agentCall(server.base, 'POST', '/api/agent/runs/run-open/result', { body: { captures: [] } })).status, 401);
    eq('a result for an unknown run is refused',
      (await agentCall(server.base, 'POST', '/api/agent/runs/run-nope/result', { token: created.token, body: { captures: [] } })).status, 404);
    const closed = await agentCall(server.base, 'POST', '/api/agent/runs/run-done/result', {
      token: created.token,
      body: { captures: [{ title: 'Role', jobId: 'abc' }] }
    });
    eq('a result for an already-closed run is refused', closed.status, 409);
    ok('and says why instead of pretending to write', /already partial/i.test(closed.body?.error || ''));
    const empty = await agentCall(server.base, 'POST', '/api/agent/runs/run-open/result', { token: created.token, body: { captures: [] } });
    eq('a result with nothing usable is refused', empty.status, 400);
  } finally {
    await server.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);










