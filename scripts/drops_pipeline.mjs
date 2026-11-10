#!/usr/bin/env node

/**
 * The drops pipeline (2026-11-10).
 *
 * Reads the catalogue and the demand signals, scores every product against the
 * signals it names, checks that its pack exists, and either prints a report or
 * upserts the catalogue into `digital_products`.
 *
 * Why it exists as a script and not a cron job: the expensive part is deciding
 * what to sell and at what price, and that decision should be visible before it
 * reaches a buyer. This prints the decision; `--apply` publishes it.
 *
 * Usage:
 *   node scripts/drops_pipeline.mjs                 # report only, no network
 *   node scripts/drops_pipeline.mjs --json          # machine-readable
 *   node scripts/drops_pipeline.mjs --apply         # upsert published rows
 *   node scripts/drops_pipeline.mjs --apply --all   # include drafts
 *
 * Exit codes: 0 = ok, 1 = an invalid catalogue row or a missing pack.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// `--apply` reads SB_URL / SB_SERVICE_ROLE_KEY. Without this line the report still
// works (it needs no credentials) while publishing claims there are none — which
// is exactly how it failed on 2026-11-11 with the keys sitting in .env.
import 'dotenv/config';
import {
  validateProduct,
  validateLeadMagnet,
  quoteCheckout,
  revenueSummary,
  formatPrice,
  funnelStepOf,
  funnelStepIndex,
  isForwardStep,
  nextOfferFor,
  FUNNEL_STEPS,
  ASSET_DIR,
} from '../utils/digitalDrops.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, 'data', 'drops_catalog.json');
const signalsPath = path.join(root, 'data', 'demand_signals.json');
const reportPath = path.join(root, 'docs', 'DROPS_DEMAND_REPORT.md');
const assetDir = path.join(root, ASSET_DIR);

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const apply = args.includes('--apply');
const includeDrafts = args.includes('--all');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function scoreProduct(product, signals) {
  const keys = (product.demand && Array.isArray(product.demand.signals)) ? product.demand.signals : [];
  const scored = keys
    .map((k) => signals[k])
    .filter(Boolean)
    .map((s) => Number(s.score) || 0);
  if (!scored.length) return { score: 50, evidence: [], signals: keys, unknown: keys };
  const mean = scored.reduce((a, b) => a + b, 0) / scored.length;
  return {
    score: Math.round(mean),
    evidence: keys.filter((k) => signals[k]).map((k) => ({ key: k, ...signals[k] })),
    signals: keys,
    unknown: keys.filter((k) => !signals[k]),
  };
}

function packState(product) {
  const raw = String(product.asset_file || '');
  if (!raw) return { ok: false, note: 'no asset_file set' };
  const abs = path.join(assetDir, path.basename(raw));
  if (!fs.existsSync(abs)) return { ok: false, note: 'not built (npm run drops:build)', abs };
  return { ok: true, note: Math.round(fs.statSync(abs).size / 1024) + ' KB', abs };
}

function priceLadder(products) {
  return products
    .slice()
    .sort((a, b) => a.price_kes - b.price_kes)
    .map((p) => ({ slug: p.slug, price: p.price_kes }));
}

/** Arithmetic on list prices only. Not a forecast: no traffic assumption is made. */
function scenario(products) {
  return products.map((p) => {
    const quote = quoteCheckout(p, null);
    const amount = quote.ok ? quote.amount : 0;
    const summary = revenueSummary(Array.from({ length: 10 }, () => ({ status: 'paid', amount, product_slug: p.slug, product_title: p.title })));
    return { slug: p.slug, unit: amount, ten_sales_net: summary.net, ten_sales_fees: summary.fees };
  });
}

