const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const SEND_FILE = path.join(ROOT, 'ABOSS_MIXED_SEND_NOW_REFRESHED.csv');
const READY_FILE = path.join(ROOT, 'ABOSS_READY_TO_CONTACT.csv');
const DEEP_FILE = path.join(ROOT, 'ABOSS_DEEP_RESEARCH_MIXED.csv');

const FOLLOWUP_OUT = path.join(ROOT, 'ABOSS_FOLLOWUP_24H_BATCH1.csv');
const BATCH2_OUT = path.join(ROOT, 'ABOSS_BATCH2_TOMORROW.csv');
const STRIKE_PLAN_OUT = path.join(ROOT, 'logs', 'ABOSS_REVENUE_STRIKE_3H_2026-07-06.md');

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

function hasReachable(row) {
  return clean(row.email) || clean(row.phone);
}

function normalizeKenyaPhone(phone) {
  const digits = clean(phone).replace(/\D/g, '');
  if (!digits) return '';
  if (digits === '2147483647') return '';
  if (digits.startsWith('254') && digits.length === 12) return `+${digits}`;
  if ((digits.startsWith('07') || digits.startsWith('01')) && digits.length === 10) return `+254${digits.slice(1)}`;
  return '';
}

function isBouncedEmail(email) {
  const e = clean(email).toLowerCase();
  if (!e) return false;
  const bounced = new Set([
    'channelsales@hotpoint.co.ke',
    'contact@mafcarrefour.com'
  ]);
  return bounced.has(e);
}

function industryFollowupAngle(industry) {
  const i = clean(industry).toLowerCase();
  if (i.includes('retail')) return 'reduce abandoned checkout and speed buyer response';
  if (i.includes('hospitality')) return 'recover undecided inquiries and lift booking conversion';
  if (i.includes('fintech') || i.includes('financial')) return 'improve conversion follow-up and payment completion';
  if (i.includes('saas')) return 'improve trial-to-paid conversion and lead response speed';
  return 'improve lead-to-revenue conversion without extra hiring';
}

function followupMessage(org, industry) {
  const angle = industryFollowupAngle(industry);
  return `Hi {{name}}, following up in case this got buried. For ${org}, we can quickly help ${angle}. If helpful, I can share a same-day 2-step pilot outline with clear KPIs.`;
}

function followupSubject(org) {
  return `Quick follow-up for ${org} (2-step pilot option)`;
}

function roleHint(industry) {
  const i = clean(industry).toLowerCase();
  if (i.includes('retail')) return 'Head of Operations';
  if (i.includes('hospitality')) return 'General Manager';
  if (i.includes('fintech') || i.includes('financial')) return 'Partnerships Lead';
  if (i.includes('saas')) return 'Head of Growth';
  if (i.includes('logistics')) return 'Commercial Manager';
  return 'Business Development Lead';
}

const sentRows = readCsv(SEND_FILE);
const readyRows = readCsv(READY_FILE);
const deepRows = readCsv(DEEP_FILE);

if (!sentRows.length) {
  console.error('Missing or empty ABOSS_MIXED_SEND_NOW_REFRESHED.csv');
  process.exit(1);
}

const contactedOrgs = new Set(sentRows.map((r) => clean(r.organization).toLowerCase()));

const followupRows = sentRows
  .filter((r) => clean(r.status).startsWith('sent_'))
  .map((r) => ({
    organization: clean(r.organization),
    segment: clean(r.segment),
    industry: clean(r.industry),
    channel: clean(r.channel_primary) || (clean(r.email) ? 'email' : 'phone/whatsapp'),
    recipient_email: clean(r.email),
    recipient_phone: clean(r.phone),
    followup_subject: followupSubject(clean(r.organization)),
    followup_message: followupMessage(clean(r.organization), clean(r.industry)),
    send_at_utc: '',
    status: 'queued_24h_followup',
    note: 'Send only if no reply at +24h'
  }));

const batch2FromReady = readyRows
  .filter((r) => {
    const org = clean(r.organization).toLowerCase();
    const email = clean(r.email);
    const phone = normalizeKenyaPhone(r.phone);
    const reachable = (email && !isBouncedEmail(email)) || !!phone;
    return org && !contactedOrgs.has(org) && reachable;
  })
  .map((r) => ({
    email: isBouncedEmail(r.email) ? '' : clean(r.email),
    phone: normalizeKenyaPhone(r.phone),
    organization: clean(r.organization),
    segment: 'mixed',
    industry: clean(r.industry),
    target_role: clean(r.target_role) || roleHint(r.industry),
    channel_primary: clean(r.ready_channel) || (!isBouncedEmail(r.email) && clean(r.email) ? 'email' : 'phone/whatsapp'),
    priority_score: Number(r.priority_score || 0),
    reason_selected: 'ready_contact_from_curated_list',
    approach_subject: clean(r.approach_subject),
    approach_opening: clean(r.approach_opening),
    next_action: 'Send first-touch tomorrow after follow-up batch',
    status: 'queued_batch2'
  }));

