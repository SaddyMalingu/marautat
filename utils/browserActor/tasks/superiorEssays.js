/**
 * Superior Essays — a writer's own order book, read only (2026-11-05)
 *
 * Written from a saved copy of `orders.superioressays.org/writer/orders/closed`, not from a guess:
 * a blade table `table.main_search_table` with `tbody.main_table_bdy`, six columns — "Order Code,
 * Topic, Subject, Pages, Cost, Writer Deadline" — and a row that looks like
 *
 *   895234 | <a href="/writer/orders/order/895234">American Revolution</a> | History | 2 | KES600.00 |
 *   2025-01-13 17:19:30
 *
 * Why the URL you gave me was useless and this one was not: `/writer/orders/closed` answers an
 * anonymous fetch with the login shell (45 KB of `Email Or Username / Password`). The saved copy is
 * the same page *with a session*, which is the only version that has a table in it.
 *
 * What this descriptor is for, and what it is not:
 *   - **for**: knowing your own pipeline — what you wrote, for which subject, for how much, when it
 *     was due — so pricing and capacity decisions stop being guesswork.
 *   - **not for**: completing work or submitting it. `capabilities` says `read`, and no function here
 *     clicks, types, uploads or posts. A writer submitting coursework on someone else's behalf is a
 *     human decision with a human's name on it; automating it is not a feature this system ships.
 */
import { describeTableRead, intValue, mapRowsToRecords, moneyValue, readTableExpr } from './tables.js';

export const SUPERIOR_ESSAYS = Object.freeze({
  slug: 'superior-essays',
  name: 'Superior Essays',
  origin: 'https://orders.superioressays.org',
  /** Read-only, enforced by what exists rather than by a flag someone can flip. */
  capabilities: Object.freeze(['read']),
  urls: Object.freeze({
    closed: 'https://orders.superioressays.org/writer/orders/closed',
    completed: 'https://orders.superioressays.org/writer/orders/closed?tab=completed_orders',
    approved: 'https://orders.superioressays.org/writer/orders/closed?tab=approved_orders',
    canceled: 'https://orders.superioressays.org/writer/orders/closed?tab=canceled_orders',
    available: 'https://orders.superioressays.org/writer/orders/available',
    current: 'https://orders.superioressays.org/writer/orders/current',
    order: (id) => `https://orders.superioressays.org/writer/orders/order/${encodeURIComponent(String(id))}`
  }),
  table: Object.freeze({
    tableSelector: 'table.main_search_table',
    rowSelector: 'tbody.main_table_bdy tr',
    cellSelector: 'td'
  }),
  /** Header text → our field names. The header row is the schema; this maps it to words we use. */
  fields: Object.freeze({
    orderCode: ['Order Code'],
    topic: ['Topic'],
    subject: ['Subject'],
    pages: ['Pages'],
    cost: ['Cost', 'Amount'],
    deadline: ['Writer Deadline', 'Deadline']
  })
});

export function closedOrdersExpr({ limit = 200 } = {}) {
  return readTableExpr({ ...SUPERIOR_ESSAYS.table, limit });
}

/** The order id lives in the row's link, never in the text. */
export function orderIdFromHref(href) {
  const match = String(href || '').match(/\/writer\/orders\/order\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Turn one table read into orders.
 *
 * Nothing is invented: a cost that cannot be parsed keeps its text, a blank deadline stays blank, and
 * `describeTableRead` names any column the page no longer has — so a redesign shows up as
 * "missing: cost" instead of as a table of zeros.
 */
export function parseClosedOrders(snapshot = {}) {
  if (!snapshot?.ok) {
    return {
      ok: false,
      reason: snapshot?.reason || 'unreadable',
      url: snapshot?.url || null,
      title: snapshot?.title || null,
      orders: []
    };
  }
  const records = mapRowsToRecords({
    headers: snapshot.headers || [],
    rows: snapshot.rows || [],
    fields: SUPERIOR_ESSAYS.fields
  });
  const orders = records.map((record) => ({
    orderCode: record.orderCode || null,
    topic: record.topic || null,
    subject: record.subject || null,
    pages: intValue(record.pages),
    costText: record.cost || null,
    costAmount: moneyValue(record.cost),
    deadline: record.deadline || null,
    orderUrl: record.link || (record.orderCode ? SUPERIOR_ESSAYS.urls.order(record.orderCode) : null),
    orderId: orderIdFromHref(record.link) || record.orderCode || null
  }));
  return {
    ok: true,
    url: snapshot.url || null,
    title: snapshot.title || null,
    orders,
    table: describeTableRead({ headers: snapshot.headers || [], fields: SUPERIOR_ESSAYS.fields })
  };
}
