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
  clearWorkerBrowser,
  fingerprintSecret,
  openSecret,
  openSecretFromEnv,
  publicAccessStatus,
  publicWorkerBrowser,
  readAccess,
  readWorkerBrowser,
  resolveAccessIdentity,
  sealSecret,
  sealSecretWithEnv,
  secretsConfigured,
  writeAccess,
  writeWorkerBrowser
} from '../utils/tenantAccess.js';
import { classifySignedIn, summarizeSignedIn, signedInProbeFor } from '../utils/browserActor/signedIn.js';
import { createBrowserAccessRouter } from '../routes/browserAccess.js';
import { createAgentRunsRouter } from '../routes/agentRuns.js';
import {
  createAgentToken,
  bearerTokenFromHeader,
  tokenMatchesHash,
  describeAgentToken,
  extractAgentToken
} from '../utils/browserActor/agentTokens.js';
import { resolveRunnerIdentity } from '../utils/tenantRunnerIdentity.js';
import { buildWorkerBundle } from '../utils/browserActor/workerBundle.js';
import { buildZipStore, listZipEntries } from '../utils/zipStore.js';
import { sanitizeAgentCaptures } from '../routes/agentRuns.js';
import { applyCaptures, applyCaptureUpdates } from '../utils/browserActor/applyCaptures.js';
import { runPlatform, canRunOnWorker } from '../utils/browserActor/runs.js';

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
// A tenant names their own profile, so ml-cli is not a prerequisite (2026-11-07)
// ---------------------------------------------------------------------------
// Live failure this prevents: a fresh tenant PC has MoreLogin but not `ml-cli`, so the worker
// cannot discover the profile, and the first capture dies with
// `profile_unmapped → 409 agent_context_refused` before any browser opens. Typing the id into
// the portal is the one step that needs no download, no key and no operator.
{
  const typed = writeWorkerBrowser({}, { envId: '2116562908359495680', label: 'Lifeline PC', origin: 'tenant' });
  const readBack = readWorkerBrowser(typed);
  eq('a tenant-typed profile is stored like a reported one', readBack.envId, '2116562908359495680');
  eq('and is marked as theirs, not the worker\'s', readBack.origin, 'tenant');

  const workerTyped = readWorkerBrowser(writeWorkerBrowser({}, { envId: '2116562908359495680' }));
  eq('a profile the worker found keeps origin=worker', workerTyped.origin, 'worker');

  let refusedMalformed = null;
  try { writeWorkerBrowser({}, { envId: 'not-a-number', origin: 'tenant' }); } catch (error) { refusedMalformed = error; }
  ok('a malformed id is refused before it reaches the database', Boolean(refusedMalformed));

  // A run on that machine resolves it.
  const onMachine = await resolveRunnerIdentity({
    supabase: tenantDb(typed), tenantSlug: 'lifeline-inc', env: {}, workerRuns: true
  });
  eq('a run on the tenant\'s machine uses the profile they typed', onMachine.envId, '2116562908359495680');
  eq('and says where it came from', onMachine.source, 'tenant-profile');
  eq('carrying no key, because none was given', onMachine.apiKey, null);

  // A run from the server must still refuse: a desktop profile is not reachable from Render.
  let serverSide = null;
  try {
    await resolveRunnerIdentity({ supabase: tenantDb(typed), tenantSlug: 'lifeline-inc', env: {} });
  } catch (error) { serverSide = error; }
  eq('the server still refuses a desktop profile it cannot reach', serverSide?.code, 'profile_unmapped');
  ok('and the refusal names the portal field as the fix',
    /profile ID[\s\S]{0,40}Your own browser/i.test(String(serverSide?.details?.fix || '')),
    serverSide?.details?.fix);
}

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
function fakeCaptureDb(metadata = {}, { insertError = null } = {}) {
  const site = { id: 'site-1', slug: 'acme', metadata: { ...metadata } };
  const runs = [];
  const tokens = [];
  let pendingInsertError = insertError;
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
        // A real Postgres refusal (23514 kind_check / 23505 unique) surfaces as `error` from
        // supabase-js, not as a throw; the store rethrows it, so the fake must too.
        if (pendingInsertError) {
          const error = pendingInsertError;
          pendingInsertError = null;
          return { select: () => ({ maybeSingle: async () => ({ data: null, error }) }) };
        }
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
  // The live failure on 2026-11-03, second act: `browser_actor_runs_kind_check` only allowed
  // collect/import/referrals/verify, so queueing kind `micro1` was refused by Postgres with
  // 23514 — and the route turned that into a 500 "Could not queue the capture". A missing
  // migration is a deployment state, so it degrades to `collect` (never `referrals`, the slot
  // Turing occupies) and says so, rather than failing the tenant's click.
  const db = fakeCaptureDb(
    { workerBrowser: { envId: '2116562908359495680', label: 'Malingu Ventures' } },
    { insertError: { code: '23514', message: 'new row violates check constraint "browser_actor_runs_kind_check"' } }
  );
  const server = await withCaptureServer({ db, spawnRun: () => ({ pid: 1 }) });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1' });
    eq('a missing micro1 kind falls back instead of 500ing', res.status, 202);
    eq('and the run still queues', db.runs.length, 1);
    eq('under an existing kind, not the Turing slot', db.runs[0]?.kind, 'collect');
    eq('and the caller is told the trail is temporary', res.body.kindFallback, true);
    ok('the marketplace is still recorded for the worker filter', db.runs[0]?.detail?.platform === 'micro1');
  } finally {
    await server.close();
  }
}

{
  // If even the fallback is refused (a live Turing `collect` run holds that slot too), the
  // answer is a 503 that names the migration — not a 500 that blames the tenant.
  const db = fakeCaptureDb(
    { workerBrowser: { envId: '2116562908359495680' } },
    { insertError: { code: '23514', message: 'browser_actor_runs_kind_check' } }
  );
  db.from = ((original) => (table) => {
    const api = original(table);
    if (table !== 'browser_actor_runs') return api;
    const insert = api.insert;
    let first = true;
    api.insert = (row) => {
      const result = insert(row);
      if (first && row.kind === 'collect') {
        first = false;
        return { select: () => ({ maybeSingle: async () => ({ data: null, error: { code: '23505', message: 'uq_browser_actor_runs_active' } }) }) };
      }
      return result;
    };
    return api;
  })(db.from);
  const server = await withCaptureServer({ db, spawnRun: () => ({ pid: 1 }) });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1' });
    eq('a blocked fallback slot is a conflict, not a crash', res.status, 409);
    eq('and names the real reason', res.body.reason, 'already_running');
  } finally {
    await server.close();
  }
}

{
  // The tenant did everything right — worker running, browser reported — and was still told
  // "Connect your own browser first", because this route demanded a *keyed* connection. A key
  // is only needed when the server itself starts the browser; a queued run for the tenant's
  // worker needs nothing but the profile id it already reported.
  const db = fakeCaptureDb({
    workerBrowser: {
      envId: '2116562908359495680',
      label: 'Malingu Ventures',
      machine: 'DESKTOP-A2JE7DO',
      reportedAt: '2026-11-03T09:39:34.000Z'
    }
  });
  const spawned = [];
  const server = await withCaptureServer({ db, spawnRun: (args) => { spawned.push(args); return { pid: 1 }; } });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1' });
    eq('a worker-reported browser is enough to queue a capture', res.status, 202);
    eq('and it is queued for that machine', res.body.queuedForWorker, true);
    eq('as a micro1 run', db.runs[0]?.kind, 'micro1');
    eq('with the local runtime recorded', db.runs[0]?.detail?.runtime, 'local');
    eq('and nothing was started on this host', spawned.length, 0);
  } finally {
    await server.close();
  }
}

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
    // Own kind, own slot. Sharing `referrals` with the Turing queue is what let a queued
    // Turing run (waiting for an operator) block the Micro1 capture a tenant could actually
    // run — observed live on 2026-11-03, and the unique index scopes on kind.
    eq('and it is its own kind, so a waiting Turing run cannot block it', db.runs[0].kind, 'micro1');
    eq('and it still records the marketplace for the worker filter', db.runs[0].detail.platform, 'micro1');

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
    // A hard cap keeps a single portal-triggered run short — but it has to be long enough to be
    // worth a MoreLogin start, which is why it moved from 24 to 150.
    eq('the limit is clamped rather than trusted', spawned[0].limit, 150);
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
// A block a tenant cannot find is a block that does not exist. The first version only
// rendered this when `d.connected`, so a tenant who had not connected yet — the exact person
// who needs to know a worker is coming — saw nothing at all.
ok('the worker block renders even before the browser is connected',
  /<li>Open the folder and double-click <strong>Start Worker\.cmd<\/strong>/.test(dash) &&
  !/\$\{d\.connected \? wfWorkerHtml\(d\) : ''\}/.test(dash));
