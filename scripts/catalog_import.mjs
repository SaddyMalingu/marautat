/**
 * Catalogue import — a pasted price list, one tenant, preview first (2026-11-19)
 *
 *   node scripts/catalog_import.mjs --tenant 254713793488 --text "Omo 1kg 320"
 *   node scripts/catalog_import.mjs --tenant "Spreadmasters" --from prices.txt
 *   node scripts/catalog_import.mjs --tenant 254713793488 --from prices.txt --apply
 *
 * Why: eleven of twelve active tenants have an empty catalogue, so the bot has nothing
 * to sell and there is nothing to invoice. The campaign asks each tenant to send a
 * price list; this turns that message into a live shop in one command.
 *
 * Dry by default, like `blog_queue.mjs` and `browser_actor_import.mjs`: the default is
 * a plan you read, `--apply` is the write. Rows that cannot be read are printed with
 * their line number and the exact fix, because the person on the other end can correct
 * a line but cannot correct a silent drop.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { requireSupabaseEnv } from '../utils/supabaseEnv.js';
import { parsePriceList, toProduct, tenantPrefix, summarise } from '../utils/catalogImport.js';

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

const tenantQuery = String(arg('tenant', '') || '').trim();
const from = arg('from', null);
const text = arg('text', null);
const apply = Boolean(arg('apply', false));
const asJson = process.argv.slice(2).includes('--json');
const currency = String(arg('currency', 'KES') || 'KES').toUpperCase();

if (!tenantQuery) {
  console.error('Usage: node scripts/catalog_import.mjs --tenant <phone|name> (--from prices.txt | --text "…") [--apply]');
  process.exit(2);
}
if (!from && !text) {
  console.error('Nothing to import: pass --from <file> or --text "<price list>"');
  process.exit(2);
}

const { url, key } = requireSupabaseEnv();
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(url, key);

const digits = (v) => String(v || '').replace(/\D/g, '');
const last9 = (v) => digits(v).slice(-9);

const { data: tenants, error: tenantError } = await sb
  .from('bot_tenants')
  .select('id, client_name, client_phone, is_active, status');
if (tenantError) {
  console.error('Cannot read bot_tenants: ' + tenantError.message);
  process.exit(1);
}

const wanted = last9(tenantQuery);
const matches = (tenants || []).filter((t) => {
  if (wanted && last9(t.client_phone) === wanted) return true;
  return String(t.client_name || '').toLowerCase().includes(tenantQuery.toLowerCase());
});
if (matches.length === 0) {
  console.error('No tenant matches "' + tenantQuery + '". Known tenants: '
    + (tenants || []).map((t) => t.client_name + ' (' + t.client_phone + ')').join(', '));
  process.exit(1);
}
if (matches.length > 1) {
  console.error('That matches ' + matches.length + ' tenants; use the phone number instead:\n  '
    + matches.map((t) => t.client_name + ' (' + t.client_phone + ')').join('\n  '));
  process.exit(1);
}

const tenant = matches[0];
const listText = from ? fs.readFileSync(path.resolve(String(from)), 'utf8').replace(/^\uFEFF/, '') : String(text);
const prefix = tenantPrefix(tenant.client_name);
const plan = parsePriceList(listText, { prefix });
const stats = summarise(plan);

const { data: existingRows, error: productError } = await sb
  .from('bot_products')
  .select('sku')
  .eq('bot_tenant_id', tenant.id);
if (productError) {
  console.error('Cannot read bot_products: ' + productError.message);
  process.exit(1);
}
const existing = new Set((existingRows || []).map((r) => String(r.sku || '').toUpperCase()));
const creates = plan.rows.filter((r) => !existing.has(r.sku)).length;
const updates = plan.rows.length - creates;


if (asJson) {
  console.log(JSON.stringify({
    tenant: { id: tenant.id, name: tenant.client_name, phone: tenant.client_phone, active: tenant.is_active },
    stats, creates, updates,
    rows: plan.rows, skipped: plan.skipped, applied: false
  }, null, 2));
  process.exit(0);
}

console.log(`\n-- Catalogue import · ${tenant.client_name} (${tenant.client_phone}) ---`);
console.log(`   ${stats.readable} readable · ${stats.skipped} refused · ${creates} new · ${updates} update`
  + ` · stock value ${currency} ${stats.stock_value.toLocaleString('en-KE')}`);
if (stats.readable) {
  console.log(`   prices ${currency} ${stats.cheapest.toLocaleString('en-KE')} – ${stats.dearest.toLocaleString('en-KE')}`);
}
console.log('');

const width = Math.max(10, ...plan.rows.map((r) => r.name.length));
for (const row of plan.rows) {
  console.log('   ' + row.sku.padEnd(16) + row.name.padEnd(width + 2)
    + currency + ' ' + String(row.price).padStart(9) + '   stock ' + row.stock);
}

if (plan.skipped.length) {
  console.log('\n   REFUSED (fix these lines and paste again — nothing is invented):');
  for (const s of plan.skipped) {
    console.log('   line ' + s.line + ': ' + s.reason);
    console.log('      ' + String(s.raw || '').slice(0, 90));
  }
}

if (!stats.readable) {
  console.log('\nNothing importable. The accepted shapes are:\n'
    + '   Omo 1kg | OMO-1KG | 320 | 12\n   Omo 1kg, 320\n   Omo 1kg - KES 320\n'
    + '   Omo 1kg<TAB>320<TAB>12   (paste from a spreadsheet)\n');
  process.exit(1);
}

if (!apply) {
  console.log('\nDry run. Nothing was written. Re-run with --apply to put these '
    + stats.readable + ' row(s) on ' + tenant.client_name + '\'s shelf.\n');
  process.exit(0);
}

const payload = plan.rows.map((row) => toProduct(row, { tenantId: tenant.id, currency }));
const { error: writeError } = await sb
  .from('bot_products')
  .upsert(payload, { onConflict: 'bot_tenant_id,sku' });
if (writeError) {
  console.error('\nWrite failed: ' + writeError.message);
  console.error('PostgREST applies the upsert as one statement, so nothing was half-written.');
  process.exit(1);
}

console.log(`\nWritten: ${plan.rows.length} row(s) on ${tenant.client_name}.`);
console.log('Next: `npm run money:routine` — TENANTS should now show this client with a catalogue,');
console.log('and the bot can answer from it. Reload the catalogue the bot sees before you demo.\n');
