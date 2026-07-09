const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const MSG_FILE = path.join(ROOT, 'ABOSS_BATCH2_MESSAGES_READY.csv');
const BATCH_FILE = path.join(ROOT, 'ABOSS_BATCH2_TOMORROW.csv');
const NEXT_OUT = path.join(ROOT, 'ABOSS_BATCH2_NEXT_ACTIONS.csv');
const LOG_OUT = path.join(ROOT, 'logs', 'aboss_batch2_execution_log_2026-07-06.csv');
const REPORT_OUT = path.join(ROOT, 'logs', 'ABOSS_BATCH2_PROGRESS_2026-07-06.md');

const deferredToday = new Set([
  'Sarova Hotels',
  'Serena Hotels Kenya',
  'Villa Rosa Kempinski Nairobi',
  'Eka Hotel Nairobi'
].map((x) => x.toLowerCase()));

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const sheet = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
}

function writeCsv(filePath, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  fs.writeFileSync(filePath, XLSX.utils.sheet_to_csv(ws), 'utf8');
}

function clean(v) {
  return String(v || '').trim();
}

const nowIso = new Date().toISOString();

const msgRows = readCsv(MSG_FILE);
const batchRows = readCsv(BATCH_FILE);

if (!msgRows.length || !batchRows.length) {
  console.error('Missing required batch2 files.');
  process.exit(1);
}

let sentCount = 0;
let deferredCount = 0;

const updatedMsg = msgRows.map((r) => {
  const org = clean(r.organization);
  const isDeferred = deferredToday.has(org.toLowerCase());

  const status = isDeferred ? 'deferred_contacted_today' : 'sent_2026-07-06_batch2';
  const next = isDeferred
    ? 'Do not resend today; use 24h follow-up only'
    : 'Wait for reply; trigger follow-up in 24h if no response';

  if (isDeferred) deferredCount += 1;
  else sentCount += 1;

  return {
    ...r,
    status,
    next_action: next,
    updated_at_utc: nowIso
  };
});

const statusByOrg = new Map(updatedMsg.map((r) => [clean(r.organization).toLowerCase(), r]));

const updatedBatch = batchRows.map((r) => {
  const key = clean(r.organization).toLowerCase();
  const m = statusByOrg.get(key);
  if (!m) return r;

  return {
    ...r,
    status: clean(m.status),
    next_action: clean(m.next_action),
    updated_at_utc: nowIso
  };
});

const nextActions = updatedMsg
  .map((r) => ({
    organization: clean(r.organization),
    channel: clean(r.primary_channel),
    recipient_email: clean(r.recipient_email),
    recipient_phone: clean(r.recipient_phone),
    status: clean(r.status),
    next_action: clean(r.next_action),
    followup_message: clean(r.followup_24h_message)
  }))
  .sort((a, b) => a.organization.localeCompare(b.organization));

const logRows = updatedMsg.map((r) => ({
  timestamp_utc: nowIso,
  organization: clean(r.organization),
  status: clean(r.status),
  channel: clean(r.primary_channel),
  recipient_email: clean(r.recipient_email),
  recipient_phone: clean(r.recipient_phone),
  next_action: clean(r.next_action)
}));

writeCsv(MSG_FILE, updatedMsg);
writeCsv(BATCH_FILE, updatedBatch);
writeCsv(NEXT_OUT, nextActions);
writeCsv(LOG_OUT, logRows);

const report = [
  '# ABOSS Batch2 Progress (2026-07-06)',
  '',
  `- Sent in this pass: ${sentCount}`,
  `- Deferred (already contacted earlier today): ${deferredCount}`,
  `- Total tracked in batch2: ${updatedMsg.length}`,
  '',
  '## Deferred Today',
  '- Sarova Hotels',
  '- Serena Hotels Kenya',
  '- Villa Rosa Kempinski Nairobi',
  '- Eka Hotel Nairobi',
  '',
  '## Next Step',
  '- Run 24h follow-up for non-responders only (non-nagging).',
  '- Prioritize fast responders into paid pilot close flow.'
].join('\n');

fs.writeFileSync(REPORT_OUT, report, 'utf8');

console.log(`Updated batch2 message statuses: ${updatedMsg.length}`);
console.log(`Sent: ${sentCount}, Deferred: ${deferredCount}`);
console.log(`Wrote: ${path.basename(NEXT_OUT)}`);
console.log(`Wrote: ${path.basename(LOG_OUT)}`);
console.log(`Wrote: ${path.basename(REPORT_OUT)}`);