ok('the download button points at the bundle route',
  /href="\/tenant\/blogger\/browser-access\/worker-bundle"/.test(dash));
// A local profile has no cloud browser to start, so hiding Capture now left a tenant with no
// way to queue anything at all.
ok('a local profile still gets a Capture now button',
  /data-wfact="capture"/.test(dash) && !/d\.runtime === 'cloud' \? '<button[^']*data-wfact="capture"/.test(dash));
ok('and the panel says the run waits for the worker',
  /queues the run and your worker picks it up/.test(dash));
ok('a cloud profile is told no worker is needed', /No worker needed/.test(dash));
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
function fakeAgentDb({ runs = [], tokens = [], offers = [], signals = [], site = { id: 'tenant-1', slug: 'acme' } } = {}) {
  const table = (name) => {
    const state = { filters: [], patch: null, mode: 'select' };
    const matches = (row) => state.filters.every(([col, kind, val]) => {
      if (kind === 'is') return val === null ? row[col] == null : row[col] === val;
      if (kind === 'in') return (Array.isArray(val) ? val : []).includes(row[col]);
      if (kind === 'gte') return Number(row[col]) >= Number(val);
      if (kind === 'neq') return row[col] !== val;
      return row[col] === val;
    });
    const rows = () => {
      if (name === 'browser_actor_runs') return runs;
      if (name === 'site_tenants') return [site];
      if (name === 'opportunities') return offers;
      if (name === 'social_signals') return signals;
      // An unknown table answers empty rather than with tokens: a stray token row would look
      // like a matched `opportunity_sources` row and quietly attribute offers to nothing.
      if (name === 'browser_actor_agent_tokens') return tokens;
      return [];
    };
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
      in: (col, val) => { state.filters.push([col, 'in', val]); return api; },
      gte: (col, val) => { state.filters.push([col, 'gte', val]); return api; },
      neq: (col, val) => { state.filters.push([col, 'neq', val]); return api; },
      update: (patch) => { state.mode = 'update'; state.patch = patch; return api; },
      insert: (row) => {
        const created = Array.isArray(row) ? row : [row];
        if (name === 'social_signals') {
          // The unique constraint on (tenant_id, post_url) is the real one in Postgres; without
          // it here the duplicate path could not be tested at all.
          const clash = created.find((entry) => signals.some((existing) => (
            existing.tenant_id === entry.tenant_id && existing.post_url === entry.post_url
          )));
          if (clash) {
            return { select: () => ({ maybeSingle: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }), then: (resolve) => Promise.resolve({ data: null, error: { code: '23505' } }).then(resolve) }) };
          }
          created.forEach((entry) => signals.push({ id: `signal-${signals.length + 1}`, status: 'new', ...entry }));
          return { select: () => ({ maybeSingle: async () => ({ data: created[0] || null, error: null }), then: (resolve) => Promise.resolve({ data: created, error: null }).then(resolve) }) };
        }
        // Offers are the only other rows this suite inserts through the agent routes.
        created.forEach((entry) => offers.push({ id: `offer-${offers.length + 1}`, ...entry }));
        return { select: () => ({ maybeSingle: async () => ({ data: created[0] || null, error: null }), then: (resolve) => Promise.resolve({ data: created, error: null }).then(resolve) }) };
      },
      maybeSingle: async () => {
        const result = apply();
        const list = Array.isArray(result.data) ? result.data : [result.data];
        return { data: list[0] || null, error: null };
      },
      then: (resolve) => Promise.resolve().then(() => resolve(apply()))
    };
    return api;
  };
  return { runs, tokens, site, signals, from: table };
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
    // The argv lives in runArgs.js since 2026-11-04 (it is pure so it can be tested); the token
    // still travels through the environment, never the command line.
    /--agent-api/.test(textOf('utils/browserActor/runArgs.js'))
    && /TENANT_WORKER_TOKEN: token/.test(textOf('scripts/browser_actor_worker.mjs')));
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

// ---------------------------------------------------------------------------
// What the tenant pastes, and how they start it — both went wrong in production
// ---------------------------------------------------------------------------

{
  // Observed in the wild: the whole command line pasted into the "Token:" prompt, and the
  // whole line saved as the credential.
  eq('a bare token is recognised',
    extractAgentToken('wkr_abc123DEF456'), 'wkr_abc123DEF456');
  eq('a pasted command line yields the token inside it',
    extractAgentToken('node scripts/browser_actor_worker.mjs --api https://alphadome.onrender.com --token wkr_Vl_BoA6JoUNTvOql8MlTlNZ4wny'),
    'wkr_Vl_BoA6JoUNTvOql8MlTlNZ4wny');
  eq('surrounding quotes and spaces are ignored',
    extractAgentToken('  "wkr_abc123"  '), 'wkr_abc123');
  eq('a line with no token yields nothing', extractAgentToken('just some text'), null);
  eq('empty input yields nothing', extractAgentToken(''), null);
  eq('an unrelated command is not mistaken for a token',
    extractAgentToken('node server.js --port 3000'), null);
}

{
  const startCmd = fs.readFileSync(path.join(root, 'worker-bundle', 'Start Worker.cmd'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'worker-bundle', 'README.txt'), 'utf8');
  // Running the .cmd from inside the zip window leaves only that file in %TEMP%, and Node
  // then dies with MODULE_NOT_FOUND — which is what the tenant actually saw.
  ok('the start file refuses to run from inside the zip',
    /if not exist "scripts\\browser_actor_worker\.mjs" goto notextracted/.test(startCmd) &&
    /Extract All/.test(startCmd));
  ok('and explains the extract step rather than printing a stack trace',
    /Extract All\.\.\./.test(startCmd) && /pause/.test(startCmd));
  ok('the start file checks for Node.js 22 or newer',
    /versions\.node\.split\('\.'\)\[0\]\)>=22/.test(startCmd));
  ok('the prompt asks for the token only, not the whole command',
    /Paste ONLY the worker token/.test(startCmd) && /Do not paste the whole node command/.test(startCmd));
  ok('the readme puts the unzip warning before the token step',
    readme.indexOf('IMPORTANT') < readme.indexOf('worker-token.txt'));

  const dash2 = fs.readFileSync(path.join(root, 'admin', 'tenant_dashboard.html'), 'utf8');
  // The two ways to start a worker sat next to each other, so a tenant pasted the command
  // into the token box. The terminal route is now folded away as advanced.
  ok('the terminal command is tucked behind an "Advanced" disclosure',
    /<summary[^>]*>Advanced: run it from a terminal instead<\/summary>/.test(dash2));

  // The zip is assembled on demand from this repository, so a deploy is enough — but only if the
  // runners that land in it are the current ones. A stale bundle would have re-sent 400 KB a flush
  // however good the server-side fix was, so the shipped copy is checked, not assumed.
  const built = buildWorkerBundle({ apiBase: 'https://alphadome.onrender.com', pairCode: null });
  const entrySource = (pattern) => {
    const entry = built.entries.find((row) => pattern.test(row.name || ''));
    return entry ? Buffer.from(entry.data || '').toString('utf8') : '';
  };
  const shippedTuring = entrySource(/browser_actor_referrals\.mjs$/);
  const shippedMicro1 = entrySource(/browser_actor_micro1\.mjs$/);
  ok('the downloaded worker carries both marketplace runners',
    shippedTuring.length > 1000 && shippedMicro1.length > 1000);
  ok('and the fixed batching, not the version that sent 400 KB at once',
    /postedCount/.test(shippedTuring) && /res\.status === 413 && chunk\.length > 1/.test(shippedTuring)
    && /const CHUNK = 20;/.test(shippedMicro1));
}

