// Functional verification of the discovery → tenant handoff.
//
// Flow under test: public questionnaire → POST /discovery (id returned) → owner
// approves in /admin → tenant row + portal token → invite link → client opens
// /tenant-dashboard?t=… and lands in their own Writer's Flow.
//
// The helpers are imported for real, so a change to phone normalisation, token
// shape, invite copy or queue merging fails here instead of in front of a client.
// The last sections assert the wiring that cannot be imported (route scoping, the
// invite auto-login hook) so a refactor cannot silently reopen cross-tenant access.
//
// Run: npm run test:discovery   (no server, no database required)
import fs from 'fs';
import {
  normalizeKePhone,
  isValidKeMobile,
  newSubmissionId,
  newPortalToken,
  buildPortalUrl,
  buildInviteMessage,
  buildWhatsAppInviteLink,
  parseSubmissionLog,
  normalizeSubmission,
  mergeSubmissions,
  findSubmission,
} from '../utils/discoveryApprovals.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const throws = (name, fn) => {
  try { fn(); ok(name, false, 'no error thrown'); }
  catch { ok(name, true); }
};

// ---- 1. Phone normalisation -------------------------------------------------
// The phone is the tenant key: /tenant/session/login matches on it, so every
// spelling a client might type has to land on the same 2547XXXXXXXX value.
const phoneCases = [
  ['0712 345 678', '254712345678'],
  ['+254 712 345 678', '254712345678'],
  ['254712345678', '254712345678'],
  ['712345678', '254712345678'],
  ['0712-345-678', '254712345678'],
  ['  0712345678  ', '254712345678'],
  ['(254) 712 345 678', '254712345678'],
];
for (const [input, expected] of phoneCases) {
  ok(`phone "${input}" normalises to ${expected}`, normalizeKePhone(input) === expected, normalizeKePhone(input));
}
ok('empty phone normalises to empty string (never "0" or "undefined")',
  normalizeKePhone('') === '' && normalizeKePhone(null) === '' && normalizeKePhone(undefined) === '');
ok('a valid KE mobile passes validation', isValidKeMobile('254712345678'));
ok('a landline is rejected', !isValidKeMobile('254202123456'));

// ---- 2. Submission ids and portal tokens -----------------------------------
const idA = newSubmissionId(1700000000000, () => 0.1234);
const idB = newSubmissionId(1700000000000, () => 0.9876);
ok('submission id is human-readable and prefixed', /^DSC-[0-9A-Z]+-[0-9A-Z]{4}$/.test(idA), idA);
ok('submission ids differ for the same millisecond', idA !== idB, idA + ' vs ' + idB);

const token = newPortalToken();
ok('portal token is 48 hex chars (192 bits)', /^[0-9a-f]{48}$/.test(token), token);
ok('portal tokens are not repeated', newPortalToken() !== newPortalToken());
ok('portal token is URL-safe without escaping', encodeURIComponent(token) === token);

// ---- 3. Invite link ---------------------------------------------------------
const link = buildPortalUrl('https://alphadome.example', { token: 'abc123', phone: '0712 345 678' });
const parsed = new URL(link);
ok('invite link targets /tenant-dashboard', parsed.pathname === '/tenant-dashboard', parsed.pathname);
ok('invite link carries the token as ?t=', parsed.searchParams.get('t') === 'abc123');
ok('invite link carries the normalised phone', parsed.searchParams.get('phone') === '254712345678',
  parsed.searchParams.get('phone'));
ok('a trailing slash on the base URL does not double up',
  buildPortalUrl('https://alphadome.example/', { token: 'abc123' }).startsWith('https://alphadome.example/tenant-dashboard?'));
ok('a relative base still produces a usable path',
  buildPortalUrl('', { token: 'abc123', phone: '0712345678' }).startsWith('/tenant-dashboard?t=abc123'));
ok('an unusable phone is omitted rather than sent blank',
  !buildPortalUrl('https://x.test', { token: 't1', phone: 'n/a' }).includes('phone='));
throws('a link without a token is refused', () => buildPortalUrl('https://x.test', {}));

const message = buildInviteMessage({
  contactName: 'Grace Wanjiru',
  businessName: 'Wanjiru Interiors',
  portalUrl: link,
});
ok('invite greets the contact by first name', message.startsWith('Hi Grace,'), message.split('\n')[0]);
ok('invite names the business', message.includes('Wanjiru Interiors'));
ok('invite includes the portal link', message.includes(link));
ok('invite explains the link signs them in (no password to copy)',
  /signs you in/i.test(message) && /no password/i.test(message));