function buildReport(rows, signals, meta) {
  const lines = [];
  lines.push('# Digital Drops — demand report');
  lines.push('');
  lines.push('_Generated ' + meta.generated + ' by `npm run drops:report`. Prices are list anchors; demand scores are the mean of the signals each product names. Neither is a forecast._');
  lines.push('');
  lines.push('## Catalogue');
  lines.push('');
  lines.push('| # | Product | Kind | Price | USD | Demand | Pack |');
  lines.push('|---:|---|---|---:|---:|---:|---|');
  rows.forEach((r, i) => {
    lines.push('| ' + (i + 1) + ' | ' + r.title + ' | ' + r.kind + ' | ' + formatPrice(r.price_kes) + ' | ' +
      (r.price_usd ? '$' + r.price_usd : '—') + ' | ' + r.demand.score + ' | ' + (r.pack.ok ? r.pack.note : r.pack.note) + ' |');
  });
  lines.push('');
  lines.push('## What each product is standing on');
  lines.push('');
  for (const r of rows) {
    lines.push('### ' + r.title + ' — ' + formatPrice(r.price_kes) + ' (demand ' + r.demand.score + ')');
    if (r.demand.evidence.length) {
      for (const e of r.demand.evidence) lines.push('- **' + e.label + '** (' + e.score + '): ' + e.value + '. _' + e.source + '_, checked ' + e.checked + '.');
    } else {
      lines.push('- No sourced signal attached. This product is a hunch; attach evidence or leave it in draft.');
    }
    if (r.demand.unknown.length) lines.push('- Unknown signals: ' + r.demand.unknown.join(', '));
    if (r.note) lines.push('- ' + r.note);
    lines.push('');
  }
  lines.push('## Ten sales, at list price');
  lines.push('');
  lines.push('| Product | Unit | Fee (0.99%) | Net on 10 |');
  lines.push('|---|---:|---:|---:|');
  for (const s of meta.scenario) {
    const fee = Math.round(s.ten_sales_fees * 100) / 100;
    lines.push('| ' + s.slug + ' | ' + formatPrice(s.unit) + ' | ' + formatPrice(fee) + ' | ' + formatPrice(s.ten_sales_net) + ' |');
  }
  lines.push('');
  lines.push('Ten sales is not a target or a promise. It is the smallest number that shows whether a price is real: if ten sales at list does not cover the week it took to build the pack, the price or the pack is wrong.');
  lines.push('');
  lines.push('## Ladder');
  lines.push('');
  lines.push(meta.ladder.map((l) => '- ' + l.slug + ' — ' + formatPrice(l.price)).join('\n'));
  lines.push('');
  lines.push('## The funnel');
  lines.push('');
  lines.push('| # | Rung | Products | Free packs |');
  lines.push('|---:|---|---|---|');
  for (const r of meta.rungs || []) {
    lines.push('| ' + r.order + ' | ' + r.step + ' | ' + (r.products.length ? r.products.join(', ') : '—') +
      ' | ' + (r.magnets.length ? r.magnets.join(', ') : '—') + ' |');
  }
  lines.push('');
  lines.push('A buyer enters free and is handed the next rung by the pack they just bought: `next_slug` where the explicit link is better than the arithmetic, otherwise the cheapest product on a higher rung. A rung that is empty is a hole a visitor can fall through, not a formatting issue.');
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('- Every published row validates (`validateProduct`): ' + (meta.invalid.length ? '**FAILED** — ' + meta.invalid.join('; ') : 'yes'));
  lines.push('- Every published row has a built pack: ' + (meta.missingPacks.length ? '**MISSING** — ' + meta.missingPacks.join(', ') : 'yes'));
  lines.push('- Bumps point at a published product: ' + (meta.badBumps.length ? '**BROKEN** — ' + meta.badBumps.join(', ') : 'yes'));
  lines.push('- Every free pack validates and has a built file: ' + (meta.badMagnets.length || (meta.missingPacks || []).some((m) => /\(free\)$/.test(m)) ? '**FAILED** — ' + [...meta.badMagnets, ...(meta.missingPacks || []).filter((m) => /\(free\)$/.test(m))].join('; ') : 'yes'));
  lines.push('- Every next offer points forward at a published rung: ' + (meta.badNext.length ? '**BROKEN** — ' + meta.badNext.join('; ') : 'yes'));
  lines.push('- Rungs with nothing on them: ' + ((meta.emptyRungs || []).length ? (meta.emptyRungs.join(', ') + ' (visible to a visitor as a gap)') : 'none'));
  lines.push('');
  return lines.join('\n');
}

async function connect() {
  const url = process.env.SUPABASE_URL || process.env.SB_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Cannot --apply without SUPABASE_URL/SB_URL and SUPABASE_SERVICE_ROLE_KEY/SB_SERVICE_ROLE_KEY.');
    process.exit(1);
  }
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function publish(products) {
  const sb = await connect();
  const now = new Date().toISOString();
  const payload = products.map((p) => ({
    slug: p.slug,
    title: p.title,
    kind: p.kind,
    status: p.status,
    summary: p.summary,
    outcomes: p.outcomes,
    modules: p.modules,
    price_kes: p.price_kes,
    price_usd: p.price_usd,
    compare_at_kes: p.compare_at_kes,
    bump_slug: p.bump_slug,
    asset_file: p.asset_file,
    delivery_note: p.delivery_note,
    rank: p.rank,
    funnel_step: p.funnel_step,
    next_slug: p.next_slug,
    metadata: { seo: p.seo || null, demand: p.demand || null },
    updated_at: now,
  }));
  const { error } = await sb.from('digital_products').upsert(payload, { onConflict: 'slug' });
  if (error) {
    // Rollout order is a real thing: the code ships before a human pastes the SQL.
    // A database without the 2026-11-12 columns can still be published to — without
    // the rungs — instead of failing the whole catalogue.
    const missingRung = /funnel_step|next_slug/i.test(error.message || '')
      && /column|does not exist|could not find|PGRST204/i.test(error.message || '');
    if (missingRung) {
      const legacy = payload.map(({ funnel_step, next_slug, ...rest }) => rest);
      const retry = await sb.from('digital_products').upsert(legacy, { onConflict: 'slug' });
      if (!retry.error) {
        console.warn('Published without funnel rungs: ' + error.message);
        console.warn('Run migrations/2026-11-12_drops_funnel.sql, then publish again to attach the rungs.');
        console.log('Published ' + legacy.length + ' product(s) to digital_products (no rungs).');
        return;
      }
      console.error('Upsert failed on retry: ' + retry.error.message);
      process.exit(1);
    }
    console.error('Upsert failed: ' + error.message);
    console.error('If the table is missing, run migrations/2026-11-10_digital_drops.sql first.');
    process.exit(1);
  }
  console.log('Published ' + payload.length + ' product(s) to digital_products.');
}

