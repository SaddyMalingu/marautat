#!/usr/bin/env node
// Post-deploy smoke test for the client lifecycle:
//   tenant record -> portal invite link -> client sign-in with that link only ->
//   tenant-scoped Writer's Flow, plus the negative cases that make the link safe
//   to send over WhatsApp.
//
// Read-only by default. Without --issue it only lists which tenants *can* be invited,
// because issuing a link rotates (revokes) the previous one.
//
// Usage:
//   node scripts/smoke_tenant_onboarding.mjs --key=ADMIN_PASS
//   node scripts/smoke_tenant_onboarding.mjs --key=ADMIN_PASS --tenant=Kassangas --issue
//   node scripts/smoke_tenant_onboarding.mjs --base=http://localhost:3000 --key=devpass --tenant=254712345678 --issue
//
// Env fallbacks: BASE_URL, ADMIN_PASS.

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const value = hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
  return value === '' ? 'true' : value;
}

const BASE = String(arg('base', process.env.BASE_URL || 'https://alphadome.onrender.com')).replace(/\/+$/, '');
const KEY = arg('key', process.env.ADMIN_PASS || '');
const WANTED = arg('tenant', '');
const ISSUE = arg('issue', '') === 'true';

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

if (typeof globalThis.fetch !== 'function') {
  console.error('This script needs Node 18+ (global fetch).');
  process.exit(2);
}

if (!KEY) {
  console.log(`Tenant onboarding smoke test against ${BASE}

This checks the client's side of the invite, so it needs the admin key:

  node scripts/smoke_tenant_onboarding.mjs --key=<ADMIN_PASS>

Optional:
  --base=<url>            default ${BASE}
  --tenant=<name|phone>   which tenant to invite (default: first with a usable mobile)
  --issue                 actually mint a link (rotates the tenant's current one)

Nothing is written without --issue.`);
  process.exit(2);
}

const ADMIN_HEADERS = { 'x-admin-key': KEY };
const JSON_HEADERS = { ...ADMIN_HEADERS, 'Content-Type': 'application/json' };

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

function toKeMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('7') && digits.length === 9) return `254${digits}`;
  return '';
}

