#!/usr/bin/env node

/**
 * Import collected marketplace roles as DRAFT offers for one tenant (2026-10-31).
 *
 *   node scripts/browser_actor_import.mjs --tenant malingu-ventures \
 *     --in tmp/turing_roles.json            # plan only (default)
 *   ... --apply                             # writes the drafts
 *
 * Safety properties, because this writes to a production table:
 *   - the tenant is resolved from `site_tenants`; an unknown slug writes nothing
 *     and prints the slugs that DO exist, so a typo is obvious instead of silent
 *   - roles already present are skipped, so a second run creates nothing and an
 *     existing offer's referral_url is never overwritten
 *   - every row is `status: 'draft'` — the agent proposes, the tenant publishes
 *   - `--apply` is required; the default is a plan you can read first
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { planOfferImport, attachReferrals } from '../utils/browserActor/offersImport.js';
import { referralForRole } from '../utils/browserActor/referrals.js';
import { getPlatform } from '../utils/browserActor/platforms.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

const tenantSlug = String(flag('tenant', '')).trim();
const inFile = flag('in');
const apply = flag('apply', null) !== null;
const sourceSlug = String(flag('source', 'turing')).trim();
const platform = getPlatform(sourceSlug);

if (!tenantSlug || !inFile) {
  console.error('usage: --tenant <slug> --in <collected.json> [--source turing] [--apply]');
  process.exit(1);
}
if (!platform) {
  console.error(`unknown source "${sourceSlug}" — known: mercor, micro1, turing`);
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SB_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SB_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

function readItems(file) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(String(file)), 'utf8'));
  // Accept both the collector output ({ items }) and a bare array.
  return Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
}

async function main() {
  const items = readItems(inFile);
  if (!items.length) {
    console.error(`No roles in ${inFile} — run browser_actor_collect.mjs first.`);
    process.exit(1);
  }

  const { data: tenant, error: tenantError } = await supabase
    .from('site_tenants').select('id, slug, name').eq('slug', tenantSlug).maybeSingle();

  if (tenantError) throw tenantError;
  if (!tenant) {
    const { data: known } = await supabase.from('site_tenants').select('slug').limit(50);
    console.error(`No tenant with slug "${tenantSlug}". Nothing was written.`);
    console.error(`Existing slugs: ${(known || []).map((row) => row.slug).join(', ') || '(none)'}`);
    process.exit(2);
  }

  // The source row drives source_id on the offer; absent is acceptable.
  let sourceId = null;
  const { data: sourceRow } = await supabase
    .from('opportunity_sources').select('id').eq('slug', sourceSlug).maybeSingle();
  if (sourceRow) sourceId = sourceRow.id;

  const { data: existingOffers, error: offersError } = await supabase
    .from('opportunities')
    .select('id, slug, title, external_id, referral_url, status')
    .eq('tenant_id', tenant.id);
  if (offersError) throw offersError;

  const plan = attachReferrals(
    planOfferImport({
      items,
      existingOffers: existingOffers || [],
      tenantSlug: tenant.slug,
      tenantId: tenant.id,
      sourceSlug,
      sourceId
    }),
    { existingOffers: existingOffers || [], referralForRole, host: new URL(platform.portalUrl).hostname }
  );

  const summary = {
    tenant: { slug: tenant.slug, id: tenant.id, name: tenant.name || null },
    source: sourceSlug,
    found: items.length,
    existing: (existingOffers || []).length,
    willCreate: plan.create.length,
    skipped: plan.skipped,
    needsReferralLink: plan.needsReferral,
    applied: false
  };

  if (!apply) {
    console.log(JSON.stringify({ ...summary, note: 'plan only — re-run with --apply to write drafts' }, null, 2));
    return;
  }
  if (!plan.create.length) {
    console.log(JSON.stringify({ ...summary, note: 'nothing new to write' }, null, 2));
    return;
  }

  const { data: written, error: writeError } = await supabase
    .from('opportunities')
    .insert(plan.create)
    .select('id, slug, title, referral_url, status');
  if (writeError) throw writeError;

  console.log(JSON.stringify({
    ...summary,
    applied: true,
    created: written || []
  }, null, 2));
}

main().catch((error) => {
  console.error(`failed: ${error?.message || error}`);
  process.exit(1);
});