/**
 * The free shelf, published separately and tolerantly: a database that has not run
 * the 2026-11-12 file yet can still sell paid packs. The magnet table is additive,
 * so a missing one is a warning that names the file, not a failed publish.
 */
async function publishMagnets(magnets) {
  if (!magnets.length) return;
  const sb = await connect();
  const now = new Date().toISOString();
  const payload = magnets.map((m) => ({
    slug: m.slug,
    title: m.title,
    summary: m.summary,
    promise: m.promise,
    modules: m.modules,
    outcomes: m.outcomes,
    asset_file: m.asset_file,
    next_slug: m.next_slug,
    status: m.status,
    rank: m.rank,
    metadata: { asset_sources: (m.raw && m.raw.asset_sources) || [] },
    updated_at: now,
  }));
  const { error } = await sb.from('digital_lead_magnets').upsert(payload, { onConflict: 'slug' });
  if (error) {
    const missing = /does not exist|schema cache|could not find the table|42P01|PGRST205/i.test(error.message || '');
    if (missing) {
      console.warn('Free packs not published: digital_lead_magnets does not exist yet. Run migrations/2026-11-12_drops_funnel.sql.');
      return;
    }
    console.error('Magnet upsert failed: ' + error.message);
    process.exit(1);
  }
  console.log('Published ' + payload.length + ' free pack(s) to digital_lead_magnets.');
}

