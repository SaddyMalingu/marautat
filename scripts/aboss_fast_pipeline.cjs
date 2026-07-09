const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, 'ABOSS_CONTACT_CAPTURE_TEMPLATE.csv');
const READY_OUT = path.join(ROOT, 'ABOSS_READY_TO_CONTACT.csv');
const RESEARCH_OUT = path.join(ROOT, 'ABOSS_RESEARCH_QUEUE.csv');
const SUMMARY_OUT = path.join(ROOT, 'ABOSS_FAST_PIPELINE_SUMMARY.json');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function parseRows(filePath) {
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const name = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
}

function clean(v) {
  return String(v || '').trim();
}

function cleanPhone(v) {
  const digits = clean(v).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length < 9 || digits.length > 15) return '';
  return digits;
}

function validEmail(v) {
  const e = clean(v);
  return EMAIL_RE.test(e);
}

function domainFromWebsite(website) {
  const raw = clean(website);
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function roleTargets(industry) {
  const i = clean(industry).toLowerCase();
  if (i.includes('retail')) return ['Head of Operations', 'Marketing Manager', 'Ecommerce Manager'];
  if (i.includes('hospitality')) return ['General Manager', 'Reservations Manager', 'Sales Manager'];
  if (i.includes('professional')) return ['Managing Partner', 'Business Development Lead', 'Operations Lead'];
  if (i.includes('logistics')) return ['Operations Manager', 'Commercial Manager', 'Customer Experience Lead'];
  if (i.includes('saas')) return ['Head of Growth', 'Revenue Operations Lead', 'Customer Success Lead'];
  return ['Operations Manager', 'Commercial Lead', 'Managing Director'];
}

function pickRole(row) {
  const currentRole = clean(row.role);
  if (currentRole && currentRole.toLowerCase() !== 'decision maker') return currentRole;
  return roleTargets(row.industry)[0];
}

function buildSubject(row) {
  const org = clean(row.organization) || 'your team';
  const i = clean(row.industry).toLowerCase();
  if (i.includes('retail')) return `Quick idea to improve ${org} response-to-sale speed`;
  if (i.includes('hospitality')) return `Faster guest inquiry handling for ${org}`;
  if (i.includes('professional')) return `Practical way to improve lead follow-up at ${org}`;
  return `Quick revenue workflow idea for ${org}`;
}

function buildOpening(row) {
  const org = clean(row.organization) || 'your team';
  return `Hi {{name}}, we help teams like ${org} improve lead-to-revenue conversion with practical automation. If useful, I can share a 2-step same-day setup.`;
}

function buildQueries(row, targetRole) {
  const org = clean(row.organization);
  const domain = domainFromWebsite(row.website || row.source_url);
  const q1 = `${org} Kenya ${targetRole} email`;
  const q2 = `site:linkedin.com/in ${org} ${targetRole} Kenya`;
  const q3 = domain ? `site:${domain} ${targetRole}` : `${org} official website leadership team`;
  const q4 = `"${org}" "contact" Kenya`;
  return [q1, q2, q3, q4];
}

function toCsv(rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  return XLSX.utils.sheet_to_csv(ws);
}

function priorityBucket(score) {
  const n = Number(score || 0);
  if (n >= 80) return 'hot';
  if (n >= 70) return 'warm';
  return 'cool';
}

if (!fs.existsSync(SOURCE)) {
  console.error(`Source not found: ${SOURCE}`);
  process.exit(1);
}

const rows = parseRows(SOURCE);
const ready = [];
const research = [];

for (const row of rows) {
  const email = validEmail(row.email) ? clean(row.email) : '';
  const phone = cleanPhone(row.phone);
  const org = clean(row.organization);
  const targetRole = pickRole(row);
  const [q1, q2, q3, q4] = buildQueries(row, targetRole);

  const base = {
    organization: org,
    industry: clean(row.industry),
    priority_score: clean(row.priority_score),
    urgency_bucket: priorityBucket(row.priority_score),
    target_role: targetRole,
    contact_name: clean(row.contact_name),
    email,
    phone,
    ready_channel: email ? 'email' : (phone ? 'phone/whatsapp' : ''),
    status: clean(row.status) || 'new',
    approach_subject: buildSubject(row),
    approach_opening: buildOpening(row),
    research_query_1: q1,
    research_query_2: q2,
    research_query_3: q3,
    research_query_4: q4,
    website: clean(row.website),
    source_url: clean(row.source_url),
    next_action: clean(row.next_action)
  };

  if (email || phone) {
    ready.push(base);
  } else {
    research.push(base);
  }
}

ready.sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0));
research.sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0));

const topResearch = research.slice(0, 25);

fs.writeFileSync(READY_OUT, toCsv(ready), 'utf8');
fs.writeFileSync(RESEARCH_OUT, toCsv(topResearch), 'utf8');

const summary = {
  generated_at: new Date().toISOString(),
  total_rows: rows.length,
  ready_now: ready.length,
  needs_research: research.length,
  research_exported: topResearch.length,
  files: {
    ready: path.basename(READY_OUT),
    research: path.basename(RESEARCH_OUT)
  }
};

fs.writeFileSync(SUMMARY_OUT, JSON.stringify(summary, null, 2), 'utf8');

console.log(`Processed ${rows.length} rows`);
console.log(`Ready now: ${ready.length}`);
console.log(`Needs research: ${research.length}`);
console.log(`Exported top research queue: ${topResearch.length}`);
console.log(`Wrote: ${path.basename(READY_OUT)}`);
console.log(`Wrote: ${path.basename(RESEARCH_OUT)}`);
console.log(`Wrote: ${path.basename(SUMMARY_OUT)}`);
