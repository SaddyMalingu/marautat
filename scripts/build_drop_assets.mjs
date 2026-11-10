#!/usr/bin/env node

/**
 * Build the packs that Digital Drops sells (2026-11-10).
 *
 * Two shapes, both honest about what they are:
 *
 *   - assembled pack  — the product lists `asset_sources` (documents already in
 *     this repo). The builder bundles them verbatim, with a cover, outcomes,
 *     contents and a licence page. This is how the repo's own engineering work
 *     becomes a product without inventing anything.
 *   - workbook        — the product lists modules and worksheets. The builder
 *     renders the module outlines, the "do this next" tasks and the review
 *     checklist. Written material, no recorded video, and the catalogue says so.
 *
 * Output: `drops_assets/<asset_file>`, served only through a verified
 * entitlement (`GET /api/drops/access/:token/file`), never by express.static.
 *
 * Usage:
 *   node scripts/build_drop_assets.mjs            # build every published pack
 *   node scripts/build_drop_assets.mjs --all      # include drafts
 *   node scripts/build_drop_assets.mjs --check    # verify, build nothing
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateProduct, ASSET_DIR } from '../utils/digitalDrops.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, 'data', 'drops_catalog.json');
const outDir = path.join(root, ASSET_DIR);

const args = process.argv.slice(2);
const includeDrafts = args.includes('--all');
const checkOnly = args.includes('--check');

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
}

/** Small, deliberately incomplete Markdown renderer: enough for this repo's docs. */
export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let inList = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push('<p>' + inline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    }
  };
  const closeList = () => {
    if (inList) { out.push('</' + inList + '>'); inList = null; }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line)) {
      flushParagraph(); closeList();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(esc(raw)); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph(); closeList();
      const level = Math.min(4, heading[1].length);
      out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
      out.push('<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>');
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph();
      if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
      out.push('<li>' + inline(line.replace(/^\s*\d+[.)]\s+/, '')) + '</li>');
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(); closeList();
      out.push('<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>');
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

const CSS = `
:root{--ink:#0d1320;--paper:#ffffff;--muted:#5b6b85;--line:#e3e8f0;--accent:#b45309;--code:#f5f7fb}
*{box-sizing:border-box}
body{margin:0;background:#f1f4f9;color:var(--ink);font:16px/1.65 Georgia,'Times New Roman',serif}
.sheet{max-width:820px;margin:0 auto;background:var(--paper);padding:56px 60px 72px;box-shadow:0 10px 40px rgba(13,19,32,.08)}
.brand{font:600 12px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--accent)}
h1{font-size:2.1rem;line-height:1.2;margin:.4rem 0 .6rem}
h2{font-size:1.35rem;margin:2.2rem 0 .6rem;border-top:1px solid var(--line);padding-top:1.4rem}
h3{font-size:1.08rem;margin:1.6rem 0 .4rem}
h4{font-size:.98rem;margin:1.2rem 0 .3rem}
p,li{color:#22304a}
.meta{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
.lead{font-size:1.05rem;color:#2b3a55}
.rule{height:3px;background:var(--accent);width:64px;margin:1.2rem 0 1.6rem}
ul,ol{padding-left:1.3rem}
li{margin:.3rem 0}
code{background:var(--code);padding:.1rem .3rem;border-radius:4px;font-size:.9em}
pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow:auto;border:1px solid var(--line)}
pre code{background:none;padding:0;font-size:.82rem;line-height:1.5}
blockquote{margin:1rem 0;padding:.6rem 1rem;border-left:3px solid var(--accent);color:var(--muted);background:#faf7f2}
.box{border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:1.2rem 0;background:#fbfcfe}
.box h4{margin-top:0}
.licence{font:13px/1.6 ui-sans-serif,system-ui,sans-serif;color:var(--muted);border-top:1px solid var(--line);margin-top:3rem;padding-top:1.2rem}
.toc a{color:var(--ink);text-decoration:none;border-bottom:1px dotted var(--line)}
@media print{body{background:#fff}.sheet{box-shadow:none;padding:0}h2{break-after:avoid}pre{white-space:pre-wrap}}
@media (max-width:640px){.sheet{padding:28px 20px 40px}h1{font-size:1.6rem}}
`;

function moduleBlock(mod, index) {
  const title = esc(mod.title || 'Module ' + (index + 1));
  const detail = renderMarkdown(mod.detail || '');
  const worksheet = Array.isArray(mod.worksheet) ? mod.worksheet : [];
  const tasks = worksheet.length
    ? '<div class="box"><h4>Do this next</h4><ol>' + worksheet.map((w) => '<li>' + inline(w) + '</li>').join('') + '</ol></div>'
    : '';
  return '<h2>' + (index + 1) + '. ' + title + '</h2>' + detail + tasks;
}

function outcomeBlock(product) {
  const outcomes = Array.isArray(product.outcomes) ? product.outcomes : [];
  if (!outcomes.length) return '';
  return '<h2>What you can do when you finish</h2><ul>' +
    outcomes.map((o) => '<li>' + inline(o) + '</li>').join('') + '</ul>';
}

function contentsBlock(product) {
  const modules = Array.isArray(product.modules) ? product.modules : [];
  if (!modules.length) return '';
  return '<h2>Contents</h2><ol class="toc">' +
    modules.map((m) => '<li>' + inline(m.title || '') + '</li>').join('') + '</ol>';
}

