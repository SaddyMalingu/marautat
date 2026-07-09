const fs = require('fs');
const path = require('path');
const axios = require('axios');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const OUT_ALL = path.join(ROOT, 'ABOSS_DEEP_RESEARCH_MIXED.csv');
const OUT_TOP = path.join(ROOT, 'ABOSS_DEEP_RESEARCH_TOP12_BALANCED.csv');
const OUT_SUMMARY = path.join(ROOT, 'ABOSS_DEEP_RESEARCH_SUMMARY.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const candidates = [
  { org: 'Safaricom', segment: 'large', industry: 'telecom', website: 'https://www.safaricom.co.ke', urls: ['https://www.safaricom.co.ke', 'https://www.safaricom.co.ke/contact-us'] },
  { org: 'KCB Group', segment: 'large', industry: 'financial_services', website: 'https://www.kcbgroup.com', urls: ['https://www.kcbgroup.com/contact-us/', 'https://www.kcbgroup.com/write-to-us'] },
  { org: 'Equity Group', segment: 'large', industry: 'financial_services', website: 'https://equitygroupholdings.com', urls: ['https://equitygroupholdings.com', 'https://equitygroupholdings.com/contact-us/'] },
  { org: 'Kenya Airways', segment: 'large', industry: 'travel', website: 'https://www.kenya-airways.com', urls: ['https://www.kenya-airways.com', 'https://www.kenya-airways.com/en-ke/help/contact-us/'] },
  { org: 'Naivas Supermarket', segment: 'large', industry: 'retail', website: 'https://naivas.online', urls: ['https://naivas.online', 'https://corporate.naivas.info/help/'] },
  { org: 'Quickmart', segment: 'large', industry: 'retail', website: 'https://quickmart.co.ke', urls: ['https://www.quickmart.co.ke', 'https://www.quickmart.co.ke/contact-us'] },
  { org: 'Jumia Kenya', segment: 'large', industry: 'retail', website: 'https://www.jumia.co.ke', urls: ['https://www.jumia.co.ke', 'https://www.jumia.co.ke/sp-contact/'] },
  { org: 'PrideInn Hotels', segment: 'large', industry: 'hospitality', website: 'https://prideinnhotels.com', urls: ['https://prideinnhotels.com', 'https://prideinnhotels.com/contact-us/'] },
  { org: 'Sarova Hotels', segment: 'large', industry: 'hospitality', website: 'https://www.sarovahotels.com', urls: ['https://www.sarovahotels.com', 'https://www.sarovahotels.com/contact-us/'] },
  { org: 'DHL Kenya', segment: 'large', industry: 'logistics', website: 'https://www.dhl.com/ke-en/home.html', urls: ['https://www.dhl.com/ke-en/home.html', 'https://www.dhl.com/ke-en/home/contact-us.html'] },

  { org: 'Workpay', segment: 'sme', industry: 'saas', website: 'https://myworkpay.com', urls: ['https://myworkpay.com', 'https://myworkpay.com/contact-us'] },
  { org: 'PesaPal', segment: 'sme', industry: 'fintech', website: 'https://www.pesapal.com', urls: ['https://www.pesapal.com', 'https://www.pesapal.com/contact-us'] },
  { org: 'Sendy', segment: 'sme', industry: 'logistics', website: 'https://sendyit.com', urls: ['https://sendyit.com', 'https://sendyit.com/contact-us'] },
  { org: 'M-KOPA', segment: 'sme', industry: 'fintech', website: 'https://www.m-kopa.com', urls: ['https://www.m-kopa.com/contact', 'https://www.m-kopa.com'] },
  { org: 'Bamba', segment: 'sme', industry: 'saas', website: 'https://getbamba.com', urls: ['https://getbamba.com', 'https://getbamba.com/contact'] },
  { org: 'Twiga Foods', segment: 'sme', industry: 'retail', website: 'https://twiga.com', urls: ['https://twiga.com', 'https://twiga.com/contact-us/'] },
  { org: 'Copia Kenya', segment: 'sme', industry: 'retail', website: 'https://copia.co.ke', urls: ['https://copia.co.ke', 'https://copia.co.ke/contact'] },
  { org: 'iProcure', segment: 'sme', industry: 'agri_supply', website: 'https://iprocure.com', urls: ['https://iprocure.com', 'https://iprocure.com/contact-us/'] },
  { org: 'Moringa School', segment: 'sme', industry: 'education', website: 'https://moringaschool.com', urls: ['https://moringaschool.com', 'https://moringaschool.com/contact-us'] },
  { org: 'Nairobi Garage', segment: 'sme', industry: 'professional_services', website: 'https://nairobigarage.com', urls: ['https://nairobigarage.com', 'https://nairobigarage.com/contact/'] },
  { org: 'Kopo Kopo', segment: 'sme', industry: 'fintech', website: 'https://kopokopo.co.ke', urls: ['https://kopokopo.co.ke', 'https://kopokopo.co.ke/contact'] },
  { org: 'Pezesha', segment: 'sme', industry: 'fintech', website: 'https://www.pezesha.com', urls: ['https://www.pezesha.com', 'https://www.pezesha.com/contact-us/'] },
  { org: 'MarketForce', segment: 'sme', industry: 'saas', website: 'https://www.marketforce.io', urls: ['https://www.marketforce.io', 'https://www.marketforce.io/contact/'] },
  { org: 'Cellulant', segment: 'sme', industry: 'fintech', website: 'https://www.cellulant.io', urls: ['https://www.cellulant.io', 'https://www.cellulant.io/contact-us/'] }
];

