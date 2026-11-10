#!/usr/bin/env node

/**
 * What does this database actually have? (2026-11-11)
 *
 * Written after a real failure: running the 2026-11-11 card-lane migration before
 * the 2026-11-10 base migration returned
 *
 *     42P01: relation "public.digital_products" does not exist
 *
 * which reads like a broken migration instead of a missing prerequisite. This
 * script answers the question directly, per object, and names the file to run.
 *
 * It only SELECTs. It cannot create, alter, insert or delete anything.
 *
 *   npm run drops:doctor
 *   npm run drops:doctor -- --json
 */
import 'dotenv/config';

const args = process.argv.slice(2);
const asJson = args.includes('--json');

const checks = [
  { table: 'digital_products', columns: ['slug', 'price_kes', 'outcomes'], migration: '2026-11-10' },
  { table: 'digital_products', columns: ['payment_lane'], migration: '2026-11-11' },
  { table: 'digital_products', columns: ['funnel_step', 'next_slug'], migration: '2026-11-12' },
  { table: 'digital_lead_magnets', columns: ['slug', 'asset_file', 'next_slug'], migration: '2026-11-12' },
  { table: 'digital_leads', columns: ['magnet_slug', 'email', 'phone', 'consent'], migration: '2026-11-12' },
  { table: 'digital_orders', columns: ['order_ref', 'amount', 'status'], migration: '2026-11-10' },
  { table: 'digital_orders', columns: ['lane', 'customer_email', 'checkout_url'], migration: '2026-11-11' },
  { table: 'digital_entitlements', columns: ['token', 'expires_at'], migration: '2026-11-10' },
  { table: 'digital_events', columns: ['event'], migration: '2026-11-10' },
  { table: 'service_requests', columns: ['budget', 'timeline', 'status'], migration: '2026-11-11' },
];

const url = process.env.SUPABASE_URL || process.env.SB_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('No Supabase credentials in this shell.');
  console.error('Set SB_URL + SB_SERVICE_ROLE_KEY (or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), then re-run.');
  console.error('Nothing was queried.');
  process.exit(2);
}

const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(url, key, { auth: { persistSession: false } });

// Order matters. PostgREST says "column digital_products.funnel_step does not exist"
// for a missing column, and the word "does not exist" used to match the *table*
// pattern first — which made the doctor report a missing table for a table that was
// there, and tell the operator to re-run a migration they had already run.
const MISSING_COLUMN = /column .* does not exist|could not find the .* column|PGRST204/i;
const MISSING_TABLE = /relation .* does not exist|could not find the table|PGRST205|schema cache/i;

const results = [];
for (const check of checks) {
  const { error } = await sb.from(check.table).select(check.columns.join(', ')).limit(1);
  let status = 'ok';
  if (error) {
    if (MISSING_COLUMN.test(error.message || '')) status = 'missing column';
    else if (MISSING_TABLE.test(error.message || '')) status = 'missing table';
    else status = 'error: ' + String(error.message || '').slice(0, 120);
  }
  results.push({ table: check.table, columns: check.columns.join(', '), status, migration: check.migration, error: error ? error.message : null });
}

const failing = results.filter((r) => r.status !== 'ok');

if (asJson) {
  console.log(JSON.stringify({ ok: failing.length === 0, results }, null, 2));
} else {
  console.log('Digital Drops schema — ' + url.replace(/^https?:\/\//, '').split('.')[0] + '.supabase.co\n');
  console.log('  ' + 'OBJECT'.padEnd(26) + 'COLUMNS'.padEnd(38) + 'STATUS'.padEnd(18) + 'MIGRATION');
  for (const r of results) {
    console.log('  ' + r.table.padEnd(26) + r.columns.padEnd(38).slice(0, 38) + r.status.padEnd(18) + r.migration);
  }
  console.log('');
  if (!failing.length) {
    console.log('All expected objects and columns are present.');
  } else {
    const needs = [...new Set(failing.map((f) => f.migration))].sort();
    const anyTable = failing.some((f) => f.status === 'missing table');
    console.log('Missing: ' + (() => {
      const byTable = new Map();
      for (const f of failing) {
        const current = byTable.get(f.table);
        // A missing table is the worse diagnosis, so it wins over a missing column.
        if (!current || (f.status === 'missing table' && current !== 'missing table')) byTable.set(f.table, f.status);
      }
      return [...byTable.entries()].map(([t, s]) => t + ' (' + s + ')').join(', ');
    })());
    if (needs.length === 1 && needs[0] === '2026-11-12') {
      console.log('\nThe base and card-lane files are already applied. Run:');
      console.log('  migrations/2026-11-12_drops_funnel.sql   (funnel rungs + the free shelf)');
    } else if (anyTable && needs.includes('2026-11-12')) {
      console.log('\nRun the files in this order — each one widens the one before it:');
      console.log('  1. migrations/2026-11-10_digital_drops.sql       (the four digital_* tables)');
      console.log('  2. migrations/2026-11-11_digital_drops_card_lane.sql   (card lane + service_requests)');
      console.log('  3. migrations/2026-11-12_drops_funnel.sql       (funnel rungs + the free shelf)');
    } else if (anyTable && needs.includes('2026-11-11')) {
      console.log('\nRun the files in this order — the 11-11 file cannot run first:');
      console.log('  1. migrations/2026-11-10_digital_drops.sql   (creates the four digital_* tables)');
      console.log('  2. migrations/2026-11-11_digital_drops_card_lane.sql   (card lane + service_requests)');
    } else if (needs.includes('2026-11-12')) {
      console.log('\nThe base and card-lane tables exist. Run migrations/2026-11-12_drops_funnel.sql.');
    } else if (needs.includes('2026-11-11')) {
      console.log('\nThe base tables exist. Run migrations/2026-11-11_digital_drops_card_lane.sql.');
    } else {
      console.log('\nRun migrations/2026-11-10_digital_drops.sql (then the 2026-11-11 file).');
    }
    if (failing.some((f) => f.error)) {
      console.log('\nFirst error reported by PostgREST:');
      console.log('  ' + failing.find((f) => f.error).error);
    }
  }
}

process.exit(failing.length ? 1 : 0);