async function main() {
  const raw = readJson(catalogPath);
  const signalDoc = readJson(signalsPath);
  const signals = signalDoc.signals || {};
  const anchors = signalDoc.price_anchors || {};
  const rawProducts = (Array.isArray(raw) ? raw : raw.products || [])
    .filter((p) => includeDrafts || p.status === 'published');

  const invalid = [];
  const missingPacks = [];
  const badBumps = [];
  const valid = [];

  for (const rp of rawProducts) {
    const filled = { ...rp };
    if (!filled.price_kes && anchors[filled.kind]) filled.price_kes = anchors[filled.kind];
    const checked = validateProduct(filled);
    if (!checked.ok) {
      invalid.push((rp.slug || rp.title || '(untitled)') + ': ' + checked.errors.join('; '));
      continue;
    }
    valid.push({ ...checked.value, raw: rp });
  }

  const publishedSlugs = new Set(valid.filter((v) => v.status === 'published').map((v) => v.slug));
  const rows = valid.map((v) => {
    const pack = packState(v);
    if (v.status === 'published' && !pack.ok) missingPacks.push(v.slug);
    if (v.bump_slug && !publishedSlugs.has(v.bump_slug)) badBumps.push(v.slug + ' -> ' + v.bump_slug);
    return {
      ...v,
      pack,
      demand: scoreProduct(v.raw, signals),
      note: (v.raw.demand && v.raw.demand.note) || '',
    };
  });

  // ---- the funnel: rungs, links and the free shelf (2026-11-12) --------------
  // A catalogue where every row validates can still be a funnel that leads nowhere.
  // These are the three ways that happens, and each one is reported rather than
  // silently repaired: a broken upsell is a decision, not a typo.
  const badNext = [];
  for (const r of rows) {
    if (r.status !== 'published') continue;
    const target = r.next_slug ? rows.find((x) => x.slug === r.next_slug) : null;
    if (r.next_slug && !target) {
      badNext.push(r.slug + ' -> ' + r.next_slug + ' (no such product)');
      continue;
    }
    if (target && !isForwardStep(r, target)) {
      badNext.push(r.slug + ' (' + funnelStepOf(r) + ') -> ' + target.slug + ' (' + funnelStepOf(target) + '): not a step up in price or rung');
    }
  }

  const rawMagnets = (Array.isArray(raw) ? [] : raw.lead_magnets || [])
    .filter((m) => includeDrafts || m.status === 'published');
  const magnets = [];
  const badMagnets = [];
  for (const rm of rawMagnets) {
    const checked = validateLeadMagnet(rm);
    if (!checked.ok) {
      badMagnets.push((rm.slug || rm.title || '(untitled)') + ': ' + checked.errors.join('; '));
      continue;
    }
    const pack = packState(checked.value);
    if (checked.value.status === 'published' && !pack.ok) missingPacks.push(checked.value.slug + ' (free)');
    if (checked.value.next_slug && !publishedSlugs.has(checked.value.next_slug)) {
      badNext.push(checked.value.slug + ' (free) -> ' + checked.value.next_slug + ' (not published)');
    }
    magnets.push({ ...checked.value, pack, raw: rm });
  }

  const rungs = FUNNEL_STEPS.map((step) => ({
    step: step.key,
    order: step.order,
    products: rows.filter((r) => r.status === 'published' && funnelStepOf(r) === step.key).map((r) => r.slug),
    magnets: step.key === 'lead' ? magnets.filter((m) => m.status === 'published').map((m) => m.slug) : [],
  }));
  const emptyRungs = rungs.filter((r) => !r.products.length && !r.magnets.length).map((r) => r.step);

  const meta = {
    generated: new Date().toISOString().slice(0, 10),
    scenario: scenario(rows),
    ladder: priceLadder(rows),
    invalid,
    missingPacks,
    badBumps,
    badNext,
    badMagnets,
    rungs,
    emptyRungs,
    magnets: magnets.map((m) => ({ slug: m.slug, title: m.title, next_slug: m.next_slug, pack: m.pack.ok ? m.pack.note : m.pack.note })),
  };

  if (asJson) {
    console.log(JSON.stringify({
      ok: invalid.length === 0 && missingPacks.length === 0 && badBumps.length === 0,
      products: rows.map((r) => ({
        slug: r.slug, title: r.title, kind: r.kind, status: r.status,
        price_kes: r.price_kes, price_usd: r.price_usd, bump_slug: r.bump_slug,
        funnel_step: funnelStepOf(r), next_slug: r.next_slug,
        demand: r.demand.score, signals: r.demand.signals,
        pack: r.pack.ok ? 'built' : r.pack.note,
      })),
      magnets: meta.magnets,
      rungs: meta.rungs,
      emptyRungs: meta.emptyRungs,
      ...meta,
    }, null, 2));
  } else {
    console.log('Digital drops — ' + rows.length + ' product(s)\n');
    console.log('  ' + 'PRODUCT'.padEnd(34) + 'KIND'.padEnd(12) + 'PRICE'.padStart(10) + 'DEMAND'.padStart(8) + '  PACK');
    for (const r of rows) {
      console.log('  ' + r.slug.padEnd(34).slice(0, 34) + r.kind.padEnd(12) +
        formatPrice(r.price_kes).padStart(10) + String(r.demand.score).padStart(8) +
        '  ' + (r.pack.ok ? r.pack.note : r.pack.note));
    }
    if (invalid.length) console.log('\nInvalid rows:\n  - ' + invalid.join('\n  - '));
    if (missingPacks.length) console.log('\nMissing packs (run npm run drops:build): ' + missingPacks.join(', '));
    if (badBumps.length) console.log('\nBroken bumps: ' + badBumps.join(', '));
    console.log('\nFunnel (free first, then each rung hands the buyer the next)');
    for (const r of meta.rungs) {
      const items = [...r.magnets.map((m) => m + ' (free)'), ...r.products];
      console.log('  ' + r.step.padEnd(12) + (items.length ? items.join(', ') : '(empty)'));
    }
    if (meta.badNext.length) console.log('\nBroken next offers: ' + meta.badNext.join('; '));
    if (meta.badMagnets.length) console.log('\nInvalid free packs: ' + meta.badMagnets.join('; '));
    if (meta.emptyRungs.length) console.log('Empty rungs (not a failure, but the storefront shows the gap): ' + meta.emptyRungs.join(', '));
  }

  const report = buildReport(rows, signals, meta);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report + '\n', 'utf8');
  if (!asJson) console.log('\nReport written to ' + path.relative(root, reportPath));

  if (apply) {
    const toPublish = rows.filter((r) => r.status === 'published').map((r) => ({
      ...r,
      seo: (r.raw && r.raw.seo) || null,
      demand: (r.raw && r.raw.demand) || null,
    }));
    await publish(toPublish);
    await publishMagnets(magnets.map((m) => ({
      ...m,
      raw: (m.raw && m.raw) || null,
    })));
  }

  process.exit(invalid.length || missingPacks.length || badBumps.length || badNext.length || badMagnets.length ? 1 : 0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();


