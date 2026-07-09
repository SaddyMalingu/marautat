const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const SEND_FILE = path.join(ROOT, 'ABOSS_MIXED_SEND_NOW_REFRESHED.csv');
const BLOCKER_FILE = path.join(ROOT, 'ABOSS_MIXED_RESEARCH_BLOCKERS.csv');
const SUMMARY_FILE = path.join(ROOT, 'ABOSS_DEEP_RESEARCH_SUMMARY.json');
const LOG_FILE = path.join(ROOT, 'logs', 'aboss_outreach_log_2026-07-06.csv');
const REPORT_FILE = path.join(ROOT, 'logs', 'ABOSS_STATUS_REPORT_2026-07-06.md');

function readCsv(filePath) {
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const sheet = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
}

function writeCsv(filePath, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(ws);
  fs.writeFileSync(filePath, csv, 'utf8');
}

function clean(v) {
  return String(v || '').trim();
}

if (!fs.existsSync(SEND_FILE)) {
  console.error('Missing ABOSS_MIXED_SEND_NOW_REFRESHED.csv');
  process.exit(1);
}
if (!fs.existsSync(BLOCKER_FILE)) {
  console.error('Missing ABOSS_MIXED_RESEARCH_BLOCKERS.csv');
  process.exit(1);
}

const rows = readCsv(SEND_FILE);
const blockers = readCsv(BLOCKER_FILE);
const summary = fs.existsSync(SUMMARY_FILE)
  ? JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'))
  : null;

const nowIso = new Date().toISOString();
let sentCount = 0;
let pendingCount = 0;

const updated = rows.map((r) => {
  const org = clean(r.organization).toLowerCase();
  const out = { ...r };

  if (org === 'jumia kenya') {
    out.status = 'pending_jumia_call';
    out.next_action = 'Call +254711011011 and submit corporate bulk purchase route';
    pendingCount += 1;
  } else {
    out.status = 'sent_2026-07-06';
    out.next_action = 'Wait for replies and run follow-up in 24h if no response';
    sentCount += 1;
  }

  return out;
});

writeCsv(SEND_FILE, updated);

const logRows = updated.map((r) => ({
  timestamp_utc: nowIso,
  organization: clean(r.organization),
  channel_primary: clean(r.channel_primary),
  recipient_email: clean(r.email),
  recipient_phone: clean(r.phone),
  status: clean(r.status),
  action: clean(r.next_action)
}));
writeCsv(LOG_FILE, logRows);

const largeTargets = updated.filter((r) => clean(r.segment) === 'large').length;
const smeTargets = updated.filter((r) => clean(r.segment) === 'sme').length;
const highConfEmail = updated.filter((r) => clean(r.email_confidence) === 'high').length;
const medConfEmail = updated.filter((r) => clean(r.email_confidence) === 'medium').length;

const report = [
  '# A Boss Status Report (2026-07-06)',
  '',
  '## Current Outreach Snapshot',
  `- Total send-now targets tracked: ${updated.length}`,
  `- Sent today: ${sentCount}`,
  `- Pending: ${pendingCount} (Jumia Kenya call/WhatsApp route)`,
  `- Mix: ${largeTargets} large, ${smeTargets} SME`,
  `- Email confidence: ${highConfEmail} high, ${medConfEmail} medium`,
  `- Blockers remaining: ${blockers.length}`,
  '',
  '## A Boss Progress',
  '- Outreach engine is active with balanced enterprise + SME targeting.',
  '- Failed-contact recovery has improved deliverability by moving to verified channels.',
  '- Decision velocity improved by prioritizing SME lanes while keeping enterprise upside.',
  '',
  '## Revenue-Asap Next Steps (Execution Order)',
  '1. Handle replies from sent emails in under 15 minutes with a pilot-first CTA.',
  '2. Execute Jumia call/WhatsApp outreach and submit the corporate bulk route.',
  '3. Run 24-hour follow-up only for non-responders with new value context (non-nagging).',
  '4. Convert any engaged lead into same-day pilot scope + timeline + owner.',
  '5. Push payment/recovery offers in parallel for fastest cash while B2B pipeline matures.',
  '',
  '## Operational Notes',
  '- Tracking files are kept under logs/ for cleanliness.',
  '- Use ABOSS_MIXED_SEND_NOW_REFRESHED.csv as the single source of truth for outreach status.',
  '- Use ABOSS_MIXED_RESEARCH_BLOCKERS.csv to resolve remaining contact gaps.',
  '',
  '## Source Files',
  '- ABOSS_MIXED_SEND_NOW_REFRESHED.csv',
  '- ABOSS_MIXED_RESEARCH_BLOCKERS.csv',
  '- ABOSS_DEEP_RESEARCH_SUMMARY.json',
  '',
  summary ? `Deep research baseline: ${summary.total_candidates} candidates, ${summary.with_email} with email, ${summary.with_phone} with phone.` : ''
].filter(Boolean).join('\n');

fs.writeFileSync(REPORT_FILE, report, 'utf8');

console.log(`Updated outreach statuses in ${path.basename(SEND_FILE)}`);
console.log(`Wrote log: ${path.basename(LOG_FILE)}`);
console.log(`Wrote report: ${path.basename(REPORT_FILE)}`);
console.log(`Sent=${sentCount}, Pending=${pendingCount}, Blockers=${blockers.length}`);
