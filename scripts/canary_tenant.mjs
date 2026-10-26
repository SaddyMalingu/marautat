#!/usr/bin/env node
// Canary for the two-schema tenant birth.
//
// Creates one throwaway tenant through the *real* path (discovery form -> owner
// approval) and reports exactly what the server did. A tenant that is born in
// `public` only looks healthy here and then fails on the first catalogue write,
// so the authoritative check is the follow-up:
//
//   node scripts/smoke_tenant_onboarding.mjs --base=... --key=... --tenant=<phone> --issue --write
//
// Usage:
//   node scripts/canary_tenant.mjs --base=https://example.com --key=<ADMIN_PASS>
//   node scripts/canary_tenant.mjs --base=... --key=... --phone=254700000999 --name="Q4 Canary"
//
// Nothing is deleted: keeping the tenant gives you a permanent regression tenant
// and a demo sandbox that is not a real client's data.

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg('base', 'http://localhost:3000').replace(/\/+$/, '');
const KEY = arg('key');
const PHONE = arg('phone', '254799000123');
const NAME = arg('name', 'Canary Onboarding');

if (!KEY) {
  console.log(`Canary tenant -> ${BASE}

Needs the owner key: an approval is an owner decision.

  node scripts/canary_tenant.mjs --base=<url> --key=<ADMIN_PASS>

Optional:
  --phone=2547xxxxxxxx   default 254799000123 (use a number nobody owns)
  --name="Q4 Canary"     business name of the throwaway tenant`);
  process.exit(2);
}
if (typeof globalThis.fetch !== 'function') {
  console.error('This script needs Node 18+ (global fetch).');
  process.exit(2);
}

let pass = 0;
let fail = 0;

function ok(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
  return Boolean(condition);
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

const asAdmin = (path, method = 'GET', payload) => request(path, {
  method,
  headers: { 'x-admin-key': KEY, 'Content-Type': 'application/json' },
  body: payload === undefined ? undefined : JSON.stringify(payload),
});

const brief = (body) => JSON.stringify(body || {}).slice(0, 200);

async function main() {
  console.log(`Canary tenant birth -> ${BASE}\n`);

  // 1. The public funnel. The POST is timed: this handler sends its notification
  //    emails before it answers, so a slow SMTP host shows up here as client lag.
  const startedAt = Date.now();
  const sub = await request('/discovery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: NAME, email: 'canary@example.com', phone: PHONE, business_name: NAME,
      industry: 'Retail', team_size: '2-5', whatsapp_usage: 'Daily order taking',
      revenue_target: 'KES 100k/mo', ownership_interest: 'Yes', timeline: 'This month',
      budget: 'KES 5,000/mo', source: 'canary',
    }),
  });
  const submitMs = Date.now() - startedAt;
  ok('the questionnaire accepted the submission',
    sub.status === 200 && sub.body?.ok === true, `${sub.status} in ${submitMs}ms ${brief(sub.body)}`);
  if (submitMs > 5000) {
    console.log(`NOTE  submit took ${submitMs}ms; the client stares at a spinner that long.`);
  }

  const submissionId = sub.body?.submission_id;
  ok('it returned a submission id', Boolean(submissionId), brief(sub.body));
  if (!submissionId) return;

  // 2. The owner decision: the path that must create the tenant in both schemas.
  const approve = await asAdmin(
    `/admin/api/discovery/submissions/${encodeURIComponent(submissionId)}/approve`,
    'POST', {},
  );
  ok('approval succeeded', approve.status === 200 && approve.body?.ok === true,
    `${approve.status} ${brief(approve.body)}`);

  const tenantId = approve.body?.tenant_id;
  ok('approval returned a tenant id', Boolean(tenantId), brief(approve.body));
  ok('approval reports catalogue health', 'catalogue_warning' in (approve.body || {}),
    `fields: ${Object.keys(approve.body || {}).join(',')}`);
  ok('the alphadome twin was minted (catalogue_warning is null)',
    approve.body?.catalogue_warning === null,
    String(approve.body?.catalogue_warning || 'field missing'));
  ok('the invite is a signed portal link',
    /^https?:\/\/[^/]+\/tenant-dashboard\?/.test(String(approve.body?.portal_url || '')),
    String(approve.body?.portal_url || '').slice(0, 80));

  // 3. It has to be visible on the surface that issues re-invites.
  const list = await asAdmin('/admin/api/tenants/list?limit=200');
  const rows = Array.isArray(list.body) ? list.body : (list.body?.tenants || []);
  ok('the tenant appears in the owner tenant list', Boolean(rows.find((t) => String(t?.id) === String(tenantId))),
    `status ${list.status}, ${rows.length} rows`);

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`tenant_id : ${tenantId || '(none)'}`);
  console.log(`phone     : ${PHONE}`);
  console.log(`warning   : ${approve.body?.catalogue_warning ?? 'none'}`);
  console.log(`
Next, prove the twin can save data:

  node scripts/smoke_tenant_onboarding.mjs --base=${BASE} --key=<ADMIN_PASS> --tenant=${PHONE} --issue --write`);
  console.log(`\n${'-'.repeat(60)}\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nCanary aborted: ${err.message || err}`);
  process.exit(1);
});
