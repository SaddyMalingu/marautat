/**
 * OneForma — certifications and open projects, read only (2026-11-05)
 *
 * Written from a saved copy of `my.oneforma.com/contributor/dashboard`. Three facts from that file
 * decided everything here:
 *
 *   1. It is a **React app with hashed CSS modules** (`certName`, `navItem___z9Qrv`, cell ids like
 *      `react-aria1666044416-_r_19_-certName`). The numeric prefix is a React Aria counter, so those
 *      ids change on every mount and are worse than useless as selectors.
 *   2. The certifications list is nevertheless a **real table**: `<thead>` with eight `<th>`
 *      ("Certification name, Category, Questions, Time limit, Required score, Last score, Status,
 *      Actions"), `[data-slot="table-row"]` rows, `[data-slot="table-cell"]` cells. The header row
 *      is therefore the schema, exactly as on the writer marketplace.
 *   3. Rows carry **nine** cells under **eight** headers — the first is a selection column with no
 *      heading. `alignCells` drops the leading extra; without that, every field on the page would be
 *      shifted by one and still look like data.
 *
 * Two separate lists matter to a contributor, and they are not the same kind of thing:
 *   - **certifications** — the qualifying tests. Read-only here: this module reports status, required
 *     score and last score. It does not take the test.
 *   - **jobs/projects** — the work itself, with rates and requirements.
 *
 * `capabilities: ['read']` is the whole point. Sitting a certification, or applying to a project,
 * is an attestation that a person did it; an agent that clicks through it makes the account's
 * answers untrue, which is both a terms-of-service violation and a misrepresentation to the client
 * paying for the work. Reading the queue and drafting an answer for a human to check is help. Doing
 * the work silently is not.
 */
import { describeTableRead, intValue, mapRowsToRecords, readTableExpr } from './tables.js';

export const ONE_FORMA = Object.freeze({
  slug: 'oneforma',
  name: 'OneForma',
  origin: 'https://my.oneforma.com',
  capabilities: Object.freeze(['read']),
  urls: Object.freeze({
    dashboard: 'https://my.oneforma.com/contributor/dashboard',
    /** The sections are panels inside the SPA; the ids below are how the sidebar names them. */
    section: {
      certifications: 'certifications',
      jobs: 'jobs',
      applications: 'jobs-apps',
      tasks: 'tasks',
      surveys: 'surveys',
      earnings: 'earnings',
      documents: 'documents',
      profile: 'profile'
    }
  }),
  table: Object.freeze({
    // One table on the certifications panel. Kept as a plain `table` because the class names are
    // generated; the header row does the identifying.
    tableSelector: 'table',
    rowSelector: 'tbody tr',
    cellSelector: 'td, [data-slot="table-cell"]'
  }),
  certificationFields: Object.freeze({
    name: ['Certification name', 'Certification'],
    category: ['Category'],
    questions: ['Questions'],
    timeLimit: ['Time limit', 'Time Limit'],
    requiredScore: ['Required score', 'Pass score'],
    lastScore: ['Last score', 'Score'],
    status: ['Status']
  }),
  jobFields: Object.freeze({
    project: ['Project', 'Project name', 'Job', 'Title'],
    category: ['Category', 'Type'],
    rate: ['Rate', 'Pay', 'Payment'],
    status: ['Status'],
    deadline: ['Deadline', 'Due']
  })
});

export function certificationsExpr({ limit = 100 } = {}) {
  return readTableExpr({ ...ONE_FORMA.table, limit });
}

export function jobsExpr({ limit = 100 } = {}) {
  return readTableExpr({ ...ONE_FORMA.table, limit });
}

/** Does this certification still need doing? Read from the page's own Status column. */
export function certificationState(status) {
  const text = String(status || '').toLowerCase();
  if (!text) return 'unknown';
  if (/not\s*started|pending|available|todo|to\s*do/.test(text)) return 'todo';
  if (/in\s*progress|started/.test(text)) return 'in_progress';
  if (/passed|completed|approved|certified/.test(text)) return 'passed';
  if (/failed|expired|rejected/.test(text)) return 'not_passed';
  return 'unknown';
}

export function parseCertifications(snapshot = {}) {
  if (!snapshot?.ok) {
    return { ok: false, reason: snapshot?.reason || 'unreadable', url: snapshot?.url || null, certifications: [], table: null };
  }
  const records = mapRowsToRecords({
    headers: snapshot.headers || [],
    rows: snapshot.rows || [],
    fields: ONE_FORMA.certificationFields
  });
  const certifications = records
    // A row with no name is the header repeating in a tbody, not a certification.
    .filter((record) => record.name)
    .map((record) => ({
      name: record.name,
      category: record.category || null,
      questions: intValue(record.questions),
      timeLimit: record.timeLimit || null,
      requiredScore: record.requiredScore || null,
      lastScore: record.lastScore || null,
      statusText: record.status || null,
      state: certificationState(record.status)
    }));
  return {
    ok: true,
    url: snapshot.url || null,
    certifications,
    todo: certifications.filter((row) => row.state === 'todo' || row.state === 'in_progress').length,
    table: describeTableRead({ headers: snapshot.headers || [], fields: ONE_FORMA.certificationFields })
  };
}

export function parseProjects(snapshot = {}) {
  if (!snapshot?.ok) {
    return { ok: false, reason: snapshot?.reason || 'unreadable', url: snapshot?.url || null, projects: [], table: null };
  }
  const records = mapRowsToRecords({
    headers: snapshot.headers || [],
    rows: snapshot.rows || [],
    fields: ONE_FORMA.jobFields
  });
  return {
    ok: true,
    url: snapshot.url || null,
    projects: records.filter((record) => record.project || record.link),
    table: describeTableRead({ headers: snapshot.headers || [], fields: ONE_FORMA.jobFields })
  };
}
