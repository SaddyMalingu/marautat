#!/usr/bin/env node

/**
 * Prepare the rung-3 outreach batch (2026-11-11).
 *
 * The funnel build is a service that sells by conversation, so the first step is
 * a short, specific message to people who already asked us something. This script
 * finds them, drafts the message, and writes a queue. **It sends nothing.** Sending
 * is a human decision with a human signature, and an automated blast to the
 * onboarding queue is exactly how a paid lead turns into spam.
 *
 * Source, in order:
 *   1. `public.discovery_submissions` (Supabase) — the onboarding queue itself,
 *      read-only. Nothing is updated, approved or invited.
 *   2. `logs/discovery_submissions.jsonl` — the fallback the discovery endpoint
 *      writes when the table is unavailable.
 *
 * Usage:
 *   node scripts/build_page_outreach.mjs                 # 20 newest, 90 days
 *   node scripts/build_page_outreach.mjs --limit=40
 *   node scripts/build_page_outreach.mjs --days=365 --include-contacted
 *   node scripts/build_page_outreach.mjs --print          # also print messages
 *
 * Output: `logs/build_page_outreach.csv` — one row per prospect with a `message`
 * column you can paste. Never writes to the database.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// Reads SB_URL / SB_SERVICE_ROLE_KEY from .env; without this the script reports
// "no recipients" while the credentials are right there in the file.
import 'dotenv/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(root, 'logs', 'discovery_submissions.jsonl');
const OUT_FILE = path.join(root, 'logs', 'build_page_outreach.csv');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const limit = Math.max(1, Number(arg('limit', 20)) || 20);
const days = Math.max(1, Number(arg('days', 90)) || 90);
const includeContacted = args.includes('--include-contacted');
const print = args.includes('--print');
const senderName = String(arg('sender', process.env.DROPS_SENDER_NAME || 'Alphadome')).trim();
const buildUrl = String(arg('url', process.env.DROPS_BASE_URL || 'https://alphadome.onrender.com')).replace(/\/+$/, '') + '/build';

const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
const cleanDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

/**
 * One message, three sentences, one link. No "I hope this finds you well", no
 * claim about their revenue, and an explicit way to close the file.
 */
export function draftMessage(row, opts = {}) {
  const url = opts.url || buildUrl;
  const sender = opts.sender || senderName;
  const business = row.business_name ? String(row.business_name).trim() : '';
  const when = cleanDate(row.submitted_at);
  const industry = row.industry ? String(row.industry).trim() : '';

  const opening = business
    ? 'You asked us about ' + business + (industry ? ' (' + industry + ')' : '') + (when ? ' on ' + when : '') + '.'
    : 'You asked us about getting sales out of WhatsApp' + (when ? ' on ' + when : '') + '.';

  const body = 'That is now a fixed-scope build: the WhatsApp sales flow, M-Pesa or card checkout, and the pages that answer what your buyers already search for. From $3,000, 2–3 weeks, scoped in writing before anything starts.';

  const cta = 'If it is still the problem, the scope form takes two minutes: ' + url
    + '\nIf it is not, reply "not now" and I will close the file.';

  return [opening, '', body, '', cta, '', '— ' + sender].join('\n');
}

async function readFromDb() {
  const url = process.env.SUPABASE_URL || process.env.SB_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await sb
    .from('discovery_submissions')
    .select('id, name, email, business_name, industry, budget, timeline, status, submitted_at')
    .gte('submitted_at', since)
    .order('submitted_at', { ascending: false })
    .limit(500);
  if (error) {
    console.error('Could not read discovery_submissions: ' + error.message);
    return null;
  }
  return Array.isArray(data) ? data : [];
}

function readFromLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  const rows = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const src = parsed && parsed.submission ? parsed.submission : parsed;
      if (src && (src.email || src.name)) rows.push(src);
    } catch (_) { /* a torn line is not worth failing the batch */ }
  }
  return rows;
}

/** New prospects only. An approved submission is already a tenant; a rejected one is closed. */
export function selectRecipients(rows, opts = {}) {
  const windowDays = opts.days || days;
  const cap = opts.limit || limit;
  const since = Date.now() - windowDays * 86400000;
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.email)
    .filter((r) => {
      const status = String(r.status || 'new').toLowerCase();
      if (status === 'approved' || status === 'rejected') return false;
      if (!opts.includeContacted && status === 'contacted') return false;
      const when = new Date(r.submitted_at || 0).getTime();
      return !isNaN(when) && when >= since;
    })
    .sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0))
    .filter((r) => {
      const key = String(r.email).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, cap);
}

async function main() {
  const fromDb = await readFromDb();
  const source = fromDb ? 'discovery_submissions' : (fs.existsSync(LOG_FILE) ? 'logs/discovery_submissions.jsonl' : 'none');
  const rows = selectRecipients(fromDb || readFromLog());

  if (!rows.length) {
    console.log('No recipients found in the last ' + days + ' days (source: ' + source + ').');
    console.log('Set SB_URL + SB_SERVICE_ROLE_KEY, or check ' + path.relative(root, LOG_FILE) + '.');
    console.log('Nothing was written and nothing was sent.');
    return;
  }

  const header = ['email', 'name', 'business_name', 'industry', 'budget', 'timeline', 'status', 'submitted_at', 'message'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    const message = draftMessage(r, { url: buildUrl, sender: senderName });
    lines.push([
      r.email, r.name || '', r.business_name || '', r.industry || '',
      r.budget || '', r.timeline || '', r.status || 'new', r.submitted_at || '', message,
    ].map(csvCell).join(','));
    if (print) console.log('\n--- ' + (r.email || '') + ' ---\n' + message);
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');

  console.log('Source: ' + source);
  console.log('Drafted ' + rows.length + ' message(s) -> ' + path.relative(root, OUT_FILE));
  console.log('Nothing was sent. Read them, edit the ones that need it, then send from your own inbox.');
  console.log('Recipients are prospects from the onboarding queue; the queue itself was not modified.');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

