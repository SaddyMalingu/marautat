const fs = require('fs');
const path = require('path');
const axios = require('axios');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const SENT_FILE = path.join(ROOT, 'ABOSS_MIXED_SEND_NOW_REFRESHED.csv');
const BATCH2_FILE = path.join(ROOT, 'ABOSS_BATCH2_TOMORROW.csv');
const NEW_OUT = path.join(ROOT, 'ABOSS_HIDDEN_CHAMPIONS_STRIKE.csv');
const MERGED_OUT = path.join(ROOT, 'ABOSS_BATCH2_TOMORROW_REFRESHED.csv');
const REPORT_OUT = path.join(ROOT, 'logs', 'ABOSS_HIDDEN_CHAMPIONS_REPORT_2026-07-06.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const bouncedEmails = new Set([
  'contact@mafcarrefour.com',
  'channelsales@hotpoint.co.ke'
]);

const candidates = [
  { org: 'Tibu Health', segment: 'sme', industry: 'healthtech', website: 'https://tibuhealth.com', urls: ['https://tibuhealth.com', 'https://tibuhealth.com/contact/'] },
  { org: 'Ilara Health', segment: 'sme', industry: 'healthtech', website: 'https://ilarahealth.com', urls: ['https://ilarahealth.com', 'https://ilarahealth.com/contact-us/'] },
  { org: 'BasiGo', segment: 'sme', industry: 'mobility', website: 'https://basi-go.com', urls: ['https://basi-go.com', 'https://basi-go.com/contact/'] },
  { org: 'M-Gas', segment: 'sme', industry: 'energy', website: 'https://mgas.ke', urls: ['https://mgas.ke', 'https://mgas.ke/contact/'] },
  { org: 'Copia Kenya', segment: 'sme', industry: 'retail', website: 'https://copia.co.ke', urls: ['https://copia.co.ke', 'https://copia.co.ke/contact/'] },
  { org: 'Twiva', segment: 'sme', industry: 'social-commerce', website: 'https://twiva.co.ke', urls: ['https://twiva.co.ke', 'https://twiva.co.ke/contact/'] },
  { org: 'Lipa Later', segment: 'sme', industry: 'fintech', website: 'https://lipalater.com', urls: ['https://lipalater.com', 'https://lipalater.com/contact-us/'] },
  { org: 'KOKO Networks', segment: 'sme', industry: 'energy', website: 'https://kokonetworks.com', urls: ['https://kokonetworks.com', 'https://kokonetworks.com/contact/'] },
  { org: 'Victory Farms', segment: 'sme', industry: 'agri', website: 'https://victoryfarms.co', urls: ['https://victoryfarms.co', 'https://victoryfarms.co/contact/'] },
  { org: 'Greenspoon', segment: 'sme', industry: 'retail', website: 'https://greenspoon.co.ke', urls: ['https://greenspoon.co.ke', 'https://greenspoon.co.ke/contact-us/'] },
  { org: 'Sendy', segment: 'sme', industry: 'logistics', website: 'https://sendyit.com', urls: ['https://sendyit.com', 'https://sendyit.com/contact-us'] },
  { org: 'Pezesha', segment: 'sme', industry: 'fintech', website: 'https://www.pezesha.com', urls: ['https://www.pezesha.com', 'https://www.pezesha.com/contact-us/'] },
  { org: 'Cellulant', segment: 'sme', industry: 'fintech', website: 'https://www.cellulant.io', urls: ['https://www.cellulant.io', 'https://www.cellulant.io/contact-us/'] },
  { org: 'MarketForce', segment: 'sme', industry: 'saas', website: 'https://www.marketforce.io', urls: ['https://www.marketforce.io', 'https://www.marketforce.io/contact/'] },
  { org: 'iProcure', segment: 'sme', industry: 'agri_supply', website: 'https://iprocure.com', urls: ['https://iprocure.com', 'https://iprocure.com/contact-us/'] },
  { org: 'Bamba', segment: 'sme', industry: 'saas', website: 'https://getbamba.com', urls: ['https://getbamba.com', 'https://getbamba.com/contact'] }
];

function clean(v) {
  return String(v || '').trim();
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
}

