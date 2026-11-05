/**
 * Reading a page that is already a table (2026-11-05)
 *
 * Two very different platforms turned out to agree on one thing: the lists people want are rendered
 * as real `<table>` markup.
 *
 *   - `orders.superioressays.org/writer/orders/closed` — a Laravel blade table,
 *     `table.main_search_table` / `tbody.main_table_bdy`, columns "Order Code, Topic, Subject, Pages,
 *     Cost, Writer Deadline", each row linking to `/writer/orders/order/<id>`.
 *   - `my.oneforma.com` certifications — a React Aria table with hashed CSS-module classes, but a
 *     genuine `<thead><th>` header row ("Certification name, Category, Questions, Time limit,
 *     Required score, Last score, Status, Actions") and `[data-slot="table-cell"]` cells.
 *
 * Neither needs a bespoke extractor. What they need is a reader that **uses the header row as the
 * schema** — the one thing a redesign is least likely to rename, and the thing a hashed class name
 * can never be. Everything here is read-only: the expression reads text and `href`s, and nothing in
 * this module can produce a click.
 */

/** How many rows one read returns. A page that holds more is paged by the caller, not swallowed. */
export const MAX_ROWS_PER_READ = 200;

/**
 * The expression the browser runs.
 *
 * @param {{tableSelector?: string, rowSelector?: string, cellSelector?: string, limit?: number}} spec
 */
export function readTableExpr({
  tableSelector = 'table',
  rowSelector = 'tbody tr',
  cellSelector = 'td',
  limit = MAX_ROWS_PER_READ
} = {}) {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const tables = Array.from(document.querySelectorAll(${JSON.stringify(tableSelector)}));
  if (!tables.length) {
    return JSON.stringify({
      ok: false,
      reason: 'no_table',
      url: String(location.href),
      title: clean(document.title),
      bodyStart: clean(document.body ? document.body.innerText : '').slice(0, 200)
    });
  }
  const table = tables[0];
  // The header row is the schema. Read the words, not the classes: OneForma's cell ids are React
  // Aria counter values ("react-aria1666044416-_r_19_-certName") and change on every mount.
  const headers = Array.from(table.querySelectorAll('thead th')).map((th) => clean(th.innerText || th.textContent));
  const rows = Array.from(table.querySelectorAll(${JSON.stringify(rowSelector)})).slice(0, ${Number(limit) || MAX_ROWS_PER_READ})
    .map((tr) => {
      const cells = Array.from(tr.querySelectorAll(${JSON.stringify(cellSelector)}));
      return {
        cells: cells.map((cell) => clean(cell.innerText || cell.textContent)),
        // The order id is only in the link, never in the text, so it travels beside the cells.
        links: cells.map((cell) => {
          const anchor = cell.querySelector('a[href]');
          return anchor ? String(anchor.href) : '';
        })
      };
    });
  return JSON.stringify({
    ok: true,
    url: String(location.href),
    title: clean(document.title),
    strategy: 'table',
    headers: headers,
    rows: rows,
    count: rows.length,
    bodyStart: clean(document.body ? document.body.innerText : '').slice(0, 200)
  });
})()`;
}

/** Header text to a comparable key: "Required score" and "required_score" are the same column. */
export function headerKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Line the cells up with the headers.
 *
 * OneForma renders **nine** cells under **eight** headers: the first cell is a selection column with
 * no heading. Mapping by raw index would put "Language Testing" under "Certification name" and be
 * wrong for every field on the page — the kind of bug that reads as plausible data. So: when there
 * are more cells than headers, the extra *leading* cells are dropped. Fewer cells keeps the
 * alignment it has, because a short row usually means an empty trailing column.
 */
export function alignCells(headers = [], cells = []) {
  const width = Array.isArray(headers) ? headers.length : 0;
  const row = Array.isArray(cells) ? cells : [];
  if (!width || row.length <= width) return row;
  return row.slice(row.length - width);
}

/**
 * Turn `{headers, rows}` into records keyed by the names we actually use.
 *
 * @param {{headers?: string[], rows?: object[], fields?: Record<string, string[]>}} input
 * @returns {object[]} one record per row, with `row` (index) and `link` (first href found)
 */
export function mapRowsToRecords({ headers = [], rows = [], fields = {} } = {}) {
  const at = new Map();
  headers.forEach((header, index) => {
    const key = headerKey(header);
    if (key && !at.has(key)) at.set(key, index);
  });

  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const cells = alignCells(headers, row?.cells || []);
    const record = { row: index };
    for (const [name, aliases] of Object.entries(fields)) {
      let value = '';
      for (const alias of Array.isArray(aliases) ? aliases : [aliases]) {
        const column = at.get(headerKey(alias));
        if (column == null) continue;
        const candidate = cells[column];
        if (candidate != null && String(candidate).trim() !== '') { value = String(candidate).trim(); break; }
      }
      record[name] = value;
    }
    const link = (Array.isArray(row?.links) ? row.links : []).find((href) => href);
    if (link) record.link = String(link);
    return record;
  });
}

/** Which headers the reader found, and which of our fields they did **not** cover. */
export function describeTableRead({ headers = [], fields = {} } = {}) {
  const present = new Set(headers.map(headerKey));
  const missing = Object.entries(fields)
    .filter(([, aliases]) => !(Array.isArray(aliases) ? aliases : [aliases]).some((alias) => present.has(headerKey(alias))))
    .map(([name]) => name);
  return { columns: headers.length, missing };
}

/**
 * "KES600.00", "KES 1,200", "$1,250.50" → a number, or null.
 *
 * Kept separate from the string on purpose: a cost that cannot be parsed must stay visible as text,
 * and a zero must never be invented for it.
 */
export function moneyValue(text) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ');
  const match = raw.match(/(?:KES|KSH|USD|\$|€|£)?\s?([\d,]+(?:\.\d+)?)/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** A whole number from text like "2" or "2 pages"; null when the cell says something else. */
export function intValue(text) {
  const match = String(text == null ? '' : text).match(/-?\d+/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}
