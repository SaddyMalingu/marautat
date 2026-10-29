// Regression test for tenant portal sessions that survive a deploy (2026-10-29).
//
// The portal kept sessions in `const tenantSessions = new Map()` (server.js). On
// Render every deploy is a new process, so the Map booted empty and every
// signed-in client was bounced to the sign-in form mid-session. The deploy log
// of 2026-10-29 19:24 shows it exactly: three 401s, then a fresh
// `POST /tenant/session/login`.
//
// A token now carries its own session, signed with HMAC-SHA256, so the server
// can validate one it has never stored. This runs the real helpers — the signing,
// the verification, and the decision function lifted out of server.js — and
// checks the properties that keep auth safe: tamper-proof, expiry enforced, no
// key means no regression, logout still immediate.
//
//   node scripts/test_tenant_session_persistence.mjs
import fs from 'fs';
import vm from 'vm';
import { execFileSync } from 'child_process';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const server = fs.readFileSync('server.js', 'utf8');
const moduleSrc = fs.readFileSync('utils/tenantSession.js', 'utf8');
const { signTenantSession, verifyTenantSession, TENANT_SESSION_COOKIE } =
  await import(new URL('../utils/tenantSession.js', import.meta.url).href);

// ---- 1. The module does what it claims ------------------------------------
const SECRET = 'test-secret-not-a-real-key';
// Relative to the clock, because section 3 runs the real reader, which compares
// the payload expiry against Date.now().
const now = Date.now();
const session = { tenantId: 'tenant-1', tenantPhone: '254700000001', tenantName: 'Malingu Ventures', expiresAt: now + 3600_000 };

const token = signTenantSession(session, SECRET, now);
ok('a session signs to a token', typeof token === 'string' && token.split('.').length === 3, token.slice(0, 24));
ok('the token is versioned', token.startsWith('v1.'));
ok('the payload is not the secret', !token.includes(SECRET));

const back = verifyTenantSession(token, SECRET, now);
ok('the token verifies without any stored session', !!back);
ok('the tenant comes back intact', back && back.tenantId === 'tenant-1' && back.tenantPhone === '254700000001');
ok('the name comes back intact', back && back.tenantName === 'Malingu Ventures');
ok('the expiry comes back intact', back && back.expiresAt === session.expiresAt);

// ---- 2. The properties that make it safe to trust a stranger's token ------
const [v, payload, mac] = token.split('.');
const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
const forged = 'v1.' + Buffer.from(JSON.stringify({ ...decoded, t: 'tenant-2' })).toString('base64url') + '.' + mac;
ok('changing the tenant id breaks the signature', verifyTenantSession(forged, SECRET, now) === null);
ok('a different key is rejected', verifyTenantSession(token, 'some-other-key', now) === null);
ok('an expired token is rejected', verifyTenantSession(token, SECRET, now + 3600_001) === null);
ok('a token is accepted right up to its expiry', !!verifyTenantSession(token, SECRET, now + 3600_000 - 1));
ok('truncated tokens are rejected', verifyTenantSession('v1.' + payload, SECRET, now) === null);
ok('garbage is rejected', verifyTenantSession('not-a-token', SECRET, now) === null);
ok('an empty token is rejected', verifyTenantSession('', SECRET, now) === null);
ok('a missing key rejects everything', verifyTenantSession(token, '', now) === null);
ok('a missing key refuses to sign, so behaviour falls back to memory', signTenantSession(session, '', now) === '');
ok('an already-expired session is not signed at all', signTenantSession({ ...session, expiresAt: now - 1 }, SECRET, now) === '');
ok('a session with no tenant id is not signed', signTenantSession({ ...session, tenantId: '' }, SECRET, now) === '');
ok('the signature is compared in constant time', /crypto\.timingSafeEqual/.test(moduleSrc));

