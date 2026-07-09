const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const READY_PATH = path.join(ROOT, 'ABOSS_READY_TO_CONTACT.csv');
const QUEUE_PATH = path.join(ROOT, 'ABOSS_SEND_QUEUE.csv');
const OUT_PATH = path.join(ROOT, 'ABOSS_TOP10_TODAY.csv');

function readCsvRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const sheet = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
}

function clean(v) {
  return String(v || '').trim();
}

function scoreChannel(channel) {
  const c = clean(channel).toLowerCase();
  if (c === 'email') return 3;
  if (c.includes('whatsapp') || c.includes('phone')) return 2;
  return 1;
}

function buildReason(row) {
  const reasons = [];
  const p = Number(row.priority_score || 0);
  if (p >= 80) reasons.push('high-priority');
  if (clean(row.channel).toLowerCase() === 'email') reasons.push('direct-email-ready');
  if (clean(row.contact_name) && clean(row.contact_name).toLowerCase() !== '{{name}}') reasons.push('has-contact-name');
  if (!reasons.length) reasons.push('ready-to-send');
  return reasons.join('|');
}

const readyRows = readCsvRows(READY_PATH);
const queueRows = readCsvRows(QUEUE_PATH);

if (!queueRows.length) {
  console.error('ABOSS_SEND_QUEUE.csv is missing or empty. Run: npm run aboss:send-queue');
  process.exit(1);
}

const priorityByOrg = new Map();
for (const r of readyRows) {
  const org = clean(r.organization).toLowerCase();
  if (!org) continue;
  priorityByOrg.set(org, Number(r.priority_score || 0));
}

const ranked = queueRows
  .map((r) => {
    const org = clean(r.organization);
    const priority = priorityByOrg.get(org.toLowerCase()) || 0;
    const chScore = scoreChannel(r.channel);
    const composite = priority * 10 + chScore;
    return {
      organization: org,
      contact_name: clean(r.contact_name),
      channel: clean(r.channel),
      recipient: clean(r.recipient),
      subject: clean(r.subject),
      message_template: clean(r.message_template),
      priority_score: priority,
      execution_score: composite,
      reason_selected: buildReason({ ...r, priority_score: priority }),
      action_now: 'Send first touch and set follow-up reminder for +24h'
    };
  })
  .sort((a, b) => b.execution_score - a.execution_score)
  .slice(0, 10)
  .map((r, i) => ({ ...r, rank: i + 1 }));

if (!ranked.length) {
  console.error('No ranked rows generated.');
  process.exit(1);
}

const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(ranked));
fs.writeFileSync(OUT_PATH, csv, 'utf8');

console.log(`Generated ${path.basename(OUT_PATH)} with ${ranked.length} rows`);