function writeCsv(filePath, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  fs.writeFileSync(filePath, XLSX.utils.sheet_to_csv(ws), 'utf8');
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function extractEmails(html) {
  const matches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  return unique(
    matches
      .map((e) => e.toLowerCase())
      .filter((e) => !bouncedEmails.has(e))
      .filter((e) => !e.includes('example.com'))
      .filter((e) => !e.endsWith('.png'))
  );
}

function normalizeKenyaPhone(raw) {
  const digits = clean(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits === '2147483647') return '';
  if (digits.startsWith('254') && digits.length === 12) return `+${digits}`;
  if ((digits.startsWith('07') || digits.startsWith('01')) && digits.length === 10) return `+254${digits.slice(1)}`;
  return '';
}

function extractPhones(html) {
  const compact = html.replace(/\s+/g, ' ');
  const hits = compact.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  return unique(hits.map(normalizeKenyaPhone).filter(Boolean));
}

function extractSocial(html) {
  const linkedin = unique((html.match(/https?:\/\/(?:[\w.-]+\.)?linkedin\.com\/[^\s"'<>)]*/gi) || []).map((u) => u.replace(/[),.;]+$/, '')));
  const instagram = unique((html.match(/https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>)]*/gi) || []).map((u) => u.replace(/[),.;]+$/, '')));
  return { linkedin, instagram };
}

function rankEmail(emails) {
  if (!emails.length) return '';
  const prefs = ['partnership', 'sales@', 'business@', 'hello@', 'info@', 'contact@', 'support@'];
  for (const p of prefs) {
    const found = emails.find((e) => e.includes(p));
    if (found) return found;
  }
  return emails[0];
}

function roleForIndustry(industry) {
  const i = clean(industry).toLowerCase();
  if (i.includes('retail')) return 'Head of Operations';
  if (i.includes('fintech')) return 'Partnerships Lead';
  if (i.includes('healthtech')) return 'Operations Manager';
  if (i.includes('saas')) return 'Head of Growth';
  if (i.includes('agri')) return 'Commercial Manager';
  if (i.includes('energy')) return 'Partnerships Lead';
  return 'Business Development Lead';
}

function subjectFor(industry, org) {
  const i = clean(industry).toLowerCase();
  if (i.includes('retail')) return `Quick idea to improve ${org} response-to-sale speed`;
  if (i.includes('fintech')) return `Practical way to improve conversion follow-up at ${org}`;
  return `2-step same-day revenue workflow for ${org}`;
}

function openingFor(org) {
  return `Hi {{name}}, we help teams like ${org} improve lead-to-revenue conversion with practical automation. If useful, I can share a 2-step same-day setup tailored to ${org}.`;
}

function score(hasEmail, hasPhone, hasLinkedIn, hasInstagram) {
  let s = 70;
  if (hasEmail) s += 16;
  if (hasPhone) s += 10;
  if (hasLinkedIn) s += 6;
  if (hasInstagram) s += 3;
  return Math.min(99, s);
}

async function fetchHtml(url) {
  try {
    const res = await axios.get(url, {
      timeout: 18000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }
    });
    return String(res.data || '');
  } catch {
    return '';
  }
}

async function run() {
  const sent = readCsv(SENT_FILE);
  const existingBatch = readCsv(BATCH2_FILE);
  const contacted = new Set(sent.map((r) => clean(r.organization).toLowerCase()));
  const alreadyQueued = new Set(existingBatch.map((r) => clean(r.organization).toLowerCase()));

  const researched = [];

  for (const c of candidates) {
    const orgKey = clean(c.org).toLowerCase();
    if (contacted.has(orgKey) || alreadyQueued.has(orgKey)) continue;

    const pages = [];
    for (const url of c.urls) {
      const html = await fetchHtml(url);
      if (html) pages.push({ url, html });
    }

    if (!pages.length) continue;

    const combined = pages.map((p) => p.html).join('\n');
    const emails = extractEmails(combined);
    const phones = extractPhones(combined);
    const social = extractSocial(combined);

    const email = rankEmail(emails);
    const phone = phones[0] || '';
    const linkedin = social.linkedin[0] || '';
    const instagram = social.instagram[0] || '';

    if (!email && !phone) continue;

    const hasEmail = !!email;
    const hasPhone = !!phone;
    const hasLinkedIn = !!linkedin;
    const hasInstagram = !!instagram;

    researched.push({
      organization: c.org,
      segment: c.segment,
      industry: c.industry,
      target_role: roleForIndustry(c.industry),
      email,
      phone,
      channel_primary: hasEmail ? 'email' : 'phone/whatsapp',
      priority_score: score(hasEmail, hasPhone, hasLinkedIn, hasInstagram),
      reason_selected: 'deep_research_hidden_champion',
      approach_subject: subjectFor(c.industry, c.org),
      approach_opening: openingFor(c.org),
      linkedin_url: linkedin,
      instagram_url: instagram,
      source_urls: pages.map((p) => p.url).join('|'),
      validation_signals: `emails_found=${emails.length};phones_found=${phones.length};linkedin=${hasLinkedIn};instagram=${hasInstagram}`,
      next_action: 'Send first-touch tomorrow after follow-up batch',
      status: 'queued_batch2_new'
    });
  }

  researched.sort((a, b) => Number(b.priority_score) - Number(a.priority_score));

  const refreshedBatch = [...existingBatch];
  const existingOrgSet = new Set(existingBatch.map((r) => clean(r.organization).toLowerCase()));
  for (const row of researched) {
    const key = clean(row.organization).toLowerCase();
    if (!existingOrgSet.has(key)) {
      refreshedBatch.push(row);
      existingOrgSet.add(key);
    }
  }

  refreshedBatch.sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0));

  writeCsv(NEW_OUT, researched);
  writeCsv(MERGED_OUT, refreshedBatch);

  const report = {
    generated_at: new Date().toISOString(),
    candidates_seeded: candidates.length,
    newly_researched_added: researched.length,
    batch2_existing: existingBatch.length,
    batch2_refreshed_total: refreshedBatch.length,
    files: {
      new_research: path.basename(NEW_OUT),
      batch2_refreshed: path.basename(MERGED_OUT)
    }
  };
  fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2), 'utf8');

  console.log(`New researched leads: ${researched.length}`);
  console.log(`Refreshed batch size: ${refreshedBatch.length}`);
  console.log(`Wrote: ${path.basename(NEW_OUT)}`);
  console.log(`Wrote: ${path.basename(MERGED_OUT)}`);
  console.log(`Wrote: ${path.basename(REPORT_OUT)}`);
}

run().catch((err) => {
  console.error('Research run failed:', err.message);
  process.exit(1);
});