// ---- 3. Real wiring: the decision function out of server.js ---------------
// The claim to prove is "a token the process has never seen is accepted after a
// restart". That is readTenantSession()'s job, so run the real one with an empty
// memory — which is exactly the state of a freshly booted server.
const start = server.indexOf('function readTenantSession(');
const end = server.indexOf('\n}', start);
ok('readTenantSession exists in server.js', start > -1 && end > start);

const memory = new Map();
const revoked = new Map();
const ctx = {
  tenantSessions: memory,
  revokedTenantTokens: revoked,
  cleanupExpiredTenantSessions: () => {},
  verifyTenantSession,
  tenantSessionSecret: () => SECRET,
  Date,
  String,
  console,
};
vm.createContext(ctx);
vm.runInContext(server.slice(start, end + 2), ctx);

const afterRestart = ctx.readTenantSession(token);
ok('a token from before the restart opens the portal', !!afterRestart, JSON.stringify(afterRestart));
ok('the restarted process holds no session in memory', memory.size === 0);
ok('an unknown token is still refused', ctx.readTenantSession('v1.abc.def') === null);
ok('a revoked token is refused on the instance that logged it out', (() => {
  revoked.set(token, session.expiresAt);
  const refused = ctx.readTenantSession(token) === null;
  revoked.clear();
  return refused;
})());

// The memory path must keep working for the same-process case (and for any
// deployment with no signing key configured).
const legacyToken = 'ab'.repeat(24);
memory.set(legacyToken, { tenantId: 'tenant-9', tenantPhone: '254700000009', expiresAt: Date.now() + 60_000 });
ok('an in-memory session still works', ctx.readTenantSession(legacyToken)?.tenantId === 'tenant-9');
ok('an expired in-memory session is dropped', (() => {
  memory.set('expired', { tenantId: 'x', tenantPhone: 'y', expiresAt: Date.now() - 1 });
  return ctx.readTenantSession('expired') === null && !memory.has('expired');
})());

// ---- 4. Nothing existing was weakened ------------------------------------
ok('the cookie name is unchanged', TENANT_SESSION_COOKIE === 'td_session');
ok('the TTL is unchanged (8h default)', /TENANT_SESSION_TTL_MS = parseInt\(process\.env\.TENANT_SESSION_TTL_MS \|\| "28800000", 10\)/.test(server));
ok('both auth paths use the restart-safe reader',
  /const session = readTenantSession\(cookieToken\);/.test(server) &&
  /const session = readTenantSession\(token\);/.test(server));
ok('the signing key needs no new environment variable',
  /env\.TENANT_SESSION_SECRET \|\| env\.TENANT_DASHBOARD_PASS/.test(moduleSrc));
ok('logout still takes effect immediately', /revokedTenantTokens\.set\(token, signed\.expiresAt\)/.test(server) &&
  /if \(revokedTenantTokens\.has\(raw\)\) return null;/.test(server));
ok('revoked entries do not accumulate forever',
  /for \(const \[token, expiresAt\] of revokedTenantTokens\.entries\(\)\) \{[\s\S]{0,80}revokedTenantTokens\.delete\(token\)/.test(server));
ok('the tenant is still re-checked from the database on every data route',
  /async function tenantSiteFromSession\(req\)[\s\S]{0,200}from\('bot_tenants'\)/.test(server));
ok('the cookie is still HttpOnly and SameSite', /"HttpOnly", "SameSite=Lax"/.test(server));

// The bug this guards: a duplicate `const` declaration in server.js parses
// nowhere and kills the process on boot, and no amount of text matching can see
// it — the file is a perfectly good string. Parse the files for real.
const parses = (file) => {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
};
ok('server.js parses as a module', parses('server.js'));
ok('the session module parses', parses('utils/tenantSession.js'));
ok('no symbol is declared twice in the session block',
  (server.match(/const revokedTenantTokens = new Map\(\);/g) || []).length === 1,
  (server.match(/const revokedTenantTokens = new Map\(\);/g) || []).length + ' declarations');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