ok("invite points at both Writer's Flow surfaces",
  message.includes('Blogger') && message.includes('Research & Outreach'));
ok('invite falls back to "Hello" when there is no contact name',
  buildInviteMessage({ portalUrl: link }).startsWith('Hello,'));

const wa = buildWhatsAppInviteLink({ phone: '0712 345 678', message });
ok('WhatsApp link targets the same normalised number',
  wa.startsWith('https://wa.me/254712345678?text='), wa.slice(0, 40));
ok('WhatsApp link round-trips the invite text',
  decodeURIComponent(wa.split('?text=')[1]) === message);
throws('WhatsApp link without a phone is refused', () => buildWhatsAppInviteLink({ phone: '', message }));

// ---- 4. Fallback log parsing ------------------------------------------------
const good = JSON.stringify({ event: 'discovery_submission', id: 'DSC-1', payload: { phone: '0712345678' } });
const logText = [good, '', '   ', 'not json at all', '{"half":', good].join('\r\n');
const parsedLog = parseSubmissionLog(logText);
ok('log parser keeps only valid objects', parsedLog.length === 2, 'kept ' + parsedLog.length);
ok('log parser survives CRLF blank lines and truncation', parsedLog[1].id === 'DSC-1');
ok('empty log content parses to an empty list', parseSubmissionLog('').length === 0);

// ---- 5. Shape normalisation -------------------------------------------------
const fromLog = normalizeSubmission({
  event: 'discovery_submission',
  id: 'DSC-LOG-1',
  submitted_at: '2026-10-20T09:00:00.000Z',
  payload: {
    name: 'Grace Wanjiru',
    business_name: 'Wanjiru Interiors',
    phone: '+254 712 345 678',
    email: 'GRACE@Example.COM',
    industry: 'Interior design',
    challenges: ['Leads', 'Follow-up'],
    additional_notes: 'Wants 20 quotes a month',
  },
}, 0);
ok('log record is read from the nested payload', fromLog.contact_name === 'Grace Wanjiru', fromLog.contact_name);
ok('log record phone is normalised', fromLog.phone === '254712345678', fromLog.phone);
ok('email is lower-cased so the same client cannot appear twice',
  fromLog.email === 'grace@example.com', fromLog.email);
ok('multi-select answers become arrays', Array.isArray(fromLog.challenges) && fromLog.challenges.length === 2);
ok('blockers/notes land in one field', fromLog.notes === 'Wants 20 quotes a month', fromLog.notes);
ok('a stored submission defaults to status new', fromLog.status === 'new', fromLog.status);

const fromDb = normalizeSubmission({
  id: '8f1c', status: 'Approved', name: 'Peter Otieno', business_name: 'Otieno Hardware',
  phone: '0712345678', portal_url: 'https://x.test/tenant-dashboard?t=deadbeef',
}, 1);
ok('DB row with a flat name column is normalised', fromDb.contact_name === 'Peter Otieno', fromDb.contact_name);
ok('status is lower-cased for comparisons', fromDb.status === 'approved', fromDb.status);
ok('existing portal link survives normalisation', fromDb.portal_url === 'https://x.test/tenant-dashboard?t=deadbeef');

const legacy = normalizeSubmission({ payload: { phone: '0712345678', name: 'No Id' } }, 7);
ok('a record with no id still gets a stable key', legacy.id === 'legacy-254712345678-7', legacy.id);
ok('a synthesised id is flagged so the UI never calls the API with it', legacy.legacy === true);

// ---- 6. Queue merge (the approval must win) --------------------------------
const dbRow = {
  id: 'DSC-MERGE-1', status: 'new', name: 'Grace Wanjiru', business_name: 'Wanjiru Interiors',
  phone: '0712345678', submitted_at: '2026-10-20T09:00:00.000Z',
};
const approvalEvent = {
  event: 'discovery_approved', id: 'DSC-MERGE-1', status: 'approved',
  tenant_id: 'tenant-1', portal_token: 'tok-1',
  portal_url: 'https://x.test/tenant-dashboard?t=tok-1&phone=254712345678',
  approved_at: '2026-10-21T10:00:00.000Z', submitted_at: '2026-10-20T09:00:00.000Z',
};
const merged = mergeSubmissions([dbRow], [approvalEvent]);
ok('a submission is not duplicated across DB and log', merged.length === 1, 'rows=' + merged.length);
ok('approval wins over the original new row', merged[0].status === 'approved', merged[0].status);
ok('approval carries the tenant id through', merged[0].tenant_id === 'tenant-1', merged[0].tenant_id);
ok('approval carries the portal link through', merged[0].portal_url === approvalEvent.portal_url);
ok('contact details survive the approval merge', merged[0].contact_name === 'Grace Wanjiru', merged[0].contact_name);

