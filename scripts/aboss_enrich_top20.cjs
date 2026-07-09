#!/usr/bin/env node

const fs = require('fs');

const FILE = process.argv[2] || 'ABOSS_CONTACT_CAPTURE_TEMPLATE.csv';
const TOP_N = Number(process.argv[3] || 20);

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?254|0)\s?\d{3}\s?\d{3}\s?\d{3}|(?:\+?\d[\d\s().-]{8,}\d)/g;

const CONTACT_PATHS = [
  '',
  '/contact',
  '/contact-us',
  '/about',
  '/about-us',
  '/customer-care',
  '/support',
  '/our-team',
  '/reservations',
];

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else if (ch === '"') {
      inQ = true;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function toCsvLine(cols) {
  return cols.map((v) => {
    const s = String(v == null ? '' : v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }).join(',');
}

function pickBestEmail(list) {
  const filtered = list
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && !/example\.com|noreply|no-reply|donotreply/.test(e));
  const scored = filtered.sort((a, b) => {
    const score = (x) => {
      if (/sales|business|partnership|info|contact|support|care/.test(x)) return 2;
      return 1;
    };
    return score(b) - score(a);
  });
  return scored[0] || '';
}

function normalizePhone(p) {
  const raw = String(p || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('254') && digits.length >= 12) return `+${digits.slice(0, 12)}`;
  if (digits.startsWith('0') && digits.length === 10) return `+254${digits.slice(1)}`;
  return raw;
}

function pickBestPhone(list) {
  const norm = [...new Set(list.map(normalizePhone).filter(Boolean))];
  return norm[0] || '';
}

function inferContactName(text) {
  const lower = String(text || '').toLowerCase();
  if (/(customer care|customer support)/.test(lower)) return 'Customer Care Team';
  if (/reservations/.test(lower)) return 'Reservations Team';
  if (/sales/.test(lower)) return 'Sales Team';
  if (/business development/.test(lower)) return 'Business Development Team';
  if (/contact us|support/.test(lower)) return 'Support Team';
  return 'Contact Team';
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function enrichWebsite(site) {
  let base = site;
  try {
    const u = new URL(site);
    base = `${u.protocol}//${u.host}`;
  } catch {
    return { email: '', phone: '', contactName: 'Contact Team' };
  }

  const emails = [];
  const phones = [];
  let mergedText = '';

  for (const p of CONTACT_PATHS) {
    const url = `${base}${p}`;
    const html = await fetchPage(url);
    if (!html) continue;
    mergedText += `\n${html.slice(0, 12000)}`;
    emails.push(...(html.match(EMAIL_RE) || []));
    phones.push(...(html.match(PHONE_RE) || []));
    if (emails.length || phones.length) {
      // keep crawling a bit for better confidence
    }
  }

  return {
    email: pickBestEmail(emails),
    phone: pickBestPhone(phones),
    contactName: inferContactName(mergedText),
  };
}

async function main() {
  const raw = fs.readFileSync(FILE, 'utf8').trimEnd();
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) {
    console.error('CSV has no rows.');
    process.exit(1);
  }

  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const required = ['website', 'contact_name', 'email', 'phone', 'notes'];
  for (const k of required) {
    if (idx[k] == null) {
      console.error(`Missing column: ${k}`);
      process.exit(1);
    }
  }

  const rows = lines.slice(1).map(parseCsvLine);
  const top = Math.min(TOP_N, rows.length);

  for (let i = 0; i < top; i += 1) {
    const row = rows[i];
    const site = row[idx.website];
    if (!site) continue;
    const found = await enrichWebsite(site);

    if (found.contactName && !row[idx.contact_name]) row[idx.contact_name] = found.contactName;
    if (found.email) row[idx.email] = found.email;
    if (found.phone) row[idx.phone] = found.phone;

    const noteParts = [];
    if (found.email) noteParts.push('email_verified_web');
    if (found.phone) noteParts.push('phone_verified_web');
    if (!noteParts.length) noteParts.push('manual_research_needed');
    row[idx.notes] = noteParts.join('|');

    // light pacing for politeness
    await new Promise((r) => setTimeout(r, 150));
  }

  const out = [toCsvLine(header), ...rows.map(toCsvLine)].join('\n') + '\n';
  fs.writeFileSync(FILE, out, 'utf8');
  console.log(`Enriched top ${top} rows in ${FILE}`);
}

main().catch((err) => {
  console.error('Enrichment failed:', err.message);
  process.exit(1);
});