// ---------------------------------------------------------------------------
// Context: whose profile may a tenant's worker drive, and what happens when it can't
// ---------------------------------------------------------------------------

{
  const created = createAgentToken({ label: 'ctx' });
  const runs = [{ id: 'run-ctx', tenant_id: 'tenant-1', status: 'queued', kind: 'referrals', platform: 'micro1', detail: { limit: 5 } }];
  const tokens = [{ id: 'tok-ctx', tenant_id: 'tenant-1', token_hash: created.tokenHash, token_prefix: created.tokenPrefix, revoked_at: null }];
  const db = fakeAgentDb({ runs, tokens });
  const server = await withAgentServer(db);
  const before = process.env.BROWSER_ACTOR_PROFILES;
  try {
    // The operator's own tenant uses a *hosted* profile that is a local desktop profile on
    // the very machine the worker runs on. The first version refused `source !== 'tenant'`
    // and so refused the only tenant that had a worker — a 409 that read like a policy
    // decision and was actually a bug.
    process.env.BROWSER_ACTOR_PROFILES = JSON.stringify({ acme: '123456789' });
    const hosted = await agentCall(server.base, 'GET', '/api/agent/runs/run-ctx/context', { token: created.token });
    eq('a local hosted profile may be driven by the tenant worker', hosted.status, 200);
    eq('and the context says whose profile it is', hosted.body?.identity?.source, 'hosted');
    eq('and it carries the run limit', hosted.body?.run?.limit, 5);
    ok('and never a MoreLogin key', !('apiKey' in (hosted.body?.identity || {})));

    process.env.BROWSER_ACTOR_PROFILES = JSON.stringify({ acme: { envId: '123456789', runtime: 'cloud' } });
    const cloud = await agentCall(server.base, 'GET', '/api/agent/runs/run-ctx/context', { token: created.token });
    eq('a cloud profile is refused, because the portal should run it', cloud.status, 409);
    ok('and says so in words the tenant can act on', /press Capture now again/i.test(cloud.body?.error || ''));
  } finally {
    if (before === undefined) delete process.env.BROWSER_ACTOR_PROFILES;
    else process.env.BROWSER_ACTOR_PROFILES = before;
    await server.close();
  }
}

{
  const capture = fs.readFileSync(path.join(root, 'scripts', 'browser_actor_micro1.mjs'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'scripts', 'browser_actor_worker.mjs'), 'utf8');

  // Observed in production: claim 200, context 409, then process.exit(3) — so the run stayed
  // "running" for ever and the tenant's next Capture now was refused as already_active.
  ok('a refused context throws instead of exiting, so the run can be closed',
    !/process\.exit\(3\)/.test(capture) && /agent_context_refused/.test(capture));
  ok('the capture owns the run id before it asks for context',
    capture.indexOf('runState.runId = String(runIdFlag)') < capture.indexOf('await loadTenantContext()'));
  ok('the worker closes a run its child abandoned',
    /async function closeAbandonedRun/.test(worker) && /"status": 'failed'|status: 'failed'/.test(worker));
  ok('and explains that the tenant should press Capture now again',
    /press Capture now again after fixing the cause/.test(worker));
}
// ---------------------------------------------------------------------------
// Zero-config: the worker asks MoreLogin on its own computer, then tells the portal
// ---------------------------------------------------------------------------
//
// The production failure this fixes: claim 200, context 409 "No browser is mapped", run
// closed. The tenant had a working worker on the machine with the profile — the *server*
// simply had no idea, because learning it required pasting a MoreLogin API key. These tests
// hold the replacement to the two things that matter: the machine's own answer is enough to
// run, and nothing about it looks like a credential.

{
  const ENV = '2116562908359495680';
  const other = { keepMe: true, voice: { id: 'warm' } };

  const written = writeWorkerBrowser(other, { envId: ENV, label: 'P-4', machine: 'workshop-pc', reportedAt: '2026-11-03T05:20:00.000Z' });
  const read = readWorkerBrowser(written);
  eq('a reported profile is remembered', read.envId, ENV);
  eq('with the name the tenant knows it by', read.label, 'P-4');
  eq('and the machine it came from', read.machine, 'workshop-pc');
  ok('without disturbing the rest of metadata', written.keepMe === true && written.voice?.id === 'warm');

  // A worker is authenticated, not trusted: a bad id would only be found at `env start`,
  // after the run had been claimed and the tenant had been told it was running.
  let threw = null;
  try { writeWorkerBrowser({}, { envId: 'P-4' }); } catch (error) { threw = error; }
  ok('a profile id that is not decimal is refused at the door', Boolean(threw));
  eq('and a junk id reads as no profile at all', readWorkerBrowser({ workerBrowser: { envId: 'P-4' } }), null);

  const cleared = clearWorkerBrowser(written);
  eq('disconnecting forgets the reported profile', readWorkerBrowser(cleared), null);
  ok('and leaves the other metadata alone', cleared.voice?.id === 'warm');

  const publicShape = publicWorkerBrowser(written);
  ok('the tenant sees a masked id', publicShape.envIdMasked !== ENV && publicShape.envIdMasked.endsWith('80'));
  ok('the tenant never sees the full id', !JSON.stringify(publicShape).includes(ENV));
  eq('an unconnected tenant is told no key is needed',
    publicAccessStatus(written).hint.includes('no key to paste'), true);
  ok('and the status carries the reported profile', publicAccessStatus(written).workerBrowser?.label === 'P-4');

  // Resolution order: the reported profile fills the empty case only.
  eq('a reported profile resolves nothing for the server',
    resolveAccessIdentity({ tenantSlug: 'acme', metadata: written }), null);
  eq('but it is what a worker run uses',
    resolveAccessIdentity({ tenantSlug: 'acme', metadata: written, workerRuns: true })?.source, 'worker');
  eq('a hosted mapping still wins over the reported profile',
    resolveAccessIdentity({ tenantSlug: 'acme', metadata: written, envMap: { acme: { envId: '999' } }, workerRuns: true })?.source,
    'hosted');
  const keyed = writeAccess(written, { envId: '123456789', keySealed: sealSecret('ml-key', 'secret'), runtime: 'local' });
  eq("a tenant's own key still wins over the reported profile",
    resolveAccessIdentity({ tenantSlug: 'acme', metadata: keyed, workerRuns: true })?.source, 'tenant');

  // The same rule at the resolver the runners actually call.
  let unmappedCode = null;
  try {
    await resolveRunnerIdentity({ supabase: tenantDb(written), tenantSlug: 'acme', env: {} });
  } catch (error) { unmappedCode = error?.code || error?.message; }
  eq('verify and portal capture still refuse a profile that lives on a laptop', unmappedCode, 'profile_unmapped');
  eq('the tenant worker resolves it',
    (await resolveRunnerIdentity({ supabase: tenantDb(written), tenantSlug: 'acme', env: {}, workerRuns: true }))?.source,
    'worker');
  const hostedEnv = { BROWSER_ACTOR_PROFILES: JSON.stringify({ acme: '5551234' }) };
  eq('and an operator mapping is not overridden by it',
    (await resolveRunnerIdentity({ supabase: tenantDb(written), tenantSlug: 'acme', env: hostedEnv, workerRuns: true }))?.source,
    'hosted');
  const unmapped = await resolveRunnerIdentity({ supabase: tenantDb({}), tenantSlug: 'acme', env: {}, workerRuns: true })
    .catch((error) => error);
  ok('with nothing anywhere, the message names the cheapest fix first',
    /start the worker/i.test(unmapped?.details?.fix || ''));
}



