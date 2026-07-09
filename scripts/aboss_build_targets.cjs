#!/usr/bin/env node

const fs = require('fs');

const OUT_FILE = process.argv[2] || 'ABOSS_CONTACT_CAPTURE_TEMPLATE.csv';
const LIMIT = Number(process.argv[3] || 60);

const QUERIES = [
  'site:ke retail Nairobi contact',
  'site:ke hospitality Nairobi contact',
  'site:ke professional services Nairobi contact',
  'site:ke logistics Kenya contact',
  'site:ke saas Kenya contact',
  'Kenya business automation company Nairobi',
  'Kenya ecommerce stores contact',
  'Kenya hotel group contact',
  'Kenya consulting firms contact',
  'Kenya courier logistics contact',
];

const PHONE_REGEX = /(?:\+?254|0)\d{9}|(?:\+?\d[\d\s().-]{8,}\d)/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.toString();
  } catch {
    return null;
  }
}

function domainToOrg(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const first = host.split('.')[0] || host;
    return first
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (m) => m.toUpperCase());
  } catch {
    return 'Unknown Organization';
  }
}

function inferIndustry(query) {
  const q = query.toLowerCase();
  if (q.includes('retail') || q.includes('ecommerce')) return 'retail';
  if (q.includes('hospitality') || q.includes('hotel')) return 'hospitality';
  if (q.includes('professional') || q.includes('consulting')) return 'professional_services';
  if (q.includes('logistics') || q.includes('courier')) return 'logistics';
  if (q.includes('saas')) return 'saas';
  return 'general_business';
}

async function fetchText(url, timeout = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function extractResultUrlsFromDuck(html) {
  const urls = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    if (u && u.startsWith('http')) urls.push(u);
  }
  return urls;
}

function pickOne(arr) {
  return Array.isArray(arr) && arr.length ? arr[0] : '';
}

async function harvestContact(url) {
  try {
    const html = await fetchText(url, 10000);
    const emails = [...new Set((html.match(EMAIL_REGEX) || []))]
      .filter((e) => !/example\.com|noreply|no-reply/i.test(e));
    const phones = [...new Set((html.match(PHONE_REGEX) || []))]
      .map((p) => p.replace(/\s+/g, ' ').trim());
    return { email: pickOne(emails), phone: pickOne(phones) };
  } catch {
    return { email: '', phone: '' };
  }
}

async function main() {
  const all = [];
  const seenDomain = new Set();

  for (const q of QUERIES) {
    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    let html = '';
    try {
      html = await fetchText(searchUrl, 15000);
    } catch {
      continue;
    }
    const resultUrls = extractResultUrlsFromDuck(html);
    for (const rawUrl of resultUrls) {
      const url = safeUrl(rawUrl);
      if (!url) continue;
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (seenDomain.has(host)) continue;
      seenDomain.add(host);

      const contact = await harvestContact(url);
      const org = domainToOrg(url);
      const industry = inferIndustry(q);
      const intent = `Matched query: ${q}`;
      const score = contact.email && contact.phone ? 90 : contact.email ? 80 : contact.phone ? 70 : 55;

      all.push({
        organization: org,
        website: `${new URL(url).protocol}//${host}`,
        contact_name: '',
        role: '',
        email: contact.email,
        phone: contact.phone,
        source_url: url,
        industry,
        intent_signal: intent,
        priority_score: score,
        channel_primary: contact.email ? 'email' : 'phone',
        status: 'new',
        next_action: 'Send first-touch value message',
        notes: '',
      });

      if (all.length >= LIMIT) break;
    }
    if (all.length >= LIMIT) break;
  }

  const header = [
    'organization',
    'website',
    'contact_name',
    'role',
    'email',
    'phone',
    'source_url',
    'industry',
    'intent_signal',
    'priority_score',
    'channel_primary',
    'status',
    'next_action',
    'notes',
  ];

  const lines = [header.join(',')];
  for (const row of all) {
    lines.push(header.map((k) => csvEscape(row[k])).join(','));
  }

  fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${all.length} targets to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('Target build failed:', err.message);
  process.exit(1);
});
