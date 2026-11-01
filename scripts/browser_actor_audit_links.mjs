#!/usr/bin/env node

/**
 * Audit every referral link a tenant already has (2026-10-31).
 *
 *   node scripts/browser_actor_audit_links.mjs --tenant malingu-ventures
 *   ... --clear-mismatches        # blank the links that point at the wrong job
 *
 * Why this exists: a wrong referral link is worse than no link. It pays the tenant
 * for a job the candidate never read about, and sends the candidate somewhere that
 * does not match the page. The capture guard ("never overwrite an existing link")
 * protects good data and bad data equally, so stored links need to be *checked*.
 *
 * Read-only by default. It resolves each URL and compares the page title with the
 * offer title — the same rule the capture path uses before writing.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { verifyReferralLink, planCodeIntegrity } from '../utils/browserActor/referralVerify.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

const tenantSlug = String(flag('tenant', '')).trim();
const clearMismatches = flag('clear-mismatches', null) !== null;
// Recording is what lets the portal show link health without resolving every link on
// each page load. --no-record keeps the audit purely diagnostic.
const recordVerdicts = flag('no-record', null) === null;
if (!tenantSlug) {
  console.error('usage: --tenant <slug> [--clear-mismatches]');
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SB_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SB_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data: tenant, error } = await supabase
    .from('site_tenants').select('id, slug').eq('slug', tenantSlug).maybeSingle();
  if (error) throw error;
  if (!tenant) {
    console.error(`No tenant with slug "${tenantSlug}".`);
    process.exit(2);
  }

  const { data: offers, error: offersError } = await supabase
    .from('opportunities')
    .select('id, title, referral_url, status, tenant_id')
    .eq('tenant_id', tenant.id)
    .not('referral_url', 'is', null);
  if (offersError) throw offersError;

  const rows = offers || [];
  console.error(`tenant=${tenant.slug} links_to_check=${rows.length}`);

  const results = [];
  for (const offer of rows) {
    const check = await verifyReferralLink({ url: offer.referral_url, expectedTitle: offer.title });
    results.push({ ...offer, ...check });
    const mark = check.verdict === 'match' ? 'OK  ' : check.verdict === 'mismatch' ? 'WRONG' : '???? ';
    console.error(`  ${mark} ${String(offer.title).slice(0, 46).padEnd(46)} -> ${check.resolvedTitle || check.reason}`);
  }

  const mismatches = results.filter((r) => r.verdict === 'mismatch');
  const matches = results.filter((r) => r.verdict === 'match');
  const unknown = results.filter((r) => r.verdict === 'unresolvable');

  // Title verification says "right job". This says "right payee". A link can land on
  // the correct job while crediting another account, which pays the wrong person for
  // work the tenant did.
  const codeIntegrity = planCodeIntegrity(results);
  for (const [host, stat] of Object.entries(codeIntegrity.summary)) {
    console.error(`  codes ${host}: ${stat.codes} distinct across ${stat.links} links (dominant ${stat.dominantCode} ×${stat.dominantCount})`);
  }
  for (const issue of codeIntegrity.issues) {
    console.error(`  CODE ISSUE ${issue.reason}: ${issue.detail}`);
  }

  // Persist the verdict so the portal can answer "is any link wrong?" without
  // resolving 76 URLs on every page load.
  //
  // Grouped by verdict, not one UPDATE per row: 76 sequential round-trips took long
  // enough that a run could be interrupted after all the work was done and before
  // anything was saved. Two queries cannot be interrupted the same way.
  let recorded = 0;
  let recordError = null;
  if (recordVerdicts) {
    const checkedAt = new Date().toISOString();
    const byVerdict = new Map();
    for (const row of results) {
      if (!row.id) continue;
      const bucket = byVerdict.get(row.verdict) || [];
      bucket.push(row.id);
      byVerdict.set(row.verdict, bucket);
    }
    for (const [verdict, ids] of byVerdict) {
      for (let at = 0; at < ids.length; at += 50) {
        const chunk = ids.slice(at, at + 50);
        const { data, error: recordFailure } = await supabase
          .from('opportunities')
          .update({ link_verdict: verdict, link_checked_at: checkedAt })
          .in('id', chunk)
          .select('id');
        if (recordFailure) {
          recordError = recordFailure.message;
          break;
        }
        recorded += Array.isArray(data) ? data.length : 0;
      }
      if (recordError) break;
    }
    if (recordError) {
      console.error(`could not record verdicts (${recordError}) — apply migrations/2026-11-01_add_referral_link_verification.sql`);
    } else {
      console.error(`recorded ${recorded} verdict(s)`);
    }
  }

  let cleared = [];
  if (clearMismatches && mismatches.length) {
    for (const row of mismatches) {
      const { error: clearError } = await supabase
        .from('opportunities')
        .update({ referral_url: null, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('referral_url', row.referral_url);
      if (!clearError) cleared.push({ title: row.title, removed: row.referral_url, was_pointing_at: row.resolvedTitle });
    }
  }

  console.log(JSON.stringify({
    tenant: tenant.slug,
    checked: results.length,
    verdicts: { match: matches.length, mismatch: mismatches.length, unresolvable: unknown.length },
    mismatches: mismatches.map((r) => ({
      id: r.id,
      title: r.title,
      referral_url: r.referral_url,
      points_at: r.resolvedTitle,
      action: clearMismatches ? 'cleared' : 'needs_replacing'
    })),
    unresolvable: unknown.map((r) => ({ title: r.title, reason: r.reason })),
    codeIntegrity,
    recorded: recordVerdicts ? { count: recorded, error: recordError } : 'skipped',
    cleared
  }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