// ---------------------------------------------------------------------------
// The endpoint the worker calls once at startup. Without it, production looked like a bug:
// a queued run that could never be claimed into a capture.
{
  const created = createAgentToken({ label: 'zero-config' });
  const siteRow = { id: 'tenant-1', slug: 'acme', metadata: {} };
  const db = fakeAgentDb({
    site: siteRow,
    runs: [{ id: 'run-zb', tenant_id: 'tenant-1', status: 'queued', kind: 'referrals', platform: 'micro1', detail: { limit: 7 } }],
    tokens: [{ id: 'tok-zb', tenant_id: 'tenant-1', token_hash: created.tokenHash, token_prefix: created.tokenPrefix, revoked_at: null }]
  });
  const server = await withAgentServer(db);
  const savedProfiles = process.env.BROWSER_ACTOR_PROFILES;
  const savedDefault = process.env.BROWSER_ACTOR_DEFAULT_ENV_ID;
  try {
    delete process.env.BROWSER_ACTOR_PROFILES;
    delete process.env.BROWSER_ACTOR_DEFAULT_ENV_ID;

    eq('the report needs a token',
      (await agentCall(server.base, 'POST', '/api/agent/browser', { body: { envId: '2116562908359495680' } })).status, 401);
    eq('and refuses an id that is not a profile',
      (await agentCall(server.base, 'POST', '/api/agent/browser', { token: created.token, body: { envId: 'P-4' } })).status, 400);

    const blind = await agentCall(server.base, 'GET', '/api/agent/runs/run-zb/context', { token: created.token });
    eq('before the report, a worker has no browser to run — the production 409', blind.status, 409);

    const reported = await agentCall(server.base, 'POST', '/api/agent/browser', {
      token: created.token,
      body: { envId: '2116562908359495680', label: 'P-4', machine: 'workshop-pc' }
    });
    eq('the worker can report the browser on its computer', reported.status, 200);
    eq('and is told a run will use it', reported.body?.uses, 'worker');
    ok('the response does not echo the full profile id', !JSON.stringify(reported.body || {}).includes('2116562908359495680'));
    eq('what is stored is not a keyed connection', readAccess(siteRow.metadata), null);
    eq('but the profile is there', readWorkerBrowser(siteRow.metadata)?.label, 'P-4');

    const context = await agentCall(server.base, 'GET', '/api/agent/runs/run-zb/context', { token: created.token });
    eq('the same run now has a browser to drive', context.status, 200);
    eq('resolved from the machine that reported it', context.body?.identity?.source, 'worker');
    eq('with the id MoreLogin gave the worker', context.body?.identity?.envId, '2116562908359495680');
    ok('and the tenant machine still holds no MoreLogin key', !('apiKey' in (context.body?.identity || {})));

    // Reconnecting with a key must beat it, and the worker must be told that plainly.
    siteRow.metadata = writeAccess(siteRow.metadata, {
      envId: '123456789',
      keySealed: sealSecretWithEnv('ml-key', { [ACCESS_KEY_ENV]: 'k' }),
      runtime: 'local'
    });
    const again = await agentCall(server.base, 'POST', '/api/agent/browser', { token: created.token, body: { envId: '2116562908359495680' } });
    eq('a keyed connection outranks a reported one, and says so', again.body?.uses, 'tenant');
    ok('with the way out spelled out', /priority/i.test(again.body?.note || ''));
  } finally {
    if (savedProfiles === undefined) delete process.env.BROWSER_ACTOR_PROFILES;
    else process.env.BROWSER_ACTOR_PROFILES = savedProfiles;
    if (savedDefault === undefined) delete process.env.BROWSER_ACTOR_DEFAULT_ENV_ID;
    else process.env.BROWSER_ACTOR_DEFAULT_ENV_ID = savedDefault;
    await server.close();
  }
}