/** A product-level week of work. Optional: only packs that can be acted on get one. */
function practiceBlock(product) {
  const tasks = Array.isArray(product.practice) ? product.practice : [];
  if (!tasks.length) return '';
  return '<h2>Put it to work this week</h2><div class="box"><ol>' +
    tasks.map((t) => '<li>' + inline(t) + '</li>').join('') + '</ol></div>';
}


function sourcesBlock(product) {
  const sources = Array.isArray(product.asset_sources) ? product.asset_sources : [];
  if (!sources.length) return { html: '', found: [], missing: [] };
  const found = [];
  const missing = [];
  const parts = [];
  for (const rel of sources) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) { missing.push(rel); continue; }
    found.push(rel);
    const body = fs.readFileSync(abs, 'utf8');
    const isCode = /\.(js|mjs|cjs|ts|sql|json|ya?ml|css|html)$/i.test(rel);
    parts.push(
      '<h2>' + esc(path.basename(rel)) + '</h2>' +
      '<p class="meta">' + esc(rel) + '</p>' +
      (isCode ? '<pre><code>' + esc(body) + '</code></pre>' : renderMarkdown(body))
    );
  }
  return {
    html: parts.length
      ? '<h1 style="page-break-before:always">Source documents</h1><p class="lead">Bundled verbatim from the system this pack describes, so you can read the implementation rather than a summary of it.</p>' + parts.join('\n')
      : '',
    found,
    missing,
  };
}

export function renderPack(raw) {
  const product = raw;
  const modules = Array.isArray(product.modules) ? product.modules : [];
  const sources = sourcesBlock(product);
  const isAssembled = sources.found.length > 0;
  const shape = isAssembled ? 'Assembled pack' : 'Workbook';
  const kind = String(product.kind || 'kit');
  const date = new Date().toISOString().slice(0, 10);

  const body = [
    '<div class="sheet">',
    '<div class="brand">Alphadome · Digital Drop</div>',
    '<h1>' + esc(product.title) + '</h1>',
    '<p class="meta">' + esc(shape) + ' · ' + esc(kind) + ' · edition ' + date + '</p>',
    '<div class="rule"></div>',
    product.summary ? '<p class="lead">' + inline(product.summary) + '</p>' : '',
    outcomeBlock(product),
    contentsBlock(product),
    modules.map((m, i) => moduleBlock(m, i)).join('\n'),
    practiceBlock(product),
    sources.html,
    '<h2>Review checklist</h2>',
    '<ul>' + (product.outcomes || []).map((o) => '<li>I can show evidence that: ' + inline(o) + '</li>').join('') + '</ul>',
    '<div class="licence">',
    '<strong>Licence.</strong> One buyer, one organisation, internal use. You may adapt the material for your own business and quote short excerpts with attribution. Do not resell, redistribute or publish this pack, in whole or in part, as your own product.<br><br>',
    '<strong>What this is.</strong> ' + esc(product.delivery_note || 'Written material delivered as a single HTML pack.') + '<br><br>',
    '<strong>What it is not.</strong> Not a guarantee of income, employment, acceptance or performance. Figures quoted in this pack are the measurements of the system it describes, with their sources named, not promises about your results.<br><br>',
    'Sold via Alphadome Digital Drops. Support, resends and extensions: reply to the WhatsApp message that delivered this pack.',
    '</div>',
    '</div>',
  ].filter(Boolean).join('\n');

  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<title>' + esc(product.title) + ' · Alphadome</title>' +
    '<style>' + CSS + '</style></head><body>' + body + '</body></html>\n';
}

function main() {
  const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const products = Array.isArray(raw) ? raw : raw.products || [];
  const wanted = products.filter((p) => includeDrafts || p.status === 'published');
  if (!fs.existsSync(outDir) && !checkOnly) fs.mkdirSync(outDir, { recursive: true });

  let built = 0, failed = 0, missing = 0;
  for (const rawProduct of wanted) {
    const checked = validateProduct(rawProduct);
    if (!checked.ok) {
      failed++;
      console.log('FAIL  ' + (rawProduct.slug || rawProduct.title) + ' — ' + checked.errors.join('; '));
      continue;
    }
    const product = checked.value;
    const file = String(rawProduct.asset_file || product.slug + '.html');
    const target = path.join(outDir, path.basename(file));

    if (checkOnly) {
      const exists = fs.existsSync(target);
      if (!exists) missing++;
      console.log((exists ? 'OK    ' : 'MISS  ') + product.slug + ' -> ' + path.basename(file));
      continue;
    }

    const html = renderPack(rawProduct);
    fs.writeFileSync(target, html, 'utf8');
    built++;
    const sources = Array.isArray(rawProduct.asset_sources) ? rawProduct.asset_sources : [];
    const absent = sources.filter((s) => !fs.existsSync(path.resolve(root, s)));
    console.log('BUILD ' + product.slug + ' -> ' + path.basename(file) + ' (' + Math.round(html.length / 1024) + ' KB' +
      (absent.length ? ', missing sources: ' + absent.join(', ') : '') + ')');
  }

  if (checkOnly) {
    console.log('\n' + (missing ? missing + ' pack(s) missing. Run npm run drops:build.' : 'Every published product has a built pack.'));
    process.exit(missing ? 1 : 0);
  }
  console.log('\n' + built + ' pack(s) built in ' + ASSET_DIR + '/' + (failed ? ', ' + failed + ' invalid catalogue row(s)' : ''));
  process.exit(failed ? 1 : 0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();


