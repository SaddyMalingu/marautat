/**
 * Turn a pasted price list into catalogue rows (2026-11-19)
 *
 * Why this exists: eleven of twelve active tenants have an empty catalogue, and that
 * is the whole reason none of them has anything to pay for. The campaign asks each
 * tenant to "send me your price list", so the real bottleneck is the ten minutes
 * between the list arriving and the bot having something to sell. Doing that by hand
 * is where every "yes" quietly dies.
 *
 * The parser is deliberately forgiving, because the input is a WhatsApp message:
 *
 *   Omo 1kg | OMO-1KG | 320 | 12
 *   Omo 1kg, 320
 *   Omo 1kg - KES 320
 *   Omo 1kg    320   12          (tab-separated, straight from a spreadsheet)
 *   Omo 1kg — Ksh 320 (12)
 *
 * What it will not do: invent a price, accept a zero, or create a duplicate SKU. A
 * row that cannot be read is reported with its line number, not silently dropped —
 * a catalogue missing three items is worse than one that says three items are wrong.
 *
 * Pure string/number handling. The caller does the IO; see scripts/catalog_import.mjs.
 */

const CURRENCY_PREFIX = String.raw`(?:KES|KSh|Kshs|Ksh|/=)?`;
const NUMBER = String.raw`\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const PRICE_TAIL = new RegExp(
  String.raw`^(.*?)\s*(?:[|;:,\-–—]|\s)\s*` + CURRENCY_PREFIX + String.raw`\s*(${NUMBER})\s*` +
  String.raw`(?:x\s*(\d{1,6})|\(\s*(\d{1,6})\s*\))?\s*$`,
  'i'
);
const SKU_LIKE = /^[A-Za-z0-9][A-Za-z0-9._/-]{1,24}$/;

/**
 * Is this cell *only* a price?
 *
 * `parseAmount('OMO-1KG')` returns 1, because it strips non-digits — which read the
 * SKU column as a price of KES 1 on the first real test. A price cell is an optional
 * currency prefix and digits, nothing else.
 */
const isPriceCell = (cell) => /^\s*(?:KES|KSh|Kshs|Ksh|\/=)?\s*\d[\d,.\s]*\s*$/i.test(String(cell || ''));


/** 1,250.00 → 1250 ; "12 500" → 12500 ; "" → NaN */
export function parseAmount(raw) {
  const cleaned = String(raw == null ? '' : raw).replace(/[^\d.]/g, '');
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/** A stable, readable SKU from a tenant name and an index: "Spreadmasters ltd", 3 → SPRE-0003 */
export function tenantPrefix(name = '') {
  const letters = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (letters.slice(0, 4) || 'ITEM').padEnd(4, 'X');
}

export function suggestSku(name, { prefix = 'ITEM', index = 1 } = {}) {
  return prefix + '-' + String(index).padStart(4, '0');
}

const looksLikeHeader = (line) => {
  const l = String(line).toLowerCase();
  const hits = ['name', 'item', 'product', 'price', 'amount', 'sku', 'stock', 'qty', 'quantity']
    .filter((word) => new RegExp(String.raw`\b${word}\b`).test(l));
  // A header names at least two of the columns; a product line rarely names any.
  return hits.length >= 2 && !/\d/.test(l);
};


/**
 * One line → one candidate row. Never throws: an unreadable line comes back with a
 * reason, because the caller has to show the tenant which line to fix.
 */
export function parseLine(line, { lineNumber = 0, prefix = 'ITEM', index = 1 } = {}) {
  const text = String(line == null ? '' : line).trim();
  if (!text) return null;
  if (text.startsWith('#') || text.startsWith('//')) return null;
  if (looksLikeHeader(text)) return null;

  // Spreadsheet paste first: the tab is unambiguous, and a pipe is what a person
  // types to mean "these are columns".
  let cells = [];
  if (text.includes('\t')) cells = text.split('\t');
  else if (text.includes('|')) cells = text.split('|');
  cells = cells.map((c) => c.trim()).filter((c, i, all) => !(c === '' && i === all.length - 1));

  let name = '';
  let sku = '';
  let price = NaN;
  let stock = NaN;

  if (cells.length >= 2) {
    // The column order a price list actually uses: name, [sku], price, [stock].
    name = cells[0];
    let i = 1;
    if (cells[i] && SKU_LIKE.test(cells[i]) && !isPriceCell(cells[i])) {
      sku = cells[i];
      i += 1;
    }
    // If the cell in the price position is not a price, the row is not what it looks
    // like — better to say so than to import a product at KES 1.
    if (!isPriceCell(cells[i])) {
      return {
        line: lineNumber,
        raw: text,
        name: String(name || '').trim(),
        sku: (sku || suggestSku(name, { prefix, index })).toUpperCase(),
        price: NaN,
        stock: 0,
        problems: ['no price — the column after the name is "' + String(cells[i] || '').slice(0, 24) + '"']
      };
    }
    price = parseAmount(cells[i]);
    if (cells[i + 1] !== undefined) {
      const s = String(cells[i + 1]).replace(/[^\d]/g, '');
      stock = s ? Number(s) : NaN;
    }
  } else {
    const match = text.match(PRICE_TAIL);
    if (match) {
      name = String(match[1] || '').trim();
      price = parseAmount(match[2]);
      const trailing = match[3] || match[4];
      stock = trailing === undefined ? NaN : Number(trailing);
      // A code in front, e.g. "OMO-1KG Omo 1kg 320" — the first token is the SKU.
      const first = name.split(/\s+/)[0] || '';
      if (first.length > 2 && SKU_LIKE.test(first) && /[A-Z]/.test(first) && /\d/.test(first)) {
        sku = first;
        name = name.slice(first.length).trim();
      }
      // "Omo 5kg 1,450 6" — two numbers at the end with nothing marking which is the
      // price and which is the stock. Guessing here is how a catalogue ends up with a
      // KES 6 jar of Omo, so the row is refused and the fix is named.
      if (/\s\d[\d,.]*\s*$/.test(name)) {
        return {
          line: lineNumber,
          raw: text,
          name,
          sku: sku ? sku.toUpperCase() : suggestSku(name, { prefix, index }).toUpperCase(),
          price: NaN,
          stock: 0,
          problems: ['two numbers at the end — separate the columns with | or a tab']
        };
      }
    }
  }

  const problems = [];
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name) problems.push('no product name');
  if (!Number.isFinite(price)) problems.push('no price');
  else if (price <= 0) problems.push('price must be greater than zero');
  if (Number.isFinite(stock) && stock < 0) problems.push('stock cannot be negative');

  return {
    line: lineNumber,
    raw: text,
    name,
    sku: (sku || suggestSku(name, { prefix, index })).toUpperCase(),
    price: Number.isFinite(price) ? Math.round(price * 100) / 100 : NaN,
    stock: Number.isFinite(stock) ? Math.trunc(stock) : 0,
    problems
  };
}


/**
 * A whole list → { rows, skipped, total }.
 *
 * `skipped` keeps the line and the reason, because "12 lines pasted, 9 readable" is
 * the sentence the tenant needs to see, and it has to name the three.
 */
export function parsePriceList(text, { prefix = 'ITEM' } = {}) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const rows = [];
  const skipped = [];
  const seen = new Set();
  let index = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const parsed = parseLine(lines[i], { lineNumber, prefix, index: index + 1 });
    if (!parsed) continue;
    index += 1;
    if (parsed.problems.length) {
      skipped.push({ line: lineNumber, raw: parsed.raw, reason: parsed.problems.join('; ') });
      continue;
    }
    if (seen.has(parsed.sku)) {
      skipped.push({ line: lineNumber, raw: parsed.raw, reason: 'duplicate SKU ' + parsed.sku });
      continue;
    }
    // The same thing pasted twice usually gets a different generated SKU, so SKU
    // dedupe alone let "Sunlight 500ml - KES 210" through twice on the first test.
    const fingerprint = parsed.name.toLowerCase() + '@' + parsed.price;
    if (seen.has(fingerprint)) {
      skipped.push({ line: lineNumber, raw: parsed.raw, reason: 'duplicate of an earlier line (' + parsed.name + ' at ' + parsed.price + ')' });
      continue;
    }
    seen.add(parsed.sku);
    seen.add(fingerprint);
    rows.push(parsed);
  }

  return { rows, skipped, total: rows.length + skipped.length };
}

/** The row `POST /tenant/catalog` would write, built here so both agree. */
export function toProduct(row, { tenantId, currency = 'KES' } = {}) {
  return {
    bot_tenant_id: tenantId,
    sku: String(row.sku || '').toUpperCase(),
    name: String(row.name || '').trim(),
    description: null,
    price: Number(row.price),
    currency,
    stock_count: Number.isFinite(Number(row.stock)) ? Math.trunc(Number(row.stock)) : 0,
    image_url: null,
    metadata: { imported_at: new Date().toISOString(), import_source: 'price_list' },
    is_active: true
  };
}

/** Everything the caller needs to print one honest summary line. */
export function summarise(plan) {
  const rows = (plan && plan.rows) || [];
  const skipped = (plan && plan.skipped) || [];
  const value = rows.reduce((sum, r) => sum + (Number(r.price) || 0) * (Number.isFinite(Number(r.stock)) ? Number(r.stock) : 0), 0);
  return {
    readable: rows.length,
    skipped: skipped.length,
    total: rows.length + skipped.length,
    stock_value: Math.round(value * 100) / 100,
    cheapest: rows.length ? Math.min(...rows.map((r) => Number(r.price) || 0)) : 0,
    dearest: rows.length ? Math.max(...rows.map((r) => Number(r.price) || 0)) : 0
  };
}
