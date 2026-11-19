/**
 * Print what the bot knows about a tenant (2026-11-19)
 *
 *   node scripts/tenant_dossier.mjs                        # every active tenant, one block each
 *   node scripts/tenant_dossier.mjs --tenant 254713793488   # one tenant
 *   node scripts/tenant_dossier.mjs --tenant "Francis" --json
 *
 * Read-only, and the same `loadDossier()` the reply path uses — so this is the honest
 * answer to "what does the bot actually know?", not a second implementation of it.
 */
import 'dotenv/config';
import { requireSupabaseEnv } from '../utils/supabaseEnv.js';
import { loadDossier, isOwnerPhone } from '../utils/tenantDossier.js';

function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const at = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at === -1) return fallback;
  const token = argv[at];
  if (token.includes('=')) return token.slice(token.indexOf('=') + 1);
  const next = argv[at + 1];
  if (next === undefined || String(next).startsWith('--')) return true;
  return next;
}

const { url, key } = requireSupabaseEnv();
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(url, key);

const want = String(arg('tenant', '') || '').trim();
const asJson = process.argv.slice(2).includes('--json');
const digits = (v) => String(v || '').replace(/\D/g, '');

const { data: tenants, error } = await sb
  .from('bot_tenants')
  .select('id, client_name, client_phone, point_of_contact_name, point_of_contact_phone, brand_id, status, is_active, portal_token, whatsapp_phone_number_id')
  .order('created_at', { ascending: true });
if (error) {
  console.error('Cannot read bot_tenants: ' + error.message);
  process.exit(1);
}

const picked = (tenants || [])
  .filter((t) => t.is_active !== false && String(t.status || 'active') === 'active')
  .filter((t) => {
    if (!want) return true;
    const want9 = digits(want).slice(-9);
    return digits(t.client_phone).slice(-9) === want9
      || digits(t.client_phone).includes(digits(want))
      || String(t.client_name || '').toLowerCase().includes(want.toLowerCase());
  });

if (!picked.length) {
  console.error('No active tenant matches "' + want + '".');
  process.exit(1);
}

const out = [];
for (const tenant of picked) {
  const dossier = await loadDossier(sb, tenant);
  out.push({
    tenant: tenant.client_name,
    phone: tenant.client_phone,
    portal: Boolean(tenant.portal_token),
    whatsapp_configured: Boolean(tenant.whatsapp_phone_number_id) && !/^pending:/.test(String(tenant.whatsapp_phone_number_id)),
    owner_recognised: isOwnerPhone(tenant, tenant.client_phone),
    gaps: dossier?.gaps || [],
    block: dossier?.text || null
  });
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

for (const row of out) {
  console.log('\n============================================================');
  console.log(row.tenant + '  ·  ' + row.phone
    + (row.portal ? '  ·  portal link issued' : '  ·  NO portal link')
    + (row.whatsapp_configured ? '  ·  WhatsApp configured' : '  ·  WhatsApp not configured'));
  if (!row.block) {
    console.log('  (no dossier — the loader returned nothing)');
    continue;
  }
  for (const line of row.block.split('\n')) console.log('  ' + line);
}
console.log('\n' + out.length + ' tenant(s). This is exactly what the reply path injects for an owner.\n');
