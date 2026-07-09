const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const READY_IN = path.join(ROOT, 'ABOSS_READY_TO_CONTACT.csv');
const OUT = path.join(ROOT, 'ABOSS_SEND_QUEUE.csv');

function readRows(filePath) {
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const sheet = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
}

function clean(v) {
  return String(v || '').trim();
}

function buildMessage(org) {
  return `Hi {{name}}, we help teams like ${org} improve lead-to-revenue conversion with practical automation. If useful, I can share a 2-step same-day setup tailored to ${org}. Reply YES and I will send it.`;
}

if (!fs.existsSync(READY_IN)) {
  console.error(`Missing input file: ${READY_IN}`);
  process.exit(1);
}

const rows = readRows(READY_IN);
const queue = [];

for (const row of rows) {
  const org = clean(row.organization);
  const email = clean(row.email);
  const phone = clean(row.phone);
  const channel = email ? 'email' : (phone ? 'phone/whatsapp' : '');
  const recipient = email || phone;

  if (!channel || !recipient) continue;

  queue.push({
    organization: org,
    channel,
    recipient,
    contact_name: clean(row.contact_name) || '{{name}}',
    subject: clean(row.approach_subject),
    message_template: buildMessage(org),
    status: 'queued',
    next_action: 'Fill contact_name if missing, send first touch'
  });
}

const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(queue));
fs.writeFileSync(OUT, csv, 'utf8');

console.log(`Built send queue: ${path.basename(OUT)}`);
console.log(`Queued rows: ${queue.length}`);