const needed = Math.max(0, 10 - batch2FromReady.length);
const batch2Fallback = deepRows
  .filter((r) => {
    const org = clean(r.organization).toLowerCase();
    const email = clean(r.email);
    const phone = normalizeKenyaPhone(r.phone);
    const reachable = (email && !isBouncedEmail(email)) || !!phone;
    return org && !contactedOrgs.has(org) && reachable;
  })
  .map((r) => ({
    email: isBouncedEmail(r.email) ? '' : clean(r.email),
    phone: normalizeKenyaPhone(r.phone),
    organization: clean(r.organization),
    segment: clean(r.segment) || 'mixed',
    industry: clean(r.industry),
    target_role: clean(r.target_role) || roleHint(r.industry),
    channel_primary: clean(r.channel_primary) || (!isBouncedEmail(r.email) && clean(r.email) ? 'email' : 'phone/whatsapp'),
    priority_score: Number(r.execution_score || 0),
    reason_selected: 'deep_research_reachable_fallback',
    approach_subject: clean(r.approach_subject),
    approach_opening: clean(r.approach_opening),
    next_action: 'Send first-touch tomorrow after follow-up batch',
    status: 'queued_batch2'
  }))
  .sort((a, b) => b.priority_score - a.priority_score)
  .slice(0, needed);

const dedup = new Map();
for (const row of [...batch2FromReady, ...batch2Fallback]) {
  const key = clean(row.organization).toLowerCase();
  if (!key || dedup.has(key)) continue;
  dedup.set(key, row);
}

const batch2Rows = [...dedup.values()].sort((a, b) => b.priority_score - a.priority_score).slice(0, 10);

writeCsv(FOLLOWUP_OUT, followupRows);
writeCsv(BATCH2_OUT, batch2Rows);

const strikePlan = [
  '# A Boss 3-Hour Revenue Strike Plan',
  '',
  '## Objective',
  '- Convert immediate outreach momentum into at least one paid pilot commitment within 3 hours.',
  '',
  '## Available Levers',
  '- Existing outreach system and verified contact queues',
  '- Fast SME decision lanes from current sent batch',
  '- Follow-up and recovery scripts already prepared',
  '',
  '## Minute-by-Minute Plan',
  '### 0-30 Minutes',
  '- Complete Jumia call and corporate route submission now.',
  '- Check inbox and respond to any positive signals within 15 minutes max.',
  '- For warm replies, push a paid same-day pilot offer with fixed scope.',
  '',
  '### 30-90 Minutes',
  '- Run direct call/WhatsApp attempts for high-intent contacts where phone is available.',
  '- Offer a compact paid pilot: setup + 7-day execution + KPI dashboard.',
  '- Ask directly for pilot go-ahead and preferred payment method.',
  '',
  '### 90-180 Minutes',
  '- Send proposal-lite to responders: objective, timeline, fee, start today.',
  '- Trigger fallback payment/recovery lane in parallel for immediate cash capture.',
  '- Lock one commitment, then onboard instantly using existing playbooks.',
  '',
  '## Offer Structure (Fast-Close)',
  '- Offer A: 7-day Revenue Recovery Pilot (KES 15,000-30,000 depending on size)',
  '- Offer B: Lead Conversion Sprint (KES 10,000 setup + performance bonus)',
  '- Guarantee: clear KPI target and same-day implementation start.',
  '',
  '## Non-Nagging Rules',
  '- Max two touches in 24h unless engaged.',
  '- Every touch must add value: KPI idea, playbook snippet, or pilot metric.',
  '- Pause non-responsive leads after second attempt and recycle in 3-5 days.',
  '',
  '## Output Files For Tomorrow',
  '- ABOSS_FOLLOWUP_24H_BATCH1.csv',
  '- ABOSS_BATCH2_TOMORROW.csv'
].join('\n');

fs.writeFileSync(STRIKE_PLAN_OUT, strikePlan, 'utf8');

console.log(`Follow-up rows prepared: ${followupRows.length}`);
console.log(`Tomorrow batch rows prepared: ${batch2Rows.length}`);
console.log(`Wrote: ${path.basename(FOLLOWUP_OUT)}`);
console.log(`Wrote: ${path.basename(BATCH2_OUT)}`);
console.log(`Wrote: ${path.basename(STRIKE_PLAN_OUT)}`);
