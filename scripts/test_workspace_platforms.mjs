#!/usr/bin/env node

/**
 * Reading your own work queues, verified against the real markup (2026-11-05)
 *
 * Every fixture below was copied from a page you saved, not invented:
 *
 *   - `closed.htm` — Superior Essays, `table.main_search_table`, six headers
 *     ("Order Code, Topic, Subject, Pages, Cost, Writer Deadline"), row
 *     `895234 | American Revolution | History | 2 | KES600.00 | 2025-01-13 17:19:30`.
 *   - `OneForma.html` — certifications, eight `<th>` and **nine** `<td>` per row (the first cell is
 *     an unlabelled selection column), statuses like "Not Started", time limits rendered as
 *     "3 / 3".
 *
 * Values inside the rows are synthetic; the *structure* is exactly what the pages produce. That is
 * the point: the two things that break a scraper are a shifted column and a renamed header, so both
 * are tested here rather than discovered in production.
 *
 * Usage: npm run test:workspace
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import {
  alignCells,
  describeTableRead,
  headerKey,
  intValue,
  mapRowsToRecords,
  moneyValue,
  readTableExpr
} from '../utils/browserActor/tasks/tables.js';
import {
  SUPERIOR_ESSAYS,
  closedOrdersExpr,
  orderIdFromHref,
  parseClosedOrders
} from '../utils/browserActor/tasks/superiorEssays.js';
import {
  ONE_FORMA,
  certificationState,
  certificationsExpr,
  parseCertifications,
  parseProjects
} from '../utils/browserActor/tasks/oneForma.js';

let pass = 0;
let fail = 0;
function ok(label, condition) {
  if (condition) { pass += 1; console.log(`PASS  ${label}`); } else { fail += 1; console.log(`FAIL  ${label}`); }
}
function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) { pass += 1; console.log(`PASS  ${label}`); } else {
    fail += 1;
    console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// The one table reader
// ---------------------------------------------------------------------------
eq('a header is comparable to the column it names', headerKey('Required score'), headerKey('required_score'));
eq('and to the same words in another case', headerKey('Order  Code'), 'ordercode');

{
  // The exact shape from closed.htm: nine cells is wrong, six is right.
  const headers = ['Order Code', 'Topic', 'Subject', 'Pages', 'Cost', 'Writer Deadline'];
  eq('a row matching its headers is left alone', alignCells(headers, ['a', 'b', 'c', 'd', 'e', 'f']).length, 6);
  // The exact shape from OneForma.html: nine cells under eight headers.
  const oneforma = ['Certification name', 'Category', 'Questions', 'Time limit', 'Required score', 'Last score', 'Status', 'Actions'];
  const aligned = alignCells(oneforma, ['', 'Translation_Certification_Guidance _UK_TO_FR', 'Language Testing', '20', '3 / 3', '80%', '-', 'Not Started', 'Take test']);
  eq('an extra leading selection cell is dropped', aligned[0], 'Translation_Certification_Guidance _UK_TO_FR');
  eq('so the status lands under Status', aligned[6], 'Not Started');
  ok('a short row keeps what it has', alignCells(headers, ['a', 'b']).length === 2);
  ok('and no headers means no re-alignment', alignCells([], ['a', 'b']).length === 2);
}

{
  const headers = ['Order Code', 'Topic', 'Subject'];
  const records = mapRowsToRecords({
    headers,
    rows: [{ cells: ['895234', 'American Revolution', 'History'], links: ['', 'https://x/1', ''] }],
    fields: { orderCode: ['Order Code'], topic: ['Topic'], missing: ['Deadline'] }
  });
  eq('a field maps to the column with that heading', records[0].orderCode, '895234');
  eq('the link travels with the record', records[0].link, 'https://x/1');
  eq('a field with no column is empty, not undefined', records[0].missing, '');
  eq('and the reader can say which fields it could not find',
    describeTableRead({ headers, fields: { orderCode: ['Order Code'], deadline: ['Writer Deadline'] } }).missing,
    ['deadline']);
}

eq('"KES600.00" is 600', moneyValue('KES600.00'), 600);
eq('"KES 1,200.50" is 1200.5', moneyValue('KES 1,200.50'), 1200.5);
eq('"$45" is 45', moneyValue('$45'), 45);
eq('a cost that is not a number stays null', moneyValue('pending'), null);
eq('and so does an empty cell', moneyValue(''), null);
eq('pages "2" is 2', intValue('2'), 2);
eq('"2 pages" is still 2', intValue('2 pages'), 2);
eq('"-" has no number', intValue('-'), null);

// ---------------------------------------------------------------------------
// Superior Essays: the writer's own order book
// ---------------------------------------------------------------------------
{
  // Headers and cell order copied from closed.htm; the values are synthetic.
  const snapshot = {
    ok: true,
    url: SUPERIOR_ESSAYS.urls.closed,
    title: 'Closed Orders',
    headers: ['Order Code', 'Topic', 'Subject', 'Pages', 'Cost', 'Writer Deadline'],
    rows: [{
      cells: ['970001', 'Industrial Revolution', 'History', '2', 'KES600.00', '2025-01-13 17:19:30'],
      links: ['', 'https://orders.superioressays.org/writer/orders/order/970001', '', '', '', '']
    }, {
      cells: ['970002', 'Macroeconomics essay', 'Economics', '4', 'KES 1,450.50', '2025-02-01 09:00:00'],
      links: ['', 'https://orders.superioressays.org/writer/orders/order/970002', '', '', '', '']
    }]
  };
  const parsed = parseClosedOrders(snapshot);
  eq('the table is read', parsed.ok, true);
  eq('one row becomes one order', parsed.orders.length, 2);
  eq('the order code is the id', parsed.orders[0].orderCode, '970001');
  eq('the id is also taken from the row link', parsed.orders[0].orderId, '970001');
  eq('the topic is the link text', parsed.orders[0].topic, 'Industrial Revolution');
  eq('pages is a number', parsed.orders[0].pages, 2);
  eq('the cost keeps its text as well as its number',
    [parsed.orders[0].costText, parsed.orders[0].costAmount], ['KES600.00', 600]);
  eq('a cost with a space and a decimal is still a number', parsed.orders[1].costAmount, 1450.5);
  eq('the deadline is kept verbatim', parsed.orders[0].deadline, '2025-01-13 17:19:30');
  eq('every field the page promised was found', parsed.table.missing, []);
  eq('and the order page can be opened by id',
    parsed.orders[0].orderUrl, 'https://orders.superioressays.org/writer/orders/order/970001');
}

{
  // A redesign that drops a column must say so, not quietly return blanks.
  const parsed = parseClosedOrders({
    ok: true,
    headers: ['Order Code', 'Topic', 'Pages'],
    rows: [{ cells: ['970003', 'Poetry analysis', '3'], links: [] }]
  });
  eq('a missing cost column is reported', parsed.table.missing, ['subject', 'cost', 'deadline']);
  eq('a row without a link still gets an order URL from its code',
    parsed.orders[0].orderUrl, 'https://orders.superioressays.org/writer/orders/order/970003');
  eq('and an absent cost is null, not zero', parsed.orders[0].costAmount, null);
}

eq('a page with no table is a stated reason, not an empty list',
  parseClosedOrders({ ok: false, reason: 'no_table' }).reason, 'no_table');
eq('the writer marketplace can only be read', SUPERIOR_ESSAYS.capabilities, ['read']);
eq('the order id is read from the path',
  orderIdFromHref('https://orders.superioressays.org/writer/orders/order/895234'), '895234');
eq('and a non-order link yields nothing',
  orderIdFromHref('https://orders.superioressays.org/writer/orders/closed'), null);
ok('the closed-orders expression targets the blade table',
  /main_search_table/.test(closedOrdersExpr()) && /main_table_bdy/.test(closedOrdersExpr()));
ok('and never clicks', !/\.click\(|submit\(|dispatchEvent/.test(closedOrdersExpr()));

// ---------------------------------------------------------------------------
// OneForma: certifications and projects
// ---------------------------------------------------------------------------
{
  // Eight headers, nine cells: the first cell is the unlabelled selection column.
  const snapshot = {
    ok: true,
    url: ONE_FORMA.urls.dashboard,
    headers: ['Certification name', 'Category', 'Questions', 'Time limit', 'Required score', 'Last score', 'Status', 'Actions'],
    rows: [{
      // One unambiguous token per column, so a shifted mapping cannot pass by coincidence.
      cells: ['', 'Translation_Certification_Guidance _UK_TO_FR', 'Language Testing', '20', '30 min', '80%', '-', 'Not Started', 'Take test'],
      links: []
    }, {
      cells: ['', 'Search_Quality_Rater', 'Search', '40', '45 min', '75%', '82%', 'Passed', 'Retake'],
      links: []
    }]
  };
  const parsed = parseCertifications(snapshot);
  eq('the certifications table is read', parsed.ok, true);
  eq('one row becomes one certification', parsed.certifications.length, 2);
  eq('the name is not the selection cell',
    parsed.certifications[0].name, 'Translation_Certification_Guidance _UK_TO_FR');
  eq('the category is the next column', parsed.certifications[0].category, 'Language Testing');
  eq('the question count is a number', parsed.certifications[0].questions, 20);
  eq('the time limit lands under Time limit', parsed.certifications[0].timeLimit, '30 min');
  eq('and the required score under Required score', parsed.certifications[0].requiredScore, '80%');
  eq('a not-started certification is still to do', parsed.certifications[0].state, 'todo');
  eq('a passed one is passed', parsed.certifications[1].state, 'passed');
  eq('and only the unfinished ones are counted as work', parsed.todo, 1);
  eq('every field the page promised was found', parsed.table.missing, []);
}

eq('"In Progress" is not finished', certificationState('In Progress'), 'in_progress');
eq('"Not Started" is work to do', certificationState('Not Started'), 'todo');
eq('"Failed" is not passed', certificationState('Failed'), 'not_passed');
eq('an empty status is unknown, not failed', certificationState(''), 'unknown');

{
  const parsed = parseProjects({
    ok: true,
    headers: ['Project', 'Category', 'Rate', 'Status'],
    rows: [
      { cells: ['Audio transcription batch 12', 'Transcription', '$8/hour', 'Open'], links: ['https://my.oneforma.com/project/1', '', '', ''] },
      { cells: ['', '', '', ''], links: [] }
    ]
  });
  eq('a project row is read', parsed.projects.length, 1);
  eq('with its rate kept as text, not coerced', parsed.projects[0].rate, '$8/hour');
  eq('and its link kept', parsed.projects[0].link, 'https://my.oneforma.com/project/1');
}

{
  const parsed = parseCertifications({
    ok: true,
    headers: ['Certification name', 'Status'],
    rows: [{ cells: ['A', 'Not Started'] }]
  });
  eq('a page that lost six columns says so',
    parsed.table.missing, ['category', 'questions', 'timeLimit', 'requiredScore', 'lastScore']);
}
eq('OneForma can only be read', ONE_FORMA.capabilities, ['read']);
ok('no descriptor in this module can click or type',
  !/\.click\(|dispatchEvent|submit\(|\.value\s*=/.test(certificationsExpr() + closedOrdersExpr()));
ok('the section names come from the page\'s own ids',
  ONE_FORMA.urls.section.certifications === 'certifications' && ONE_FORMA.urls.section.jobs === 'jobs');

// ---------------------------------------------------------------------------
// The reader expression itself, executed against a fake table
// ---------------------------------------------------------------------------
{
  const cell = (text, href) => ({
    innerText: text,
    textContent: text,
    querySelector: (selector) => (href && selector === 'a[href]' ? { href } : null)
  });
  const row = (cells) => ({ querySelectorAll: () => cells });
  const table = {
    querySelectorAll: (selector) => (selector === 'thead th'
      ? [cell('Order Code'), cell('Topic')]
      : [row([cell('970001'), cell('Industrial Revolution', 'https://orders.superioressays.org/writer/orders/order/970001')])])
  };
  const document = {
    title: 'Closed Orders',
    body: { innerText: 'Closed orders table' },
    querySelectorAll: (selector) => (selector === 'table.main_search_table' ? [table] : [])
  };
  const expression = closedOrdersExpr();
  const parsed = JSON.parse(new Function('document', 'location', `return ${expression};`)(document, {
    href: SUPERIOR_ESSAYS.urls.closed
  }));
  eq('the expression reads the header row', parsed.headers, ['Order Code', 'Topic']);
  eq('and the row beneath it', parsed.rows[0].cells, ['970001', 'Industrial Revolution']);
  eq('carrying the link that holds the id',
    parsed.rows[0].links[1], 'https://orders.superioressays.org/writer/orders/order/970001');
  eq('one row counted', parsed.count, 1);

  // The saved copy of the anonymous page is exactly this: a login shell with no table.
  const empty = JSON.parse(new Function('document', 'location', `return ${expression};`)({
    title: 'Sign in',
    body: { innerText: 'Email Or Username Password Submit' },
    querySelectorAll: () => []
  }, { href: SUPERIOR_ESSAYS.urls.closed }));
  eq('a page with no table says so', empty.ok, false);
  eq('with a reason, not an empty success', empty.reason, 'no_table');
  ok('and the page text, so the cause is visible', empty.bodyStart.includes('Password'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);



