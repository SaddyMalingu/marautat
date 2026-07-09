const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const VERIFY_IN = path.join(ROOT, 'ABOSS_MIXED_VERIFY_FIRST.csv');
const SEND_IN = path.join(ROOT, 'ABOSS_MIXED_SEND_NOW.csv');
const VERIFY_OUT = path.join(ROOT, 'ABOSS_MIXED_VERIFY_FIRST_ENRICHED.csv');
const SEND_OUT = path.join(ROOT, 'ABOSS_MIXED_SEND_NOW_REFRESHED.csv');
const BLOCKERS_OUT = path.join(ROOT, 'ABOSS_MIXED_RESEARCH_BLOCKERS.csv');

const overrides = {
  'PesaPal': {
    email: 'info@pesapal.com',
    email_confidence: 'medium',
    phone: '+254709219000',
    phone_confidence: 'high',
    channel_primary: 'email',
    target_role: 'Partnerships Lead',
    source_url: 'https://www.pesapal.com/about-us',
    evidence: 'Public contacts listed on Pesapal site footer/about page',
    next_action: 'Send email first-touch now'
  },
  'Safaricom': {
    email: 'business@safaricom.co.ke',
    email_confidence: 'high',
    phone: '+254722002222',
    phone_confidence: 'high',
    channel_primary: 'email',
    target_role: 'Business Development Manager',
    source_url: 'https://www.business.safaricom.co.ke/',
    evidence: 'Safaricom Business site lists business and support contacts',
    next_action: 'Send email first-touch now; CC business.support@safaricom.co.ke'
  },
  'Quickmart': {
    email: 'qsoko@quickmart.co.ke',
    email_confidence: 'high',
    phone: '+254789646464',
    phone_confidence: 'high',
    channel_primary: 'email',
    target_role: 'Head of Operations',
    source_url: 'https://www.quickmart.co.ke/contact-us',
    evidence: 'Quickmart contact page lists Q-Soko email and phone',
    next_action: 'Send email first-touch now'
  },
  'Jumia Kenya': {
    email: '',
    email_confidence: 'none',
    phone: '+254711011011',
    phone_confidence: 'high',
    channel_primary: 'phone/whatsapp',
    target_role: 'Head of Operations',
    source_url: 'https://www.jumia.co.ke/sp-contact/',
    evidence: 'Jumia Kenya support contact page lists official phone lines and corporate link',
    next_action: 'Call/WhatsApp opener and submit corporate bulk purchase form'
  }
};

function clean(v) {
  return String(v || '').trim();
}

function readCsvRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const sheet = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
}

function writeCsv(filePath, rows) {
  const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows));
  fs.writeFileSync(filePath, csv, 'utf8');
}

const verifyRows = readCsvRows(VERIFY_IN);
const sendRows = readCsvRows(SEND_IN);

if (!verifyRows.length) {
  console.error('Missing input rows in ABOSS_MIXED_VERIFY_FIRST.csv');
  process.exit(1);
}

const enriched = verifyRows.map((row) => {
  const org = clean(row.organization);
  const ov = overrides[org];
  if (!ov) {
    return {
      ...row,
      source_url: '',
      evidence: 'No additional verified channel found in this pass',
      send_ready: 'no'
    };
  }

  const updated = {
    ...row,
    target_role: ov.target_role || row.target_role,
    email: ov.email,
    email_confidence: ov.email_confidence,
    phone: ov.phone,
    phone_confidence: ov.phone_confidence,
    channel_primary: ov.channel_primary,
    source_url: ov.source_url,
    evidence: ov.evidence,
    next_action: ov.next_action
  };

  const ready = ov.email_confidence === 'high' || ov.email_confidence === 'medium' || ov.phone_confidence === 'high';
  updated.send_ready = ready ? 'yes' : 'no';
  return updated;
});

const toSend = enriched.filter((r) => clean(r.send_ready).toLowerCase() === 'yes');
const blockers = enriched.filter((r) => clean(r.send_ready).toLowerCase() !== 'yes');

const sendMap = new Map();
for (const r of sendRows) {
  sendMap.set(clean(r.organization).toLowerCase(), r);
}
for (const r of toSend) {
  const orgKey = clean(r.organization).toLowerCase();
  sendMap.set(orgKey, {
    organization: r.organization,
    segment: r.segment,
    industry: r.industry,
    target_role: r.target_role,
    email: r.email,
    email_confidence: r.email_confidence,
    phone: r.phone,
    phone_confidence: r.phone_confidence,
    channel_primary: r.channel_primary,
    execution_score: r.execution_score,
    approach_subject: r.approach_subject,
    approach_opening: r.approach_opening,
    research_query_1: r.research_query_1,
    research_query_2: r.research_query_2,
    next_action: r.next_action,
    status: 'new',
    send_ready: 'yes',
    source_url: r.source_url,
    evidence: r.evidence
  });
}

const refreshedSend = [...sendMap.values()].sort((a, b) => Number(b.execution_score || 0) - Number(a.execution_score || 0));

writeCsv(VERIFY_OUT, enriched);
writeCsv(SEND_OUT, refreshedSend);
writeCsv(BLOCKERS_OUT, blockers);

console.log(`Enriched verify rows: ${enriched.length}`);
console.log(`Moved to send-now: ${toSend.length}`);
console.log(`Remaining blockers: ${blockers.length}`);
console.log(`Refreshed send-now total: ${refreshedSend.length}`);
console.log(`Wrote: ${path.basename(VERIFY_OUT)}`);
console.log(`Wrote: ${path.basename(SEND_OUT)}`);
console.log(`Wrote: ${path.basename(BLOCKERS_OUT)}`);
