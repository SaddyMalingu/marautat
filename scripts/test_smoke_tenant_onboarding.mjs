#!/usr/bin/env node
// Proves scripts/smoke_tenant_onboarding.mjs can tell a healthy invite from a broken one.
// Spins a stub of the tenant/admin endpoints, runs the smoke script against it as a
// child process, and asserts the exit code. No database, no network.
//
// Run: node scripts/test_smoke_tenant_onboarding.mjs

import http from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = path.join(ROOT, 'scripts', 'smoke_tenant_onboarding.mjs');
const ADMIN_KEY = 'test-key';
const INVITE_TOKEN = 'a'.repeat(32);
const PHONE = '254712345678';

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// breakPortalPhone mimics the regression we care about: an invite link that signs
// nobody in because the phone parameter is missing.
function buildServer({ breakPortalPhone = false, writeBroken = false } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = req.method === 'POST' ? await readBody(req) : {};

    if (url.pathname === '/admin/api/tenants/list') {
      if (req.headers['x-admin-key'] !== ADMIN_KEY) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { ok: true, tenants: [{ id: 'tenant-1', client_name: 'Kassangas', client_phone: '0712345678' }] });
    }

    if (url.pathname === '/admin/api/tenants/tenant-1/portal-link' && req.method === 'POST') {
      if (req.headers['x-admin-key'] !== ADMIN_KEY) return json(res, 401, { error: 'Unauthorized' });
      const phoneQuery = breakPortalPhone ? '' : `&phone=${PHONE}`;
      const portalUrl = `http://example.test/tenant-dashboard?t=${INVITE_TOKEN}${phoneQuery}`;
      return json(res, 200, {
        ok: true,
        rotated: false,
        portal_url: portalUrl,
        whatsapp_url: `https://wa.me/${PHONE}?text=${encodeURIComponent(portalUrl)}`,
        invite_message: `Karibu! Open your portal (this link signs you in — no password to copy): ${portalUrl}`,
        // null = the tenant has its alphadome twin, so the dashboard can save.
        catalogue_warning: null,
      });
    }

    if (url.pathname === '/tenant/session/login' && req.method === 'POST') {
      if (body.key !== INVITE_TOKEN) return json(res, 401, { error: 'Unauthorized' });
      if (body.tenant_phone && body.tenant_phone !== PHONE) {
        return json(res, 403, { error: 'This invite belongs to a different phone number' });
      }
      return json(res, 200, {
        ok: true,
        token: 'session-abc',
        tenant_phone: PHONE,
        tenant_name: 'Kassangas',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }

    if (url.pathname === '/tenant/bot-settings') {
      if (req.headers['x-tenant-session'] !== 'session-abc') return json(res, 401, { error: 'Missing tenant session token' });
      // Resolving here means the phone found a row in alphadome, which is what the
      // catalogue foreign keys need. A public-only tenant answers 404 instead.
      return json(res, 200, { settings: { ai_model: 'gpt-4o-mini', has_wa_token: false, is_active: true } });
    }

    if (url.pathname === '/tenant/training' && req.method === 'POST') {
      if (req.headers['x-tenant-session'] !== 'session-abc') return json(res, 401, { error: 'Missing tenant session token' });
      if (writeBroken) {
        return json(res, 500, {
          error: 'insert or update on table "bot_training_data" violates foreign key constraint "bot_training_data_bot_tenant_id_fkey"',
        });
      }
      return json(res, 200, { training: { id: 'training-1', question: body.question || '', answer: body.answer || '' } });
    }

    if (url.pathname === '/tenant/training/training-1' && req.method === 'DELETE') {
      if (req.headers['x-tenant-session'] !== 'session-abc') return json(res, 401, { error: 'Missing tenant session token' });
      return json(res, 200, { ok: true, deleted_id: 'training-1' });
    }

    if (url.pathname === '/tenant/wf/campaigns') {
      if (req.headers['x-tenant-session'] !== 'session-abc') return json(res, 401, { error: 'Missing tenant session token' });
      return json(res, 200, { ok: true, campaigns: [{ id: 'c1', name: 'Q4 schools', status: 'running' }] });
    }

    return json(res, 404, { error: 'not found' });
  });
}

function runSmoke(base, extraArgs = []) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SMOKE, `--base=${base}`, `--key=${ADMIN_KEY}`, '--tenant=kassangas', '--issue', ...extraArgs],
      { cwd: ROOT, env: { ...process.env, ADMIN_PASS: '', BASE_URL: '' } },
      (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, output: `${stdout}\n${stderr}` }),
    );
  });
}

async function scenario(label, options, expectCode, extraArgs = []) {
  const server = buildServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runSmoke(base, extraArgs);
    check(`${label}: smoke test exits ${expectCode}`, result.code === expectCode, `exited ${result.code}`);
    return result.output;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const healthy = await scenario('healthy invite', {}, 0);
check('healthy invite: no failing assertions', !/^FAIL/m.test(healthy), healthy.split('\n').filter((l) => l.startsWith('FAIL')).join(' | '));
check('healthy invite: checks actually ran', (healthy.match(/^PASS/gm) || []).length >= 12, `${(healthy.match(/^PASS/gm) || []).length} PASS lines`);
check('healthy invite: the link is printed for sending', healthy.includes(`t=${INVITE_TOKEN}`));

const broken = await scenario('borked invite', { breakPortalPhone: true }, 1);
check('borked invite: the missing phone is caught', /FAIL\s+the invite URL carries the login phone/.test(broken));

// The probe that proves a tenant can actually manage its dashboard: a public-only
// tenant signs in fine and still cannot save, because the catalogue tables carry a
// foreign key into alphadome.
const writeProbe = await scenario('write probe', {}, 0, ['--write']);
check('write probe: the alphadome-backed tables accept a row',
  /PASS\s+the tenant can write its first dashboard row/.test(writeProbe));
check('write probe: the created row is removed again',
  /PASS\s+the write probe deleted what it created/.test(writeProbe));

const writeBlocked = await scenario('write blocked', { writeBroken: true }, 1, ['--write']);
check('write blocked: a tenant without an alphadome row is caught before the demo',
  /FAIL\s+the tenant can write its first dashboard row/.test(writeBlocked));
check('write blocked: the foreign-key reason is printed',
  /foreign key constraint/.test(writeBlocked));

console.log(`\n---\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