// A refresh reloads both sources: the stored link must not be lost or re-minted.
const reload = mergeSubmissions([dbRow], [approvalEvent, { ...approvalEvent }]);
ok('re-reading the log keeps the same portal link', reload[0].portal_url === approvalEvent.portal_url);
ok('a later "new" row never downgrades an approval', mergeSubmissions(
  [approvalEvent, { ...dbRow, submitted_at: '2026-10-22T09:00:00.000Z' }], [],
)[0].status === 'approved');

const ordering = mergeSubmissions([], [
  { id: 'DSC-OLD', status: 'new', submitted_at: '2026-10-01T08:00:00.000Z' },
  { id: 'DSC-NEW', status: 'new', submitted_at: '2026-10-23T08:00:00.000Z' },
]);
ok('newest submission is first in the queue', ordering[0].id === 'DSC-NEW', ordering.map((r) => r.id).join(','));

// ---- 7. Lookup used by approve / reject / rotate ---------------------------
ok('lookup by exact id works', findSubmission(merged, 'DSC-MERGE-1')?.id === 'DSC-MERGE-1');
ok('lookup falls back to the normalised phone',
  findSubmission(merged, 'DSC-UNKNOWN', '+254 712 345 678')?.id === 'DSC-MERGE-1');
ok('lookup returns null instead of throwing on a miss', findSubmission(merged, 'nope', '0700000000') === null);
ok('an unknown submission never resolves to the first row', findSubmission(merged, 'DSC-UNKNOWN') === null);


ok('a short number is rejected', !isValidKeMobile('2547123456'));
ok('a non-KE prefix is rejected', !isValidKeMobile('255712345678'));


// ---- 8. Server wiring: isolation and idempotency ----------------------------
const server = fs.readFileSync('server.js', 'utf8');

ok('server imports the shared discovery helpers',
  /from "\.\/utils\/discoveryApprovals\.js"/.test(server) || /from '\.\/utils\/discoveryApprovals\.js'/.test(server));

const approveRoute = server.indexOf('"/admin/api/discovery/submissions/:id/approve"');
ok('approval endpoint exists', approveRoute > -1);
const approveSrc = approveRoute > -1 ? server.slice(approveRoute, approveRoute + 6000) : '';
ok('approval is idempotent for an already-approved submission', /already_approved: true/.test(approveSrc));
ok('approval refuses a submission with no usable phone',
  /isValidKeMobile\(phone\)/.test(approveSrc) && /status\(400\)/.test(approveSrc));
