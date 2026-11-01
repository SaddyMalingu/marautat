#!/usr/bin/env node

/**
 * Attribute offers to their marketplace (2026-11-02)
 *
 * Why this exists: every one of the tenant's 96 offers had `source_id = NULL`, so the
 * portal's coverage funnel read "(none)" and fell back to guessing from slugs. The seed
 * migration `2026-10-31_seed_micro1_turing_sources.sql` was never applied, so
 * `opportunity_sources` held only mercor and respondent.
 *
 * This is DML, not DDL — it runs with the service-role key and is idempotent:
 *
 *   1. ensures the Micro1 / Turing source rows exist
 *   2. sets `opportunities.source_id` only where the *evidence* is concrete:
 *        - the importer's own slug convention  `<tenant>-<marketplace>-<role>`
 *        - a referral link on the marketplace's own host
 *   3. leaves hand-made offers alone. A guess here would be worse than a null: the funnel
 *      would confidently attribute somebody's own product to Micro1.
 *
 * Usage:
 *   node scripts/backfill_offer_sources.mjs --tenant malingu-ventures          # report only
 *   node scripts/backfill_offer_sources.mjs --tenant malingu-ventures --apply
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
};

const tenantSlug = flag('tenant');
const apply = flag('apply', null) !== null;
if (!tenantSlug) {
  console.error('usage: --tenant <slug> [--apply]');
  process.exit(1);
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key);

/** The two marketplaces this repository has adapters for. */
const SOURCES = [
  { slug: 'micro1', name: 'Micro1', base_url: 'https://refer.micro1.ai', metadata: { portalUrl: 'https://refer.micro1.ai/opportunities', auth: 'tenant_account' } },
  { slug: 'turing', name: 'Turing', base_url: 'https://work.turing.com', metadata: { portalUrl: 'https://work.turing.com/jobs', auth: 'tenant_account' } }
];

/**
 * Which marketplace owns this offer — by evidence only.
 *
 * Pure and exported so the rule can be tested without a database.
 */
export function sourceEvidenceFor(offer, tenantSlugValue) {
  const slug = String(offer?.slug || '').toLowerCase();
  const tenantToken = String(tenantSlugValue || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const referral = String(offer?.referral_url || '').toLowerCase();

  // The importer writes `<tenant>-<marketplace>-<role>`, so this is our own data rather
  // than an inference about the marketplace.
  for (const source of SOURCES) {
    if (tenantToken && slug.startsWith(`${tenantToken}-${source.slug}-`)) {
      return { slug: source.slug, reason: 'slug_convention' };
    }
  }
  // A referral link on the marketplace's own host is direct evidence.
  if (referral.includes('jobs.micro1.ai') || referral.includes('refer.micro1.ai')) {
    return { slug: 'micro1', reason: 'referral_host' };
  }
  if (referral.includes('turing.com')) return { slug: 'turing', reason: 'referral_host' };
  return null;
}

async function ensureSources(tenantId) {
  const ids = {};
  for (const source of SOURCES) {
    const { data: existing, error } = await supabase
      .from('opportunity_sources').select('id, slug').eq('slug', source.slug).maybeSingle();
    if (error) throw error;
    if (existing) { ids[source.slug] = existing.id; continue; }
    if (!apply) { ids[source.slug] = null; console.error(`would create source ${source.slug}`); continue; }
    const { data: created, error: insertError } = await supabase
      .from('opportunity_sources')
      .insert({ ...source, source_type: 'account', is_active: true, tenant_id: tenantId })
      .select('id, slug').maybeSingle();
    if (insertError) throw insertError;
    ids[source.slug] = created?.id || null;
    console.error(`created source ${source.slug}`);
  }
  return ids;
}

async function main() {
  const { data: tenant, error: tenantError } = await supabase
    .from('site_tenants').select('id, slug').eq('slug', tenantSlug).maybeSingle();
  if (tenantError) throw tenantError;
  if (!tenant) { console.error(`No tenant with slug "${tenantSlug}"`); process.exit(2); }

  const sourceIds = await ensureSources(tenant.id);

  const { data: offers, error } = await supabase
    .from('opportunities')
    .select('id, slug, title, referral_url, source_id')
    .eq('tenant_id', tenant.id);
  if (error) throw error;

  const plan = [];
  const unattributed = [];
  for (const offer of offers || []) {
    const evidence = sourceEvidenceFor(offer, tenant.slug);
    // No evidence and no existing attribution: leave it alone and say so.
    if (!evidence) { if (!offer.source_id) unattributed.push(offer.title); continue; }
    const target = sourceIds[evidence.slug] || null;
    if (!target || offer.source_id === target) continue;
    plan.push({ id: offer.id, title: offer.title, source: evidence.slug, reason: evidence.reason });
  }

  console.error(`${offers.length} offers · ${plan.length} to attribute · ${unattributed.length} left unattributed (no evidence)`);
  if (unattributed.length) console.error(`  unattributed: ${unattributed.slice(0, 6).join(' | ')}`);

  if (!apply) {
    console.log(JSON.stringify({ tenant: tenant.slug, planned: plan.length, unattributed: unattributed.length, sample: plan.slice(0, 8) }, null, 1));
    return;
  }

  let updated = 0;
  for (const row of plan) {
    const { error: updateError } = await supabase
      .from('opportunities').update({ source_id: sourceIds[row.source] }).eq('id', row.id);
    if (updateError) { console.error(`failed on ${row.title}: ${updateError.message}`); continue; }
    updated += 1;
  }
  console.log(JSON.stringify({ tenant: tenant.slug, planned: plan.length, updated, unattributed: unattributed.length }, null, 1));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});

