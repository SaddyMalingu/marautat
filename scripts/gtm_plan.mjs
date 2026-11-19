/**
 * Explee-shaped outreach, researched from the company's own website (2026-11-19)
 *
 *   node scripts/gtm_plan.mjs --segment tour_operators --from leads.csv
 *   node scripts/gtm_plan.mjs --segment whatsapp_retailers --urls https://a.co.ke,https://b.co.ke
 *   node scripts/gtm_plan.mjs --segment tour_operators --from leads.csv --push
 *
 * What it does that the ABOSS scripts do not: it reads each company's **own site** for the
 * three signals that decide whether this offer lands —
 *
 *   • an email address        (a channel we can use)
 *   • a phone / WhatsApp link (they already sell on WhatsApp)
 *   • a checkout or pay link  (they already take money; if not, that is the observation)
 *
 * then scores, dedupes, and writes a three-touch sequence per business. `--push` creates a
 * draft wf_campaign so the portal shows the queue. Nothing is ever sent from here.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { buildPlan, segmentOf, SEGMENTS } from '../utils/gtmPlaybook.js';

function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const at = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at === -1) return fallback;
  const token = argv[at];
  if (token.includes('=')) return token.slice(token.indexOf('=') + 1);
  const next = argv[at + 1];
  if (next === undefined || String(next).startsWith('--')) return true;
  return next;
}

const segmentKey = String(arg('segment', '') || '').trim();
const fromFile = arg('from', null);
const urlsArg = String(arg('urls', '') || '');
const limit = Number(arg('limit', 25)) || 25;
const push = Boolean(arg('push', false));
const outFile = String(arg('out', 'GTM_PLAN.json'));

if (!segmentOf(segmentKey)) {
  console.error('Pick a segment: ' + Object.keys(SEGMENTS).join(', '));
  process.exit(2);
}

const UA = 'Mozilla/5.0 (compatible; AlphadomeGTM/1.0; +https://alphadome.onrender.com)';

/** A company's own pages, read once, for the three signals that matter. */
async function inspectSite(website) {
  const base = String(website || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { website: base, reachable: false };
  const pages = [base, base + '/contact', base + '/contact-us'];
  const found = { website: base, reachable: false, email: '', phone: '', has_whatsapp_link: false, has_checkout: false, title: '' };

  for (const url of pages) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
      if (!res.ok) continue;
      const html = await res.text();
      found.reachable = true;
      if (!found.title) {
        const t = (html.match(/<title[^>]*>([^<]{2,120})/i) || [])[1];
        if (t) found.title = t.trim();
      }
      if (!found.email) {
        const mail = (html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [])[0];
        if (mail && !/example|sentry|wixpress|domain/i.test(mail)) found.email = mail.toLowerCase();
      }
      if (!found.phone) {
        const tel = (html.match(/tel:\+?([0-9\s\-()]{7,20})/i) || [])[1];
        if (tel) found.phone = tel.replace(/\D/g, '');
      }
      if (/wa\.me\/|api\.whatsapp\.com\/send|whatsapp\.com\/send/i.test(html)) found.has_whatsapp_link = true;
      if (/add[-\s]?to[-\s]?cart|checkout|buy now|pay now|pesapal|paystack|flutterwave/i.test(html)) found.has_checkout = true;
    } catch {
      /* one unreachable page is not a reason to drop the company */
    }
  }
  return found;
}


// ---- who to research ---------------------------------------------------------
let candidates = [];
if (fromFile) {
  const raw = fs.readFileSync(path.resolve(String(fromFile)), 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const header = lines[0].toLowerCase().split(',').map((h) => h.trim());
  const col = (name, fallback) => (header.indexOf(name) >= 0 ? header.indexOf(name) : fallback);
  const iOrg = col('org', col('organization', 0));
  const iWeb = col('website', 1);
  const iMail = col('email', -1);
  const iPhone = col('phone', -1);
  const iName = col('contact_name', col('name', -1));
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    if (!cells[iOrg]) continue;
    candidates.push({
      org: cells[iOrg],
      website: cells[iWeb] || '',
      email: iMail >= 0 ? cells[iMail] || '' : '',
      phone: iPhone >= 0 ? cells[iPhone] || '' : '',
      contact_name: iName >= 0 ? cells[iName] || '' : '',
      segment: segmentKey
    });
  }
} else if (urlsArg) {
  candidates = urlsArg.split(',').map((u) => u.trim()).filter(Boolean).map((u) => ({
    org: u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0],
    website: u,
    segment: segmentKey
  }));
} else {
  console.error('Give me who to research: --from leads.csv or --urls https://a,https://b');
  process.exit(2);
}

console.log('\n-- GTM research · ' + segmentOf(segmentKey).label + ' ---');
console.log('   ' + candidates.length + ' candidate(s); reading each site for email, phone, WhatsApp and checkout…\n');

const leads = [];
for (const c of candidates) {
  const site = await inspectSite(c.website);
  leads.push({
    ...c,
    email: c.email || site.email,
    phone: c.phone || site.phone,
    has_whatsapp_link: site.has_whatsapp_link,
    has_checkout: site.has_checkout,
    reachable: site.reachable,
    title: site.title,
    named_contact: Boolean(c.contact_name)
  });
  const bits = [
    site.email ? 'email' : '',
    site.phone ? 'phone' : '',
    site.has_whatsapp_link ? 'WhatsApp' : '',
    site.has_checkout ? 'checkout' : 'no checkout'
  ].filter(Boolean).join(', ');
  console.log('   ' + String(c.org || c.website).slice(0, 32).padEnd(34) + (site.reachable ? bits : 'unreachable'));
}

const plan = buildPlan(leads, segmentKey, { limit });
const out = {
  generated_at: new Date().toISOString(),
  segment: segmentKey,
  label: segmentOf(segmentKey).label,
  candidates: candidates.length,
  qualified: plan.total,
  rows: plan.rows
};
fs.writeFileSync(path.resolve(String(outFile)), JSON.stringify(out, null, 2));
console.log('\n   ' + plan.total + ' qualified of ' + candidates.length + ' → ' + outFile);
console.log('   Nothing has been sent. Each row carries a 3-touch sequence.\n');

if (push) {
  const { requireSupabaseEnv } = await import('../utils/supabaseEnv.js');
  const { url, key } = requireSupabaseEnv();
  const { createClient } = await import('@supabase/supabase-js');
  const { insertWfCampaign } = await import('../utils/wfCampaigns.js');
  const sb = createClient(url, key);
  try {
    const campaign = await insertWfCampaign(sb, {
      name: 'gtm ' + segmentKey + ' ' + new Date().toISOString().slice(0, 10),
      keywords: [segmentOf(segmentKey).label],
      industries: [],
      outreach_types: ['pitch'],
      channels: ['email'],
      target_count: Math.min(25, plan.rows.length || 1),
      quality_threshold: 70,
      status: 'draft',
      tenant_id: null,
      metadata: { gtm_plan: outFile }
    });
    console.log('   Draft campaign created: ' + (campaign?.id || '(no id)') + ' — press Run in the portal.');
  } catch (err) {
    console.error('   Campaign create failed: ' + err.message);
  }
}
