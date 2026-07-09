const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const IN = path.join(ROOT, 'ABOSS_DEEP_RESEARCH_TOP12_BALANCED.csv');
const SEND_NOW = path.join(ROOT, 'ABOSS_MIXED_SEND_NOW.csv');
const VERIFY_FIRST = path.join(ROOT, 'ABOSS_MIXED_VERIFY_FIRST.csv');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const KENYA_PHONE_RE = /^\+254\d{9}$/;

function readRows(filePath) {
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
}

function clean(v) {
  return String(v || '').trim();
}

function emailConfidence(email) {
  const e = clean(email).toLowerCase();
  if (!e) return 'none';
  if (!EMAIL_RE.test(e)) return 'low';
  if (e.startsWith('info@') || e.startsWith('support@') || e.startsWith('contact@') || e.startsWith('website@')) return 'medium';
  return 'high';
}

function phoneConfidence(phone) {
  const p = clean(phone).replace(/\s+/g, '');
  if (!p) return 'none';
  if (KENYA_PHONE_RE.test(p)) return 'high';
  return 'low';
}

function nextStep(row, eConf, pConf) {
  if (eConf === 'high' || eConf === 'medium') return 'Send email first-touch now';
  if (pConf === 'high') return 'Send WhatsApp/phone opener now';
  return 'Verify contact details via research_query_1 and LinkedIn before sending';
}

function build(row) {
  const eConf = emailConfidence(row.email);
  const pConf = phoneConfidence(row.phone);
  const sendReady = eConf === 'high' || eConf === 'medium' || pConf === 'high';
  return {
    organization: clean(row.organization),
    segment: clean(row.segment),
    industry: clean(row.industry),
    target_role: clean(row.target_role),
    email: clean(row.email),
    email_confidence: eConf,
    phone: clean(row.phone),
    phone_confidence: pConf,
    channel_primary: clean(row.channel_primary),
    execution_score: Number(row.execution_score || 0),
    approach_subject: clean(row.approach_subject),
    approach_opening: clean(row.approach_opening),
    research_query_1: clean(row.research_query_1),
    research_query_2: clean(row.research_query_2),
    next_action: nextStep(row, eConf, pConf),
    status: 'new',
    send_ready: sendReady ? 'yes' : 'no'
  };
}

if (!fs.existsSync(IN)) {
  console.error('Input file missing: ABOSS_DEEP_RESEARCH_TOP12_BALANCED.csv');
  process.exit(1);
}

const rows = readRows(IN).map(build);
const sendNow = rows
  .filter((r) => r.send_ready === 'yes')
  .sort((a, b) => Number(b.execution_score) - Number(a.execution_score));
const verifyFirst = rows
  .filter((r) => r.send_ready === 'no')
  .sort((a, b) => Number(b.execution_score) - Number(a.execution_score));

fs.writeFileSync(SEND_NOW, XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(sendNow)), 'utf8');
fs.writeFileSync(VERIFY_FIRST, XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(verifyFirst)), 'utf8');

console.log(`Send-now rows: ${sendNow.length}`);
console.log(`Verify-first rows: ${verifyFirst.length}`);
console.log(`Wrote: ${path.basename(SEND_NOW)}`);
console.log(`Wrote: ${path.basename(VERIFY_FIRST)}`);
