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
import { validateProduct, quoteCheckout, revenueSummary, formatPrice, ASSET_DIR } from '../utils/digitalDrops.js';

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
  lines.push('## Checks');
  lines.push('');
  lines.push('- Every published row validates (`validateProduct`): ' + (meta.invalid.length ? '**FAILED** — ' + meta.invalid.join('; ') : 'yes'));
  lines.push('- Every published row has a built pack: ' + (meta.missingPacks.length ? '**MISSING** — ' + meta.missingPacks.join(', ') : 'yes'));
  lines.push('- Bumps point at a published product: ' + (meta.badBumps.length ? '**BROKEN** — ' + meta.badBumps.join(', ') : 'yes'));
  lines.push('');
  return lines.join('\n');
}

async function publish(products) {
  const url = process.env.SUPABASE_URL || process.env.SB_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Cannot --apply without SUPABASE_URL/SB_URL and SUPABASE_SERVICE_ROLE_KEY/SB_SERVICE_ROLE_KEY.');
    process.exit(1);
  }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(url, key, { auth: { persistSession: false } });
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
    metadata: { seo: p.seo || null, demand: p.demand || null },
    updated_at: now,
  }));
  const { error } = await sb.from('digital_products').upsert(payload, { onConflict: 'slug' });
  if (error) {
    console.error('Upsert failed: ' + error.message);
    console.error('If the table is missing, run migrations/2026-11-10_digital_drops.sql first.');
    process.exit(1);
  }
  console.log('Published ' + payload.length + ' product(s) to digital_products.');
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

  const meta = {
    generated: new Date().toISOString().slice(0, 10),
    scenario: scenario(rows),
    ladder: priceLadder(rows),
    invalid,
    missingPacks,
    badBumps,
  };

  if (asJson) {
    console.log(JSON.stringify({
      ok: invalid.length === 0 && missingPacks.length === 0 && badBumps.length === 0,
      products: rows.map((r) => ({
        slug: r.slug, title: r.title, kind: r.kind, status: r.status,
        price_kes: r.price_kes, price_usd: r.price_usd, bump_slug: r.bump_slug,
        demand: r.demand.score, signals: r.demand.signals,
        pack: r.pack.ok ? 'built' : r.pack.note,
      })),
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
  }

  process.exit(invalid.length || missingPacks.length || badBumps.length ? 1 : 0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();