function clean(v) {
  return String(v || '').trim();
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function extractEmails(html) {
  const matches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  return unique(matches)
    .map((e) => e.toLowerCase())
    .filter((e) => !e.includes('example.com') && !e.endsWith('.png') && !e.includes('wixpress.com'));
}

function extractPhones(html) {
  const compact = html.replace(/\s+/g, ' ');
  const raw = compact.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  const normalized = raw
    .map((p) => p.replace(/[^\d+]/g, ''))
    .map((p) => (p.startsWith('0') ? `+254${p.slice(1)}` : p))
    .filter((p) => p.length >= 10 && p.length <= 15);
  return unique(normalized);
}

function bestEmail(emails, org) {
  const o = clean(org).toLowerCase();
  const bad = ['noreply', 'no-reply', 'mailer-daemon', 'donotreply', 'privacy', 'cookie'];
  const preferred = ['sales@', 'business@', 'partnership', 'corporate', 'info@', 'support@', 'hello@', 'contact@'];

  const candidates = emails.filter((e) => !bad.some((b) => e.includes(b)));
  if (!candidates.length) return '';

  const orgHint = candidates.find((e) => o.split(' ')[0] && e.includes(o.split(' ')[0]));
  if (orgHint) return orgHint;

  const pref = candidates.find((e) => preferred.some((p) => e.includes(p)));
  return pref || candidates[0];
}

function bestPhone(phones) {
  if (!phones.length) return '';
  const kenya = phones.find((p) => p.startsWith('+254'));
  return kenya || phones[0];
}

function roleTarget(industry, segment) {
  const i = clean(industry).toLowerCase();
  if (i.includes('retail')) return 'Head of Operations';
  if (i.includes('hospitality')) return 'General Manager';
  if (i.includes('fintech') || i.includes('financial')) return 'Partnerships Lead';
  if (i.includes('logistics')) return 'Commercial Manager';
  if (i.includes('saas')) return 'Head of Growth';
  if (i.includes('education')) return 'Operations Manager';
  return segment === 'large' ? 'Business Development Manager' : 'Founder/Operations Lead';
}

function subjectFor(industry, org) {
  const i = clean(industry).toLowerCase();
  if (i.includes('retail')) return `Quick idea to improve ${org} response-to-sale speed`;
  if (i.includes('hospitality')) return `Faster inquiry handling for ${org}`;
  if (i.includes('fintech') || i.includes('financial')) return `Practical way to improve conversion follow-up at ${org}`;
  return `2-step same-day revenue workflow for ${org}`;
}

function openingFor(org) {
  return `Hi {{name}}, we help teams like ${org} improve lead-to-revenue conversion with practical automation. If useful, I can share a 2-step same-day setup tailored to ${org}.`;
}

function queryPack(org, role, domain) {
  return [
    `${org} Kenya ${role} email`,
    `site:linkedin.com/in ${org} ${role} Kenya`,
    domain ? `site:${domain} ${role}` : `${org} leadership team Kenya`,
    `"${org}" "contact" Kenya`
  ];
}

async function fetchUrl(url) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }
    });
    return String(res.data || '');
  } catch {
    return '';
  }
}

function domainOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function executionScore(segment, hasEmail, hasPhone) {
  let score = segment === 'sme' ? 78 : 70;
  if (hasEmail) score += 18;
  if (hasPhone) score += 10;
  return Math.min(score, 99);
}

(async () => {
  const rows = [];

  for (const c of candidates) {
    const pages = [];
    for (const u of c.urls) {
      const html = await fetchUrl(u);
      if (html) pages.push(html);
    }

    const combined = pages.join('\n');
    const emails = extractEmails(combined);
    const phones = extractPhones(combined);
    const email = bestEmail(emails, c.org);
    const phone = bestPhone(phones);
    const role = roleTarget(c.industry, c.segment);
    const domain = domainOf(c.website);
    const [q1, q2, q3, q4] = queryPack(c.org, role, domain);
    const score = executionScore(c.segment, !!email, !!phone);

    rows.push({
      organization: c.org,
      segment: c.segment,
      industry: c.industry,
      website: c.website,
      target_role: role,
      email,
      phone,
      channel_primary: email ? 'email' : phone ? 'phone/whatsapp' : 'linkedin/email-research',
      execution_score: score,
      approach_subject: subjectFor(c.industry, c.org),
      approach_opening: openingFor(c.org),
      research_query_1: q1,
      research_query_2: q2,
      research_query_3: q3,
      research_query_4: q4,
      evidence_signals: `emails_found=${emails.length};phones_found=${phones.length};pages_fetched=${pages.length}`,
      next_action: email || phone ? 'Send first touch now' : 'Research role-holder then send',
      status: 'new'
    });
  }

  const sorted = [...rows].sort((a, b) => b.execution_score - a.execution_score);
  const large = sorted.filter((r) => r.segment === 'large').slice(0, 6);
  const sme = sorted.filter((r) => r.segment === 'sme').slice(0, 6);
  const top12 = [...large, ...sme].sort((a, b) => b.execution_score - a.execution_score);

  fs.writeFileSync(OUT_ALL, XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(sorted)), 'utf8');
  fs.writeFileSync(OUT_TOP, XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(top12)), 'utf8');

  const summary = {
    generated_at: new Date().toISOString(),
    total_candidates: rows.length,
    with_email: rows.filter((r) => !!r.email).length,
    with_phone: rows.filter((r) => !!r.phone).length,
    large_count: rows.filter((r) => r.segment === 'large').length,
    sme_count: rows.filter((r) => r.segment === 'sme').length,
    top12_balance: {
      large: top12.filter((r) => r.segment === 'large').length,
      sme: top12.filter((r) => r.segment === 'sme').length
    },
    files: {
      all: path.basename(OUT_ALL),
      top12: path.basename(OUT_TOP)
    }
  };
  fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`Candidates processed: ${rows.length}`);
  console.log(`With email: ${summary.with_email}`);
  console.log(`With phone: ${summary.with_phone}`);
  console.log(`Top balanced list: ${path.basename(OUT_TOP)} (${top12.length} rows)`);
})();
