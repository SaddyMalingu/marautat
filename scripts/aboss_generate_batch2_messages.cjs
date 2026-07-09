const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const IN_FILE = path.join(ROOT, 'ABOSS_BATCH2_TOMORROW.csv');
const OUT_CSV = path.join(ROOT, 'ABOSS_BATCH2_MESSAGES_READY.csv');
const OUT_MD = path.join(ROOT, 'ABOSS_BATCH2_MESSAGES_READY.md');

function readCsv(filePath) {
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

function angleByIndustry(industry) {
  const i = clean(industry).toLowerCase();
  if (i.includes('retail')) {
    return {
      pain: 'slow response on high-intent buyer inquiries',
      value: 'recover abandoned checkouts and speed buyer response-to-sale',
      metric: 'response-to-checkout conversion'
    };
  }
  if (i.includes('hospitality')) {
    return {
      pain: 'lost bookings due to delayed follow-up',
      value: 'recover undecided guests and improve booking conversion',
      metric: 'inquiry-to-booking conversion'
    };
  }
  if (i.includes('fintech')) {
    return {
      pain: 'drop-off in proposal and onboarding stages',
      value: 'improve follow-up and payment completion',
      metric: 'lead-to-activation conversion'
    };
  }
  if (i.includes('healthtech')) {
    return {
      pain: 'patient and partner lead follow-up delays',
      value: 'route high-intent leads and tighten follow-up handoffs',
      metric: 'qualified-lead response speed'
    };
  }
  if (i.includes('mobility')) {
    return {
      pain: 'commercial inquiry drop-off in sales cycles',
      value: 'prioritize commercial leads and automate follow-up cadence',
      metric: 'inquiry-to-contract conversion'
    };
  }
  return {
    pain: 'lead follow-up inconsistencies',
    value: 'improve lead-to-revenue conversion with practical automation',
    metric: 'qualified lead conversion'
  };
}

function makeSubject(org, industry) {
  const i = clean(industry).toLowerCase();
  if (i.includes('retail')) return `Quick idea to improve ${org} response-to-sale speed`;
  if (i.includes('hospitality')) return `Faster inquiry handling for ${org}`;
  if (i.includes('fintech')) return `Practical way to improve conversion follow-up at ${org}`;
  return `2-step same-day revenue workflow for ${org}`;
}

function firstTouch(org, industry) {
  const angle = angleByIndustry(industry);
  return `Hi {{name}},\n\nI noticed teams in your space often face ${angle.pain}.\nWe help teams like ${org} ${angle.value} using a lightweight automation layer.\n\nIf useful, I can share a 2-step same-day pilot outline tailored to ${org}.\n\nReply YES and I will send it.`;
}

function followUp24h(org, industry) {
  const angle = angleByIndustry(industry);
  return `Hi {{name}},\n\nQuick follow-up in case this got buried.\nFor ${org}, we can run a short pilot focused on ${angle.metric} this week.\n\nIf you are open, I will send a one-page scope with timeline and KPI target.`;
}

function callOpener(org, industry) {
  const angle = angleByIndustry(industry);
  return `Hi {{name}}, quick one. We help teams like ${org} ${angle.value}. If I share one same-day workflow we can test this week, would that be useful?`;
}

if (!fs.existsSync(IN_FILE)) {
  console.error('Input missing: ABOSS_BATCH2_TOMORROW.csv');
  process.exit(1);
}

const rows = readCsv(IN_FILE);
if (!rows.length) {
  console.error('No rows found in ABOSS_BATCH2_TOMORROW.csv');
  process.exit(1);
}

const outRows = rows.map((r, idx) => {
  const org = clean(r.organization);
  const industry = clean(r.industry);
  const email = clean(r.email);
  const phone = clean(r.phone);
  const linkedin = clean(r.linkedin_url);
  const instagram = clean(r.instagram_url);
  const channel = clean(r.channel_primary) || (email ? 'email' : 'phone/whatsapp');

  return {
    rank: idx + 1,
    organization: org,
    segment: clean(r.segment),
    industry,
    target_role: clean(r.target_role),
    primary_channel: channel,
    recipient_email: email,
    recipient_phone: phone,
    subject: makeSubject(org, industry),
    first_touch_message: firstTouch(org, industry),
    followup_24h_message: followUp24h(org, industry),
    phone_opener: callOpener(org, industry),
    linkedin_url: linkedin,
    instagram_url: instagram,
    status: 'ready_to_send'
  };
});

writeCsv(OUT_CSV, outRows);

let md = '# ABOSS Batch2 Ready-to-Send Messages\n\n';
outRows.forEach((r) => {
  md += `## ${r.rank}. ${r.organization}\n`;
  md += `- Channel: ${r.primary_channel}\n`;
  md += `- Email: ${r.recipient_email || 'n/a'}\n`;
  md += `- Phone: ${r.recipient_phone || 'n/a'}\n`;
  md += `- Subject: ${r.subject}\n`;
  md += `- LinkedIn: ${r.linkedin_url || 'n/a'}\n`;
  md += `- Instagram: ${r.instagram_url || 'n/a'}\n\n`;
  md += 'First Touch\n';
  md += '```text\n' + r.first_touch_message + '\n```\n\n';
  md += 'Follow-up (24h)\n';
  md += '```text\n' + r.followup_24h_message + '\n```\n\n';
  md += 'Phone/WhatsApp Opener\n';
  md += '```text\n' + r.phone_opener + '\n```\n\n';
});

fs.writeFileSync(OUT_MD, md, 'utf8');

console.log(`Generated messages for ${outRows.length} targets`);
console.log(`Wrote: ${path.basename(OUT_CSV)}`);
console.log(`Wrote: ${path.basename(OUT_MD)}`);