ok('approval writes the tenant record before returning the link',
  /await writeBotTenantRecord\(|await insertBotTenantRecord\(/.test(approveSrc)
  && approveSrc.indexOf('BotTenantRecord(') < approveSrc.lastIndexOf('return res.json'),
  'tenant write must precede the response');
ok('approval still logs when the DB write fails',
  /appendJsonlRecord\(DISCOVERY_LOG_FILE, \{ event: "discovery_approved"/.test(approveSrc));

const rotateRoute = server.indexOf('"/admin/api/discovery/submissions/:id/portal-link"');
const rotateSrc = rotateRoute > -1 ? server.slice(rotateRoute, rotateRoute + 3000) : '';
ok('rotating a link mints a fresh token (old link revoked)', /const token = newPortalToken\(\)/.test(rotateSrc));
ok('rotating is refused before approval', /status\(409\)/.test(rotateSrc));

// Tenants onboarded before the questionnaire must be invitable too, otherwise the
// only way in is to fake a submission for them.
const tenantInviteRoute = server.indexOf('"/admin/api/tenants/:tenantId/portal-link"');
ok('owner can issue an invite for an existing tenant', tenantInviteRoute > -1);
const tenantInviteSrc = tenantInviteRoute > -1 ? server.slice(tenantInviteRoute, tenantInviteRoute + 3200) : '';
ok('tenant invite is admin-only', /adminAuth/.test(tenantInviteSrc));
ok('tenant invite reuses the same token + link + message builders',
  /newPortalToken\(\)/.test(tenantInviteSrc) &&
  /buildPortalUrl\(/.test(tenantInviteSrc) &&
  /buildInviteMessage\(/.test(tenantInviteSrc) &&
  /buildWhatsAppInviteLink\(/.test(tenantInviteSrc));
ok('tenant invite refuses a tenant without a usable mobile',
  /isValidKeMobile\(phone\)/.test(tenantInviteSrc) && /status\(400\)/.test(tenantInviteSrc));
ok('tenant invite persists a corrected phone (login compares it)', /tenantPatch\.client_phone = phone/.test(tenantInviteSrc));
ok('tenant invite keeps the discovery card in sync', /from\("discovery_submissions"\)/.test(tenantInviteSrc));
ok('tenant invite never returns a password', !/TENANT_DASHBOARD_PASS/.test(tenantInviteSrc));

// Tenant Writer's Flow must be scoped by tenant_id and must never fall back to
// the global campaign list: that fallback would leak one client's leads to another.
const tenantWfStart = server.indexOf('function tenantWfMigrationResponse');
ok('tenant campaign list route exists', server.indexOf('app.get("/tenant/wf/campaigns"') > -1);
const tenantWfSrc = tenantWfStart > -1 ? server.slice(tenantWfStart, tenantWfStart + 12000) : '';
ok('tenant campaign list filters on tenant_id', /\.eq\("tenant_id", tenantId\)/.test(tenantWfSrc));
ok('tenant campaigns are never listed unscoped',
  !/from\("wf_campaigns"\)\s*\.select\("\*"\)\s*\.order/.test(tenantWfSrc),
  'unscoped select found');
ok('missing tenant schema answers 503 + migration_required, not an empty list',
  /migration_required: true/.test(tenantWfSrc) && /status\(503\)/.test(tenantWfSrc));

const loginRoute = server.indexOf('app.post("/tenant/session/login"');
const loginSrc = loginRoute > -1 ? server.slice(loginRoute, loginRoute + 2500) : '';
ok('invite token is accepted as a login key', /findTenantByPortalToken\(key\)/.test(loginSrc));
ok('an inactive tenant cannot log in with a token', /Tenant found but inactive/.test(loginSrc));
ok('an invite used with another phone is refused', /different phone number/.test(loginSrc));


// ---- 9. Client wiring -------------------------------------------------------
const adminDash = fs.readFileSync('admin/dashboard.html', 'utf8');
ok('admin nav exposes the discovery queue', /href="#discovery"/.test(adminDash));
ok('#discovery renders the approval page', /hash === '#discovery'[\s\S]{0,80}renderDiscoveryPage\(\)/.test(adminDash));
ok('renderDiscoveryPage is defined', /function renderDiscoveryPage\(\)/.test(adminDash));
ok('the queue reads the owner-only endpoint', /admin\/api\/discovery\/submissions/.test(adminDash));
ok('the queue can approve, reject and rotate',
  ['approve', 'reject', 'portal-link'].every((path) => adminDash.includes(`/discovery/submissions/\${encodeURIComponent(id)}/${path}`)));
ok('the queue offers a WhatsApp share and a copy action',
  /whatsapp_url/.test(adminDash) && /navigator\.clipboard\.writeText/.test(adminDash));
ok('submission text is escaped before it reaches innerHTML',
  /function escapeHtml\(/.test(adminDash) && /escapeHtml\(String\(row\.business_description\)/.test(adminDash));
ok('every tenant card can mint an invite without a submission',
  /function issueTenantPortalLink\(tenantId\)/.test(adminDash) &&
  /portal-link`, \{/.test(adminDash) &&
  /issueTenantPortalLink\('\$\{escapeHtml\(String\(tenant\.id/.test(adminDash) &&
  /window\.issueTenantPortalLink = issueTenantPortalLink/.test(adminDash));

const tenantDash = fs.readFileSync('admin/tenant_dashboard.html', 'utf8');
ok('tenant portal reads the invite params',
  /URL_PARAMS\.get\('t'\)/.test(tenantDash) && /URL_PARAMS\.get\('phone'\)/.test(tenantDash));
ok('boot signs the client in from the invite before asking for a key',
  /if \(INVITE_TOKEN\) \{ signInWithInvite\(\); return; \}/.test(tenantDash),
  'invite branch must precede the missing-key guard');
ok('the invite is stripped from the address bar after login',
  /clean\.searchParams\.delete\('t'\)/.test(tenantDash));
ok('the portal warns instead of blaming the client when the migration is missing',
  /migration_required/.test(tenantDash) && /alert-warning/.test(tenantDash));
ok('tenant outreach panel is wired on render',
  /wfWireOutreach\(\)/.test(tenantDash) && /function wfWireOutreach/.test(tenantDash));

const migration = 'migrations/2026-10-24_discovery_tenant_approvals.sql';
ok('migration file exists', fs.existsSync(migration));
if (fs.existsSync(migration)) {
  const sql = fs.readFileSync(migration, 'utf8');
  ok('migration is additive (add column if not exists)',
    /add column if not exists/i.test(sql) && !/drop\s+(table|column)/i.test(sql));
  ok('migration adds the columns the flow depends on',
    /portal_token/i.test(sql) && /portal_token_issued_at/i.test(sql) && /tenant_id/i.test(sql));
  ok('migration indexes the portal-token lookup', /create index if not exists/i.test(sql));
  ok('migration makes the portal token unique (one tenant per link)', /unique/i.test(sql));
}
// ---- 10. A reload must not lock the tenant out ------------------------------
// The portal is a full page load behind tenantDashboardAuth, so the login has to
// leave something the browser sends by itself. Without it, F5 on a client's
// phone is an unrecoverable "Unauthorized" page — the worst possible first
// impression on the first paying tenant.
const cookieGateSrc = server.slice(
  server.indexOf('async function tenantDashboardAuth'),
  server.indexOf('async function tenantDashboardAuth') + 2200,
);
ok('the dashboard gate accepts a session cookie', /getTenantSessionCookie\(req\)/.test(cookieGateSrc));
ok('the callback index reads the cookie', /function getTenantSessionToken[\s\S]{0,400}getTenantSessionCookie\(req\)/.test(server));
ok('login sets the session cookie',
  /buildTenantSessionCookie\(req, session\.token, session\.expiresAt\)/.test(loginSrc));
ok('the cookie is HttpOnly + SameSite', /HttpOnly/.test(server) && /SameSite=Lax/.test(server) && /Secure/.test(server));
ok('logout clears the cookie', /clearTenantSessionCookie\(res, req\)/.test(server));
ok('an expired cookie is cleared instead of dead-ending the page',
  /clearTenantSessionCookie\(res, req\);\s*\n\s*return next\(\);/.test(cookieGateSrc));
ok('/tenant/session/me rehydrates a session from the cookie',
  /app\.get\("\/tenant\/session\/me", tenantSessionAuth/.test(server));
ok('a stored session is honoured before the missing-key guard',
  /if \(loadSession\(\)\) \{ showApp\(\); go\('home'\); return; \}\s*\n\s*if \(await restoreSessionFromCookie\(\)\)/.test(tenantDash),
  'F5 used to fall through to the key guard');
ok('boot is async so it can await the cookie restore', /async function boot\(\)/.test(tenantDash));
ok('the portal rehydrates from the cookie over same-origin fetch',
  /credentials: 'same-origin'/.test(tenantDash));
ok('the access key and phone survive a session expiry in the tab',
  /KEY_SLOT/.test(tenantDash) && /PHONE_SLOT/.test(tenantDash) && /function rememberCredentials/.test(tenantDash));
ok('the login form is prefilled from what we already know',
  /const keyEl = document\.getElementById\('lKey'\);[\s\S]{0,120}S\.key/.test(tenantDash) &&
  /const phoneEl = document\.getElementById\('lPhone'\);[\s\S]{0,120}S\.phone/.test(tenantDash));

// ---- 11. The admin scripts must compile -------------------------------------
// A broken template literal in the queue would only surface as a blank page in
// front of the owner, so compile every inline script block here first.
import vm from 'vm';
for (const file of ['admin/dashboard.html', 'admin/tenant_dashboard.html']) {
  // Keep only the script body: vm.Script rejects a whole HTML document.
  const html = fs.readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  ok(`${file} has inline script`, blocks.length > 0, 'blocks=' + blocks.length);
  let error = null;
  for (const [index, source] of blocks.entries()) {
    try { new vm.Script(source, { filename: `${file}#${index + 1}` }); }
    catch (err) { error = `${file} block ${index + 1}: ${err.message}`; break; }
  }
  ok(`${file} inline scripts parse`, error === null, error || '');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
