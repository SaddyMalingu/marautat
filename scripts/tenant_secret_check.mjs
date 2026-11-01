#!/usr/bin/env node

/**
 * Can this machine open the tenants' stored MoreLogin keys? (2026-11-02)
 *
 * `TENANT_SECRET_KEY` seals the keys in the database and opens them again, so the **portal
 * and every runner must hold the same value**. When they differ the failure is quiet until
 * a run starts: `reconnect_required`, which looks like the tenant's fault.
 *
 * This prints, per tenant, which key opens the seal — and the **fingerprint** of each
 * configured key, so two machines can be compared without anyone sharing the secret:
 *
 *   Render log / this script   sha256:4f1c9ab2d3e1
 *   your laptop                sha256:4f1c9ab2d3e1   <- same key
 *
 * Usage:
 *   node scripts/tenant_secret_check.mjs                 # every connected tenant
 *   node scripts/tenant_secret_check.mjs --tenant acme   # one tenant
 *
 * Exit codes: 0 = every stored key opens · 1 = at least one needs a reconnect · 2 = no key configured
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  ACCESS_KEY_ENV,
  ACCESS_KEY_PREVIOUS_ENV,
  accessSecrets,
  fingerprintSecret,
  openSecretFromEnv,
  readAccess,
  secretsConfigured
} from '../utils/tenantAccess.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return null;
};

const onlyTenant = flag('tenant');

if (!secretsConfigured()) {
  console.error(`No ${ACCESS_KEY_ENV} in this environment.`);
  console.error('Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.error('Then put the SAME value in the portal (Render) and here, or runs cannot open what the portal sealed.');
  process.exit(2);
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — this tool reads the tenants table.');
  process.exit(2);
}

const { current, previous } = accessSecrets();
console.log(`current   ${ACCESS_KEY_ENV} = ${fingerprintSecret(current)}`);
console.log(`retiring  ${ACCESS_KEY_PREVIOUS_ENV} = ${previous ? fingerprintSecret(previous) : '(not set)'}`);
console.log('');

const supabase = createClient(url, key);
let query = supabase.from('site_tenants').select('id, slug, metadata').order('slug').limit(500);
if (onlyTenant) query = query.eq('slug', String(onlyTenant).trim().toLowerCase());
const { data: tenants, error } = await query;
if (error) {
  console.error(error.message);
  process.exit(2);
}

const rows = [];
for (const tenant of tenants || []) {
  const access = readAccess(tenant.metadata);
  if (!access) continue;
  if (!access.keySealed) {
    rows.push({ tenant: tenant.slug, state: 'no stored key', action: 'tenant must reconnect' });
    continue;
  }
  const opened = openSecretFromEnv(access.keySealed, process.env);
  rows.push({
    tenant: tenant.slug,
    profile: `${access.envId.slice(0, 2)}***${access.envId.slice(-2)}`,
    state: opened.source === 'current' ? 'opens (current key)' : opened.source === 'previous' ? 'opens (RETIRING key)' : 'CANNOT OPEN',
    action: opened.source === 'current' ? '' : opened.source === 'previous' ? 'reconnect to reseal, then drop the retiring key' : 'tenant must reconnect'
  });
}

if (!rows.length) {
  console.log(onlyTenant ? `Tenant "${onlyTenant}" has no connected browser.` : 'No tenant has connected a browser yet.');
  process.exit(0);
}

const width = Math.max(...rows.map((row) => row.tenant.length), 6);
for (const row of rows) {
  console.log(`${row.tenant.padEnd(width)}  ${String(row.profile || '').padEnd(10)}  ${row.state}${row.action ? `  -> ${row.action}` : ''}`);
}

const broken = rows.filter((row) => row.state === 'CANNOT OPEN' || row.state === 'no stored key');
const retiring = rows.filter((row) => row.state === 'opens (RETIRING key)');
console.log('');
console.log(`${rows.length} connected · ${broken.length} unreadable · ${retiring.length} on the retiring key`);

process.exit(broken.length ? 1 : 0);