{
  const workerSrc = fs.readFileSync(path.join(root, 'scripts', 'browser_actor_worker.mjs'), 'utf8');
  const dashSrc = fs.readFileSync(path.join(root, 'admin', 'tenant_dashboard.html'), 'utf8');

  // The whole point: no key to find, no id to type.
  ok('the worker reads the profiles MoreLogin already has', /listProfiles\(\{ pageNo: 1, pageSize: 50 \}\)/.test(workerSrc));
  ok('and reports the one it found', /'\/api\/agent\/browser'/.test(workerSrc));
  ok('a one-off choice is remembered in worker-config.json', /rememberConfig\(\{ envId/.test(workerSrc));
  ok('several profiles are listed for the tenant to pick once', /--env-id <profileId>/.test(workerSrc));
  ok('a machine with no ml-cli says so instead of failing at the claim', /could not read the MoreLogin profiles on this computer/.test(workerSrc));
  ok('an older portal does not stop the worker', /older than this worker/.test(workerSrc));

  ok('the panel calls a detected browser connected, not "not connected"',
    /browser found on your computer/.test(dashSrc));
  ok('and shows it instead of the amber no-browser warning',
    /Using the browser your worker found on this computer/.test(dashSrc));
  ok('the amber warning now points at the worker before the key',
    /Start <strong>your worker<\/strong> on the computer that has your MoreLogin profile/.test(dashSrc));
}

{
  // The run outlives a single post: a long capture arrives in batches, so /result reports
  // progress and /finish closes the run. While /result closed it, an interrupted run lost every
  // link it had already minted.
  const created = createAgentToken({ label: 'batch' });
  const tokenRows2 = [{ id: 'tok-b', tenant_id: 'tenant-1', token_hash: created.tokenHash, token_prefix: created.tokenPrefix, revoked_at: null }];
  const openRun = { id: 'run-batch', tenant_id: 'tenant-1', status: 'running', kind: 'referrals', platform: 'turing', detail: { limit: 40 } };
  const db = fakeAgentDb({
    tokens: tokenRows2,
    runs: [openRun],
    site: { id: 'tenant-1', slug: 'acme' },
    offers: [{ id: 'o1', title: 'Krita Expert', external_id: 'turing:krita-expert', referral_url: null, description: 'One line.' }]
  });
  const server = await withAgentServer(db);
  try {
    const first = await agentCall(server.base, 'POST', '/api/agent/runs/run-batch/result', {
      token: created.token,
      body: { captures: [{ title: 'Krita Expert', externalId: 'turing:krita-expert', referralUrl: 'https://www.turing.com/jobs/krita?ref=a', content: 'x'.repeat(900) }] }
    });
    eq('a batch is accepted while the run is still open', first.status, 200);
    eq('and the run stays open, so another batch can follow', openRun.status, 'running');

    const finished = await agentCall(server.base, 'POST', '/api/agent/runs/run-batch/finish', {
      token: created.token,
      body: { done: 1, ok: 1, failed: 0, total: 1 }
    });
    eq('finishing closes it', finished.status, 200);
    eq('as succeeded when everything landed', finished.body?.run?.status, 'succeeded');
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// "Will collection ever create the same offer twice?"
// ---------------------------------------------------------------------------
//
// The tenant's question, asked after 120 offers and three captures. It deserves rules and tests
// rather than reassurance: no, for four independent reasons — and the last one holds even when
// the first three are wrong.
{
  const BASE_OFFERS = [{ id: 'x', title: 'Existing Role', slug: 'acme-micro1-existing-role', external_id: 'micro1:aaa' }];
  const capture = (over = {}) => ({ title: 'New Role', jobId: 'bbb', externalId: 'micro1:bbb', referralUrl: 'https://micro1.ai/post/bbb', ...over });

  // The listing is de-duplicated across pages before anything is clicked (mergeMicro1Pages,
  // proved in test:micro1).

  // Within one batch, the same slug is planned once.
  {
    const db = fakeOfferDb();
    const applied = await applyCaptures({
      supabase: db,
      tenant: { id: 'tenant-1', slug: 'acme' },
      offers: [], sourceSlug: 'micro1',
      captures: [capture(), capture()],
      verify: async () => ({ verdict: 'match' })
    });
    eq('one role captured twice in a batch creates one offer', applied.inserted, 1);
    eq('and the second is reported, not silently dropped',
      applied.skipped.some((row) => row.reason === 'duplicate_in_batch'), true);
    eq('nothing was written twice', db.rows.length, 1);
  }

  // A role the tenant already owns is skipped by id, then by slug, then by title — so a
  // re-capture on a fresh day cannot duplicate what yesterday's run brought in.
  {
    const db = fakeOfferDb();
    const applied = await applyCaptures({
      supabase: db,
      tenant: { id: 'tenant-1', slug: 'acme' },
      offers: [
        { id: 'a', title: 'Existing Role', slug: 'acme-micro1-existing-role', external_id: 'micro1:aaa' },
        { id: 'b', title: 'Slug Match', slug: 'acme-micro1-slug-match', external_id: 'micro1:old' },
        // A hand-made offer: the tenant typed this one in, so its slug has no marketplace.
        { id: 'c', title: 'Air Traffic Controller', slug: 'air-traffic-controller', external_id: null }
      ],
      sourceSlug: 'micro1',
      captures: [
        capture({ title: 'Existing Role', jobId: 'aaa', externalId: 'micro1:aaa' }),
        capture({ title: 'Slug Match', jobId: 'new', externalId: 'micro1:new' }),
        capture({ title: 'Air Traffic Controller', jobId: 'atc', externalId: null })
      ],
      verify: async () => ({ verdict: 'match' })
    });
    eq('re-running a capture inserts nothing that already exists', applied.inserted, 0);
    eq('and says which key matched',
      applied.skipped.map((row) => row.reason).sort(),
      ['exists', 'exists_by_external_id', 'exists_by_title']);
    eq('the database received no rows at all', db.rows.length, 0);
  }

  // The backstop: even with a *stale* picture of what exists (an empty `offers` list, a second
  // machine, a run that began before another finished) the unique slug index refuses the
  // duplicate. That used to lose the whole batch; now the new rows land and the conflicts are
  // reported — no duplicates, and no silent loss either.
  {
    const rows = [];
    let batchAttempts = 0;
    const db = {
      rows,
      from: () => ({
        insert(list) {
          const batch = Array.isArray(list) ? list : [list];
          if (batch.length > 1) {
            batchAttempts += 1;
            return { select: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "opportunities_slug_key"' } }) };
          }
          const row = batch[0];
          if (rows.some((existing) => existing.slug === row.slug)) {
            return { select: async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }) };
          }
          rows.push(row);
          return { select: async () => ({ data: [{ id: `offer-${rows.length}`, title: row.title, slug: row.slug }], error: null }) };
        },
        select() { const query = { eq: () => query, then: (resolve) => resolve({ data: rows, error: null }) }; return query; }
      })
    };
    const applied = await applyCaptures({
      supabase: db,
      tenant: { id: 'tenant-1', slug: 'acme' },
      offers: [],
      sourceSlug: 'micro1',
      captures: [capture({ title: 'Role A', jobId: 'a', externalId: 'micro1:a' }), capture({ title: 'Role B', jobId: 'b', externalId: 'micro1:b' })],
      verify: async () => ({ verdict: 'match' })
    });
    eq('a refused batch is retried row by row', batchAttempts, 1);
    eq('every distinct role still lands', applied.inserted, 2);
    eq('exactly two rows exist, so nothing was duplicated', rows.length, 2);
  }
}

// ---------------------------------------------------------------------------
// Turing on demand: a capture may *update* offers the tenant already has
// body for roles that are already imported — inserting those would duplicate 78 offers. The
// server therefore has two write paths, and the update path holds the same line as everything
// else here: a link is written only if it resolves to its own role, and only into an offer that
// has no link yet.
{
  const OFFERS = [
    { id: 'o1', title: 'Krita Expert', external_id: 'turing:krita-expert', referral_url: null, description: 'One line.' },
    { id: 'o2', title: 'Already Linked Role', external_id: 'turing:already-linked-role', referral_url: 'https://www.turing.com/jobs/a?ref=first', description: 'One line.' },
    { id: 'o3', title: 'Krita Expert (duplicate)', external_id: 'turing:krita-expert-duplicate', referral_url: null, description: 'One line.' }
  ];
  const CAPTURES = [
    {
      title: 'Krita Expert',
      externalId: 'turing:krita-expert',
      referralUrl: 'https://www.turing.com/jobs/krita?ref=abc',
      content: 'x'.repeat(900)
    },
    {
      title: 'Already Linked Role',
      externalId: 'turing:already-linked-role',
      referralUrl: 'https://www.turing.com/jobs/other?ref=zzz',
      content: 'y'.repeat(900)
    }
  ];

  const writes = [];
  const fakeDb = {
    from: () => ({
      update: (patch) => ({
        eq: (column, value) => {
          const record = { id: value, patch };
          const result = { data: [{ id: value }], error: null };
          return {
            is: () => ({ select: async () => { writes.push(record); return result; } }),
            select: async () => { writes.push(record); return result; }
          };
        }
      })
    })
  };

  const applied = await applyCaptureUpdates({
    supabase: fakeDb,
    offers: OFFERS,
    captures: CAPTURES,
    verify: async () => ({ verdict: 'match', reason: 'title_plus_marketing_tail' })
  });

  eq('a link is attached to the offer that has none', applied.links.updated, 1);
  eq('and the offer that already had one is untouched', writes.filter((row) => row.id === 'o2' && row.patch.referral_url).length, 0);
  ok('the refusal says why, and names the conflict rather than hiding it',
    [...(applied.links.skipped || []), ...(applied.links.conflicts || [])]
      .some((row) => /already_linked|already_has_a_different_link/.test(row.reason)));

  // A rejected link must carry what the server actually saw. On 2026-11-04 a 120-role Turing run
  // attached zero links and the only output was `unverified_mismatch` a hundred times, which is a
  // dead end for the tenant and for us.
  const mismatched = await applyCaptureUpdates({
    supabase: fakeDb,
    offers: OFFERS,
    captures: CAPTURES,
    verify: async () => ({ verdict: 'mismatch', reason: 'title_differs', resolvedTitle: 'Sign in | Turing' })
  });
  const refused = (mismatched.links.skipped || []).find((row) => row.reason === 'unverified_mismatch');
  ok('a refused link names the title it resolved to', refused?.resolvedTitle === 'Sign in | Turing');
  ok('and the reason the verifier gave', refused?.detail === 'title_differs');
  // Both roles brought a real body, and both summaries were one line: the body wins either way.
  eq('the body replaces the one-line summary', applied.descriptions.updated, 2);
  ok('and every written link was verified first',
    applied.links.verification.every((row) => row.verdict === 'match'));

  // A link that does not resolve to its own role is dropped before anything is written — the
  // same rule the Micro1 path uses, because the consequence is identical.
  const rejectedWrites = [];
  const rejected = await applyCaptureUpdates({
    supabase: {
      from: () => ({
        update: (patch) => ({
          eq: () => ({
            is: () => ({ select: async () => { rejectedWrites.push(patch); return { data: [], error: null }; } }),
            select: async () => { rejectedWrites.push(patch); return { data: [], error: null }; }
          })
        })
      })
    },
    offers: OFFERS,
    captures: [CAPTURES[0]],
    verify: async () => ({ verdict: 'mismatch', reason: 'different_role' })
  });
  eq('an unverified link is never written', rejected.links.updated, 0);
  eq('and the link never reached the database', rejectedWrites.filter((patch) => patch.referral_url).length, 0);

  // Agent mode is the reason any of this can happen on the tenant's machine.
  const turingRunner = fs.readFileSync(path.join(root, 'scripts', 'browser_actor_referrals.mjs'), 'utf8');
  ok('the Turing runner has agent mode', /--agent-api/.test(turingRunner) && /agent_context_refused/.test(turingRunner));
  ok('it fetches identity and known offers from the portal, not from a local guess',
    /\/api\/agent\/runs\/\$\{encodeURIComponent\(String\(runIdFlag\)\)\}\/context/.test(turingRunner));
  ok('and it posts the result instead of writing to the database',
    /\/api\/agent\/runs\/\$\{encodeURIComponent\(runId\)\}\/result/.test(turingRunner));
  ok('while its supabase import stays lazy, so a bundle without node_modules still runs',
    /await import\('@supabase\/supabase-js'\)/.test(turingRunner));
  // A four-minute run must not be all-or-nothing: it banks every twentieth link, and closes the
  // run itself once at the end (the portal no longer closes it on /result).
  ok('the Turing runner banks links in batches while it works',
    /AGENT_BATCH = 20/.test(turingRunner) && /onBatch\(captures\)/.test(turingRunner));
  ok('and closes the run itself, because /result no longer does',
    /finishRunTracking\(\{[\s\S]{0,240}status: flush\.ok/.test(turingRunner));

  // 2026-11-04: a 120-role run posted all of itself at once (~400 KB), Express answered
  // 413 PayloadTooLargeError, and the run closed with 120/120 captured and nothing written.
  // Now the payload is incremental, chunked, and split again if the server still says 413.
  ok('the payload is incremental, not the whole run every time',
    /postedCount/.test(turingRunner) && /from: postedCount/.test(turingRunner));
  ok('chunks are bounded', /AGENT_POST_CHUNK = 15/.test(turingRunner) && /slice\(index, index \+ AGENT_POST_CHUNK\)/.test(turingRunner));
  ok('and a 413 splits the chunk instead of losing it',
    /res\.status === 413 && chunk\.length > 1/.test(turingRunner) && /splitting/.test(turingRunner));
  const serverSrcForLimit = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  ok('the portal gives agent routes room for a real capture body',
    /app\.use\('\/api\/agent', express\.json\(\{ limit: '12mb' \}\)\)/.test(serverSrcForLimit));
  ok('the Micro1 runner chunks too, so a 70-role run cannot hit the same wall',
    /const CHUNK = 20;/.test(fs.readFileSync(path.join(root, 'scripts', 'browser_actor_micro1.mjs'), 'utf8'))
    && /captures\.slice\(index, index \+ CHUNK\)/.test(fs.readFileSync(path.join(root, 'scripts', 'browser_actor_micro1.mjs'), 'utf8')));

  const micro1Runner = fs.readFileSync(path.join(root, 'scripts', 'browser_actor_micro1.mjs'), 'utf8');
  ok('the Micro1 runner closes its own run for the same reason',
    /if \(agentMode\) \{[\s\S]{0,240}finishRunTracking\(\{/.test(micro1Runner));

  // A typo took every Micro1 run down on 2026-11-03: `$advanced` where `advanced` was meant, and
  // the run died after the listing had already been read. A `$name.` sequence outside a template
  // placeholder is never intentional, so this is cheap to forbid across every script and module.
  const { execFileSync } = await import('node:child_process');
  const files = execFileSync('git', ['ls-files', '*.mjs', '*.js'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => (file.startsWith('scripts/') || file.startsWith('utils/') || file.startsWith('routes/')))
    // Test files are excluded on purpose: this very comment names the typo it forbids.
    .filter((file) => !/\/test_|^scripts\/test_/.test(file))
    // A file deleted in the working tree is still in the index until it is staged, and reading it
    // would crash the suite for a reason that has nothing to do with the typo it is looking for.
    .filter((file) => fs.existsSync(path.join(root, file)));
  const dollarTypos = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (/\$[A-Za-z_]\w*\./.test(text)) dollarTypos.push(file);
  }
  ok('no script or module has a $variable typo (the class of bug that killed every Micro1 run)',
    dollarTypos.length === 0);
  if (dollarTypos.length) console.error(`      ${dollarTypos.join(', ')}`);
}


//
// Shipped 2026-11-02 and failed on apply: forty lines of explanation had been appended to the
// pairing migration without comment markers, so the editor stopped at
// `syntax error at or near "Pasting"` and the table was never created. A file that only the
// database can validate is a file nobody validates — so this reads every migration the way
// the editor would, and only accepts lines that are SQL or comments.
{
  const dir = path.join(root, 'migrations');
  const offenders = [];
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.sql'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    text.split('\n').forEach((line, index) => {
      const code = line.replace(/--.*$/, '').trim();
      if (!code) return;
      if (/^(\/\*|\*|'|"|\(|\))/.test(code)) return;
      // SQL keywords are written upper or lower case; a title-case word at the start of a
      // line is prose that lost its `--`.
      if (/^[A-Z][a-z]/.test(code)) offenders.push(`${name}:${index + 1} ${code.slice(0, 40)}`);
    });
  }
  ok('every migration line is either SQL or a comment', offenders.length === 0);
  if (offenders.length) console.error(`      ${offenders.slice(0, 5).join('\n      ')}`);

  const pairing = fs.readFileSync(path.join(dir, '2026-11-02_browser_pairings.sql'), 'utf8');
  ok('the pairing migration creates the table it is named for',
    /CREATE TABLE IF NOT EXISTS public\.browser_actor_pairings/.test(pairing));
  ok('and is hash-only, like the tokens', /code_hash\s+text NOT NULL UNIQUE/.test(pairing));
}


// An abandoned run must not turn "Capture now" into a 500
// ---------------------------------------------------------------------------

{
  // `canQueue` ignores a run whose heartbeat stopped; the partial unique index does not. So a
  // dead 'running' row blocked the insert with 23505 and the tenant got a 500 — a server
  // fault for a leftover row.
  const db = fakeCaptureDb(localAccess);
  db.runs.push({
    id: 'run-stale',
    tenant_id: 'site-1',
    // A leftover *Micro1* capture: this is the slot the portal capture uses, so it is the one
    // that has to be cleared before a fresh capture can queue.
    kind: 'micro1',
    status: 'running',
    started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    heartbeat_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    done_items: 3,
    ok_items: 2,
    failed_items: 1,
    total_items: 12
  });
  const server = await withCaptureServer({ db, spawnRun: () => { throw new Error('should not spawn'); } });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1' });
    eq('an abandoned run does not block a new capture', res.status, 202);
    eq('and the abandoned run is closed as failed first',
      db.runs.find((row) => row.id === 'run-stale')?.status, 'failed');
    ok('with a message that explains it',
      /stopped reporting/.test(db.runs.find((row) => row.id === 'run-stale')?.message || ''));
    eq('and a fresh run is queued', db.runs.filter((row) => row.status === 'queued').length, 1);
  } finally {
    await server.close();
  }
}

{
  // A second tab queueing at the same moment: the index fires, and that is a conflict to
  // report, not a 500.
  const db = fakeCaptureDb(localAccess);
  const originalFrom = db.from.bind(db);
  db.from = (table) => {
    const api = originalFrom(table);
    if (table !== 'browser_actor_runs') return api;
    return {
      ...api,
      insert: () => {
        throw Object.assign(new Error('duplicate key value violates unique constraint "uq_browser_actor_runs_active"'), { code: '23505' });
      }
    };
  };
  const server = await withCaptureServer({ db, spawnRun: () => { throw new Error('should not spawn'); } });
  try {
    const res = await call(server.base, 'POST', '/tenant/blogger/browser-access/capture', { platform: 'micro1' });
    eq('a duplicate-key race is a 409, not a 500', res.status, 409);
    ok('and says what to do', /try again/i.test(res.body?.error || ''));
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Which marketplace a run is for — and therefore who may run it
// ---------------------------------------------------------------------------

{
  // The worker used to run the Micro1 capture for every run it claimed. A Turing run would
  // have been captured against the wrong marketplace and looked like a success.
  eq('a portal capture run says it is micro1', runPlatform({ kind: 'referrals', detail: { platform: 'micro1' } }), 'micro1');
  eq('a writer-flow referrals run is a Turing run', runPlatform({ kind: 'referrals' }), 'turing');
  eq('an explicit platform wins over the kind', runPlatform({ kind: 'referrals', platform: 'turing' }), 'turing');
  eq('a collect run has no platform', runPlatform({ kind: 'collect' }), '');
  ok('the worker may drive a micro1 run', canRunOnWorker({ kind: 'referrals', detail: { platform: 'micro1' } }));
  // Since 2026-11-03 the Turing runner has agent mode too, so one worker drives both markets —
  // one at a time, because each run is its own row and claims are exclusive.
  ok('and a Turing run as well', canRunOnWorker({ kind: 'referrals' }));
  ok('but not one it cannot identify', !canRunOnWorker({ kind: 'collect' }));

  const workerSrc = fs.readFileSync(path.join(root, 'scripts', 'browser_actor_worker.mjs'), 'utf8');
  ok('and it picks the script by platform, never by a default',
    /SCRIPT_BY_PLATFORM = Object\.freeze\(\{[\s\S]{0,260}micro1:[\s\S]{0,160}turing:[\s\S]{0,160}linkedin:/.test(workerSrc)
    && /const script = scriptPath\(platform\)/.test(workerSrc));
  ok('and refuses a platform it has no runner for instead of defaulting to Micro1',
    /if \(!relative \|\| !script \|\| !fs\.existsSync\(script\)\)[\s\S]{0,220}return Promise\.resolve\(\{ code: 1, reason \}\)/.test(workerSrc));
  // Claiming a run whose runner file is missing is how a listen run sat in "running" until the
  // tenant cancelled it. The claim itself now requires the file.
  ok('and will not claim a run it cannot actually run',
    /function canRunHere\(run\) \{[\s\S]{0,320}scriptAvailable\(platform\)/.test(workerSrc)
    && /warnMissingRunner\(platform\)/.test(workerSrc));
  ok('the child\'s last fault is carried to the portal, not just its exit code',
    /stdout\.on\('data', keep\)/.test(workerSrc) && /lastProblemLine\(tail\)/.test(workerSrc)
    && /closeAbandonedRun\(run\.id, code\.code, code\.reason\)/.test(workerSrc));
  // Every social network runs the same listener, told which site to read.
  const runArgsSrc = fs.readFileSync(path.join(root, 'utils', 'browserActor', 'runArgs.js'), 'utf8');
  ok('all five networks dispatch to the one listener',
    ['linkedin', 'x', 'facebook', 'reddit', 'youtube'].every((id) => new RegExp(`${id}: SOCIAL_LISTENER`).test(workerSrc))
    && /'--platform', String\(platform\)/.test(runArgsSrc));
  // The 13:49 run claimed `(x)` and the child ran `platform=linkedin`, and the log line claimed
  // `--platform x` anyway: it printed an intention, not the argv. Now it prints the argv.
  ok('and the window says exactly what it launched',
    /console\.error\(`spawn: \$\{\[path\.basename\(args\[0\]\), \.\.\.args\.slice\(1\)\]\.join\(' '\)\}/.test(workerSrc));
  ok('and is bounded by searches rather than by roles',
    /'--queries'/.test(runArgsSrc) && !/'--per-query'/.test(runArgsSrc));
  ok('the bundle carries the Turing runner it dispatches to',
    buildWorkerBundle({ apiBase: 'https://portal.example' }).entries.some((entry) => entry.name === 'scripts/browser_actor_referrals.mjs'));
  ok('and the social listener too, with its per-network descriptions',
    buildWorkerBundle({ apiBase: 'https://portal.example' }).entries
      .some((entry) => entry.name === 'scripts/browser_actor_social_listen.mjs'));
  ok('the worker filters the queue before claiming', /queued\.find\(canRunHere\)/.test(workerSrc));
  ok('and says which runs it is leaving alone', /drives Micro1 only/.test(workerSrc));
  ok('and that saying it once is enough', /lastSkipSignature/.test(workerSrc) && /lastIdleSignature/.test(workerSrc));

  const dashSrc = fs.readFileSync(path.join(root, 'admin', 'tenant_dashboard.html'), 'utf8');
  // The two marketplaces moved into their own cards, because one button row could not say
  // which button needed a worker or which one had failed. The buttons are still named for
  // what they do, and each card says where its run happens.
  ok('each marketplace card names its own capture button',
    /Capture Micro1 links/.test(dashSrc) && /Capture links<\/button>/.test(dashSrc)
    && /Fill descriptions<\/button>/.test(dashSrc));
  ok('and a marketplace with a live run cannot be queued twice from the panel',
    /const busy = Boolean\(state && state\.active\)/.test(dashSrc)
    && /already running for this marketplace/.test(dashSrc));
  ok('and a tenant can tell the two jobs apart by what a run costs',
    /your worker has to be running/.test(dashSrc)
    && /one marketplace at a time/.test(dashSrc));
  ok('an unconnected tenant is told why the Micro1 button is missing',
    /appears here\s+once you connect one/.test(dashSrc));
}

// ---------------------------------------------------------------------------
// A tenant with no browser must be told, not left to discover it through a 409
// ---------------------------------------------------------------------------

{
  const created = createAgentToken({ label: 'nomap' });
  const runs = [{ id: 'run-nomap', tenant_id: 'tenant-1', status: 'queued', kind: 'referrals', platform: 'micro1', detail: {} }];
  const tokens = [{ id: 'tok-nomap', tenant_id: 'tenant-1', token_hash: created.tokenHash, token_prefix: created.tokenPrefix, revoked_at: null }];
  const db = fakeAgentDb({ runs, tokens });
  const server = await withAgentServer(db);
  const beforeProfiles = process.env.BROWSER_ACTOR_PROFILES;
  const beforeDefault = process.env.BROWSER_ACTOR_DEFAULT_ENV_ID;
  try {
    // Production hit exactly this: no browserAccess on the tenant, no env map entry, no
    // default — and the 409 said "No browser is mapped to tenant", which tells a tenant
    // nothing they can act on.
    delete process.env.BROWSER_ACTOR_PROFILES;
    delete process.env.BROWSER_ACTOR_DEFAULT_ENV_ID;
    const res = await agentCall(server.base, 'GET', '/api/agent/runs/run-nomap/context', { token: created.token });
    eq('a run with no browser is refused', res.status, 409);
    ok('and the message says what to do about it',
      /connect (a|your) morelogin profile|map a hosted profile|add the tenant to BROWSER_ACTOR_PROFILES/i.test(res.body?.error || ''));
  } finally {
    if (beforeProfiles === undefined) delete process.env.BROWSER_ACTOR_PROFILES;
    else process.env.BROWSER_ACTOR_PROFILES = beforeProfiles;
    if (beforeDefault === undefined) delete process.env.BROWSER_ACTOR_DEFAULT_ENV_ID;
    else process.env.BROWSER_ACTOR_DEFAULT_ENV_ID = beforeDefault;
    await server.close();
  }

  const dashSrc = fs.readFileSync(path.join(root, 'admin', 'tenant_dashboard.html'), 'utf8');
  ok('the panel warns when no browser is resolved for the tenant',
    /d\.runSource === 'none'/.test(dashSrc) && /a capture queues and nothing can run it/.test(dashSrc));

  // Listening (2026-11-04): the card has to be able to say three different things — never run,
  // not set up, and nothing matched — because only one of those is about the market.
  ok('the panel renders a listening block inside collection control',
    /function wfListeningHtml/.test(dashSrc) && /\$\{wfListeningHtml\(d\)\}/.test(dashSrc));
  ok('with a button that queues a listen run, not a capture',
    /data-wfact="queue" data-kind="listen"/.test(dashSrc));
  // One row per network, each with its own link and its own button, all from the server's list.
  ok('the panel renders the network list the server sends, not a hand-written one',
    /const networks = Array\.isArray\(listening\.networks\) \? listening\.networks : \[\]/.test(dashSrc)
    && /networks\.map\(\(network\) =>/.test(dashSrc));
  ok('and every network row carries its own button and its own link',
    /data-wfact="queue" data-kind="listen"[\s\S]{0,120}data-platform="\$\{esc\(network\.id\)\}"/.test(dashSrc)
    && /href="\$\{esc\(network\.homeUrl\)\}"/.test(dashSrc));
  ok('the button names the network it will read',
    /Start on \$\{esc\(network\.name\)\}/.test(dashSrc));
  // The first version returned the "not set up" card *before* drawing the button, so the tenant
  // saw an amber sentence and concluded the feature did not exist.
  ok('the button is drawn in every state, including "not set up"',
    dashSrc.indexOf('const startButton') < dashSrc.indexOf('if (notDeployed || notSetUp)')
    && /\$\{networkRows\}/.test(dashSrc));
  ok('and each state that cannot run says why, in words',
    /Apply \$\{listening\.needsMigration \|\| 'migrations\/2026-11-04_social_signals\.sql'\} first/.test(dashSrc)
    && /No browser of yours is connected yet, so this button would do nothing/.test(dashSrc));
  // A server older than the panel omits `listening` entirely. Calling that "nothing matched" would
  // blame the market for our own deployment, so it is its own state.
  ok('a server that predates the feature is reported as such, not as a quiet week',
    /const notDeployed = !Object\.prototype\.hasOwnProperty\.call\(d \|\| \{\}, 'listening'\)/.test(dashSrc)
    && /This portal build does not report listening yet/.test(dashSrc));
  ok('and it distinguishes "not set up" from "nothing matched"',
    /Listening is not set up yet/.test(dashSrc) && /No post has matched one of your intents yet/.test(dashSrc));
  ok('the card shows the score with its evidence, and never claims to have sent anything',
    /showing the \$\{items\.length\} strongest/i.test(dashSrc)
    && /Reading only: nobody was messaged by this system/.test(dashSrc));
  ok('each signal names the network and what to do there',
    /Do this: \$\{esc\(network\.actionHint\)\}/.test(dashSrc));
  ok('the listening actions are wired, so a click is never silent',
    /act === 'signal-copy'/.test(dashSrc) && /act === 'signal-status'/.test(dashSrc)
    && /async function wfSetSignalStatus/.test(dashSrc));
  ok('and the network chosen by the button reaches the queue request',
    /wfQueueRun\(btn\.dataset\.kind \|\| 'referrals'[\s\S]{0,60}btn\.dataset\.platform/.test(dashSrc)
    && /\.\.\.\(platform \? \{ platform \} : \{\}\)/.test(dashSrc));
}

// The frozen Turing run, reproduced and fixed (2026-11-04).
//
// A 120-role run carrying full job bodies was one ~400 KB request. Express's default JSON ceiling
// answered **413 PayloadTooLargeError**, the worker saw a refusal, closed the run as failed, and
// every link minted in that run died with it. What prevents a repeat is the parser order: the
// agent parser (12 MB) is mounted *before* the global one, and body-parser skips a body that is
// already parsed — so the ceiling that matters for `/api/agent` is the big one.
{
  const app = express();
  app.use('/api/agent', express.json({ limit: '12mb' }));
  app.use(express.json());
  app.post('/api/agent/runs/:id/result', (req, res) => res.json({ ok: true, captures: (req.body?.captures || []).length }));
  app.post('/anything-else', (req, res) => res.json({ ok: true }));
  // Express's default handler prints the 413 stack to stderr; this reproduction is *expected*
  // to be refused, so answer it quietly. Without this the suite looks like it just froze a run.
  app.use((err, req, res, next) => {
    res.status(err?.status || err?.statusCode || 500).json({ error: err?.message || 'request failed' });
  });
  const srv = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });

  const payload = JSON.stringify({
    captures: Array.from({ length: 120 }, (_, i) => ({ title: `Role ${i}`, content: 'x'.repeat(3300) }))
  });
  const post = (route) => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: srv.address().port,
      path: route,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end(payload);
  });

  ok('a full Turing batch is about the size that arrived as a 413',
    payload.length > 380000 && payload.length < 500000);
  const agent = await post('/api/agent/runs/run-1/result');
  eq('agent routes take a whole capture batch', agent.status, 200);
  eq('and all 120 captures arrive in one piece', JSON.parse(agent.text).captures, 120);
  const other = await post('/anything-else');
  eq('every other route keeps the small ceiling, so nothing else got looser', other.status, 413);
  await new Promise((resolve) => srv.close(resolve));

  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const agentAt = serverSource.indexOf("app.use('/api/agent', express.json({ limit: '12mb' }))");
  const globalAt = serverSource.indexOf('app.use(express.json({');
  ok('server.js mounts the bigger parser before the global one', agentAt > 0 && globalAt > agentAt);
}

// ---------------------------------------------------------------------------
// Listening: the worker sends posts, the portal decides what they mean
// ---------------------------------------------------------------------------

{
  const created = createAgentToken({ label: 'listen' });
  const runs = [{ id: 'run-listen', tenant_id: 'tenant-1', kind: 'listen', status: 'queued', detail: { limit: 3, platform: 'linkedin' } }];
  const tokens = [{ id: 'tok-listen', tenant_id: 'tenant-1', token_hash: created.tokenHash, token_prefix: created.tokenPrefix, revoked_at: null }];
  const db = fakeAgentDb({ runs, tokens, signals: [] });
  const server = await withAgentServer(db);
  const beforeProfiles = process.env.BROWSER_ACTOR_PROFILES;
  try {
    // A context needs a browser for this tenant; the operator's own hosted profile is enough.
    process.env.BROWSER_ACTOR_PROFILES = JSON.stringify({ acme: '123456789' });
    const context = await agentCall(server.base, 'GET', '/api/agent/runs/run-listen/context', { token: created.token });
    eq('a listen run is told which searches to run', Array.isArray(context.body?.queries) ? context.body.queries.length : 0, 6);
    ok('and every search names an intent from the taxonomy',
      (context.body?.queries || []).every((row) => row.phrase && row.intentId));
    eq('a listener is not sent the tenant’s 132 offers', (context.body?.known || []).length, 0);
    eq('and the platform is linkedin, so the worker dispatches the listener', context.body?.sourceSlug, 'linkedin');

    const posts = [
      // A real inquiry: trigger phrase, budget, timeline, Nairobi, a phone number, a buyer title.
      {
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7001/',
        postText: 'Our operations manager is looking for a car for the fleet — budget KES 2.8M, need it this month. WhatsApp 0712 345 678.',
        authorName: 'Jane Wanjiru',
        authorHandle: 'jane-w'
      },
      // The same words, but a job advert: the exclusion phrase is the whole point.
      {
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7002/',
        postText: 'Job vacancy: driver wanted. Need a vehicle licence, urgent. Dealer ad follows.',
        authorName: 'Fleet Recruiters'
      },
      // Nothing we sell.
      {
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7003/',
        postText: 'Lovely sunset over Nairobi today, grateful for this city.',
        authorName: 'Sunset Photos'
      }
    ];
    // A worker that tries to rank its own find: the score must come from the taxonomy, not from here.
    const scored = await agentCall(server.base, 'POST', '/api/agent/runs/run-listen/signals', {
      token: created.token,
      body: { posts: posts.map((post) => ({ ...post, intentScore: 100, score: 100 })) }
    });
    eq('the portal accepts the batch', scored.status, 200);
    eq('one post was worth storing', scored.body?.stored, 1);
    eq('the job advert was excluded, not stored', scored.body?.dropped?.excluded, 1);
    eq('and the sunset was off-topic', scored.body?.dropped?.notRelevant, 1);
    eq('exactly one signal exists for the tenant', db.signals.length, 1);
    const stored = db.signals[0];
    eq('the stored score is computed here', stored.intent_score === 100, false);
    ok('the score is high enough to act on', Number(stored.intent_score) >= 65);
    eq('the intent is the one the phrases belong to', stored.intent_id, 'vehicle_purchase');
    ok('the evidence is kept with the score',
      Array.isArray(stored.trigger_hits) && stored.trigger_hits.includes('looking for a car'));
    eq('the phone number is normalised for WhatsApp', stored.contact_phone, '+254712345678');
    ok('and a first line is drafted for a human to send', /saw your post about/i.test(stored.draft_first_line || ''));
    eq('the run stays open for the next batch', (scored.body?.run?.status || 'queued') !== 'succeeded', true);

    // Running the same search twice must not double the digest.
    const again = await agentCall(server.base, 'POST', '/api/agent/runs/run-listen/signals', {
      token: created.token,
      body: { posts: [posts[0]] }
    });
    eq('a repeat of the same post is not stored twice', again.body?.stored, 0);
    eq('and is reported as already known', again.body?.duplicates, 1);
    eq('the table still holds one row', db.signals.length, 1);

    // A hostile body: a javascript: permalink, a stub of text, and the same post twice.
    const hostile = await agentCall(server.base, 'POST', '/api/agent/runs/run-listen/signals', {
      token: created.token,
      body: {
        posts: [
          { postUrl: 'javascript:alert(1)', postText: 'looking for a car and a van, budget KES 900000, urgent' },
          { postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7004/', postText: 'short' },
          { postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7005/', postText: 'We need a vehicle for our logistics team this week, budget KES 1.2M. Call me on 0722 111 222.' },
          { postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7005/', postText: 'We need a vehicle for our logistics team this week, budget KES 1.2M. Call me on 0722 111 222.' }
        ]
      }
    });
    eq('a non-web permalink is dropped', hostile.body?.stored, 1);
    eq('and the duplicate inside the batch is not counted twice', db.signals.length, 2);

    // A closed run can never be written to, or a retry would double-insert.
    runs[0].status = 'succeeded';
    const closed = await agentCall(server.base, 'POST', '/api/agent/runs/run-listen/signals', {
      token: created.token,
      body: { posts: [posts[2]] }
    });
    eq('a finished run refuses new signals', closed.status, 409);
  } finally {
    if (beforeProfiles === undefined) delete process.env.BROWSER_ACTOR_PROFILES;
    else process.env.BROWSER_ACTOR_PROFILES = beforeProfiles;
    await server.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);