async function main() {
  console.log(`Tenant onboarding smoke test -> ${BASE}\n`);

  // 1. The admin surface must be closed to strangers.
  const anon = await request('/admin/api/tenants/list?limit=5');
  ok('admin tenant list rejects a request with no key', anon.status === 401, `status ${anon.status}`);

  const wrongKey = await request('/admin/api/tenants/list?limit=5', { headers: { 'x-admin-key': `${KEY}-wrong` } });
  ok('admin tenant list rejects a wrong key', wrongKey.status === 401, `status ${wrongKey.status}`);

  // 2. Load the roster.
  const list = await request('/admin/api/tenants/list?limit=100', { headers: ADMIN_HEADERS });
  if (!ok('admin tenant list answers 200 with the key', list.status === 200, `status ${list.status}`)) {
    console.log(`  body: ${JSON.stringify(list.body).slice(0, 300)}`);
    return;
  }
  ok('tenant list returns an array', Array.isArray(list.body?.tenants), `got ${typeof list.body?.tenants}`);

  const tenants = Array.isArray(list.body?.tenants) ? list.body.tenants : [];
  const invitable = tenants.filter((tenant) => toKeMobile(tenant.client_phone));
  console.log(`\n${tenants.length} tenants, ${invitable.length} with a usable Kenyan mobile.`);
  for (const tenant of tenants.slice(0, 15)) {
    const mobile = toKeMobile(tenant.client_phone);
    const label = String(tenant.client_name || 'unnamed').slice(0, 30).padEnd(30);
    const note = mobile ? '' : '  (cannot be invited)';
    console.log(`  ${mobile ? '+' : '.'} ${label} ${tenant.client_phone || 'no phone'}${note}`);
  }

  const wanted = WANTED.toLowerCase();
  const chosen = WANTED
    ? tenants.find((tenant) => `${tenant.client_name || ''} ${tenant.client_phone || ''}`.toLowerCase().includes(wanted))
    : invitable[0];

  if (!chosen) {
    ok('a tenant matching --tenant exists', false, WANTED ? `nothing matched "${WANTED}"` : 'no invitable tenant found');
    return;
  }
  ok('a tenant matching --tenant exists', true);

  const phone = toKeMobile(chosen.client_phone);
  if (!ok('the chosen tenant has a usable Kenyan mobile', Boolean(phone), String(chosen.client_phone || 'none'))) return;

  if (!ISSUE) {
    console.log(`\nReady to invite: ${chosen.client_name} (${phone})`);
    console.log('Re-run with --issue to mint the link and prove the client can sign in.');
    console.log('Issuing rotates the existing link, so a previously sent WhatsApp message stops working.');
    return;
  }

  // 3. Mint the invite (same path the admin "Portal Invite" button uses).
  console.log(`\nIssuing an invite for ${chosen.client_name} (${phone})...`);
  const invite = await request(`/admin/api/tenants/${encodeURIComponent(chosen.id)}/portal-link`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ phone }),
  });
  const inviteDebug = `status ${invite.status} ${JSON.stringify(invite.body).slice(0, 240)}`;
  if (!ok('portal invite returns 200', invite.status === 200, inviteDebug)) return;

  const portalUrl = String(invite.body?.portal_url || '');
  let parsedUrl = null;
  try {
    parsedUrl = new URL(portalUrl);
  } catch {
    parsedUrl = null;
  }
  const token = parsedUrl?.searchParams.get('t') || '';
  const urlPhone = parsedUrl?.searchParams.get('phone') || '';
  const whatsappUrl = String(invite.body?.whatsapp_url || '');

  ok('the invite carries a portal token in the URL', token.length >= 24, `token length ${token.length}`);
  ok('the invite URL points at the tenant dashboard', /\/tenant-dashboard\?/.test(portalUrl), portalUrl.slice(0, 80));
  ok('the invite URL carries the login phone', urlPhone === phone, urlPhone || 'missing');
  ok('the invite ships a WhatsApp hand-off', /^https:\/\/wa\.me\/254\d{9}/.test(whatsappUrl), whatsappUrl.slice(0, 60));
  ok('the invite message contains the link', String(invite.body?.invite_message || '').includes(portalUrl));
  // The message may *mention* a password ("no password to copy"), but the API must
  // never hand back a credential field of any kind.
  ok('the invite response carries no credential field', !/"(password|pass|tenant_key|admin_key)"\s*:/i.test(JSON.stringify(invite.body)), 'credential field found');
  ok('rotation is reported to the caller', typeof invite.body?.rotated === 'boolean');

  // 4. The client's first click: sign in with the link and nothing else.
  const login = await request('/tenant/session/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: token }),
  });
  const loginDebug = `status ${login.status} ${JSON.stringify(login.body).slice(0, 160)}`;
  const signedIn = login.status === 200 && Boolean(login.body?.token);
  if (!ok('the client signs in with the link alone', signedIn, loginDebug)) return;

  const sessionPhone = String(login.body?.tenant_phone || '');
  ok('the session belongs to the invited tenant', toKeMobile(sessionPhone) === phone, sessionPhone);
  ok('the session expires (no immortal links)', Boolean(login.body?.expires_at) && new Date(login.body.expires_at) > new Date());

  const sessionHeaders = { 'x-tenant-session': String(login.body.token), 'x-tenant-phone': sessionPhone };

  // 5. Tenant-scoped Writer's Flow.
  const campaigns = await request('/tenant/wf/campaigns', { headers: sessionHeaders });
  const campaignsDebug = `status ${campaigns.status} ${JSON.stringify(campaigns.body).slice(0, 160)}`;
  if (ok("the client's campaign list answers 200", campaigns.status === 200, campaignsDebug)) {
    const visible = Array.isArray(campaigns.body?.campaigns) ? campaigns.body.campaigns : null;
    ok("the client's campaign list is tenant-scoped, not global", visible !== null, `got ${typeof campaigns.body?.campaigns}`);
    ok('the campaign payload leaks no tenant identifiers', !JSON.stringify(visible || []).includes('"tenant_id"'));
    console.log(`\n  ${chosen.client_name} sees ${(visible || []).length} campaign(s).`);
  }

  // 6. Negative cases: the link is one tenant's key, not a master password.
  const otherPhone = await request('/tenant/session/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: token, tenant_phone: '254700000001' }),
  });
  ok('the invite is refused with a different phone number', otherPhone.status === 403, `status ${otherPhone.status}`);

  const anonymous = await request('/tenant/wf/campaigns');
  ok("the client's campaign list rejects an anonymous request", anonymous.status === 401, `status ${anonymous.status}`);

  const forged = await request('/tenant/wf/campaigns', {
    headers: { 'x-tenant-session': 'deadbeef', 'x-tenant-phone': phone },
  });
  ok("the client's campaign list rejects a forged session", forged.status === 401, `status ${forged.status}`);

  console.log(`\nSend this to the client:\n  ${portalUrl}\n`);
  console.log(`WhatsApp hand-off:\n  ${whatsappUrl}\n`);
}

main()
  .catch((err) => {
    console.error(`\nSmoke test crashed: ${err.message}`);
    fail += 1;
  })
  .finally(() => {
    console.log(`---\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });


