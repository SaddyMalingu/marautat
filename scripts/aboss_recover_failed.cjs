const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const FAILED_PATH = path.join(ROOT, 'ABOSS_FAILED_CONTACTS.csv');
const READY_PATH = path.join(ROOT, 'ABOSS_READY_TO_CONTACT.csv');
const RESEARCH_PATH = path.join(ROOT, 'ABOSS_RESEARCH_QUEUE.csv');

const ACTIONS_OUT = path.join(ROOT, 'ABOSS_FAILED_ACTIONS.csv');
const TOP10_OUT = path.join(ROOT, 'ABOSS_TOP10_NEXT.csv');

function readCsvRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const sheet = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
}

function clean(v) {
  return String(v || '').trim();
}

function toCsv(rows) {
  return XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows));
}

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(clean(v));
}

function isLikelyValidPhone(v) {
  const d = clean(v).replace(/\D/g, '');
  if (!d) return false;
  if (d === '2147483647') return false;
  return d.length >= 10 && d.length <= 13;
}

function replacementChannel(row) {
  const r = clean(row.failure_reason).toLowerCase();
  if (r.includes('address_not_found')) return 'linkedin_or_contact_form';
  if (r.includes('misconfigured')) return 'linkedin_or_contact_form';
  if (r.includes('number')) return 'email_or_linkedin';
  return clean(row.next_attempt_channel) || 'linkedin_or_contact_form';
}

function fallbackQueries(org, role) {
  return [
    `site:linkedin.com/in ${org} ${role} Kenya`,
    `${org} Kenya ${role} email`,
    `"${org}" contact Kenya`,
    `${org} leadership team Kenya`
  ];
}

const failed = readCsvRows(FAILED_PATH);
const ready = readCsvRows(READY_PATH);
const research = readCsvRows(RESEARCH_PATH);

if (!failed.length) {
  console.error('No failed rows found. Fill ABOSS_FAILED_CONTACTS.csv first.');
  process.exit(1);
}

const failedSet = new Set(failed.map((f) => clean(f.organization).toLowerCase()));

const actions = failed.map((f) => {
  const org = clean(f.organization);
  const match = ready.find((r) => clean(r.organization).toLowerCase() === org.toLowerCase()) || {};
  const role = clean(match.target_role) || 'Operations Manager';
  const [q1, q2, q3, q4] = fallbackQueries(org, role);

  return {
    organization: org,
    failed_channel: clean(f.failed_channel),
    failed_recipient: clean(f.failed_recipient),
    failure_reason: clean(f.failure_reason),
    next_attempt_channel: replacementChannel(f),
    target_role: role,
    action_1: 'Find named decision-maker on LinkedIn using query_1',
    action_2: 'Find direct email or contact form from official website',
    action_3: 'Send personalized first-touch referencing role and org context',
    query_1: q1,
    query_2: q2,
    query_3: q3,
    query_4: q4,
    status: 'ready_for_research'
  };
});

const survivors = ready.filter((r) => {
  const org = clean(r.organization).toLowerCase();
  if (failedSet.has(org)) return false;
  const emailOk = isValidEmail(r.email);
  const phoneOk = isLikelyValidPhone(r.phone);
  return emailOk || phoneOk;
});

const topSurvivors = survivors
  .sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0))
  .map((r) => ({
    organization: clean(r.organization),
    channel: clean(r.ready_channel),
    recipient: isValidEmail(r.email) ? clean(r.email) : clean(r.phone),
    contact_name: clean(r.contact_name) || '{{name}}',
    subject: clean(r.approach_subject),
    message_template: `Hi {{name}}, we help teams like ${clean(r.organization)} improve lead-to-revenue conversion with practical automation. If useful, I can share a 2-step same-day setup tailored to ${clean(r.organization)}. Reply YES and I will send it.`,
    priority_score: clean(r.priority_score),
    source: 'ready_to_contact'
  }));

const needed = Math.max(0, 10 - topSurvivors.length);
const topResearchFill = research
  .filter((r) => !failedSet.has(clean(r.organization).toLowerCase()))
  .slice(0, needed)
  .map((r) => ({
    organization: clean(r.organization),
    channel: 'research_first',
    recipient: '',
    contact_name: clean(r.contact_name) || '{{name}}',
    subject: clean(r.approach_subject),
    message_template: clean(r.approach_opening),
    priority_score: clean(r.priority_score),
    source: 'research_queue',
    research_query_1: clean(r.research_query_1),
    research_query_2: clean(r.research_query_2)
  }));

const nextTop10 = [...topSurvivors, ...topResearchFill].slice(0, 10).map((r, i) => ({ ...r, rank: i + 1 }));

fs.writeFileSync(ACTIONS_OUT, toCsv(actions), 'utf8');
fs.writeFileSync(TOP10_OUT, toCsv(nextTop10), 'utf8');

console.log(`Wrote: ${path.basename(ACTIONS_OUT)} (${actions.length} rows)`);
console.log(`Wrote: ${path.basename(TOP10_OUT)} (${nextTop10.length} rows)`);
