/**
 * Who has an open WhatsApp window right now (2026-11-19)
 *
 * Meta allows free-form text only within 24 hours of the person's last message. Inside that
 * window a reply is free, immediate, and can carry any link or price — outside it only an
 * approved template gets through, and the only approved template here takes no variables.
 *
 * So the window is a perishable asset: people wrote today, and every hour it closes makes
 * them a stranger again. This lists them, shows what they said, drafts a reply, and sends
 * only with --apply and only to a number you name.
 *
 *   node scripts/wa_window.mjs
 *   node scripts/wa_window.mjs --to 254743780542 --text "…" --apply
 */
import 'dotenv/config';
import { requireSupabaseEnv } from '../utils/supabaseEnv.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = String(process.env.WHATSAPP_TOKEN || '').trim();
const PHONE_ID = String(process.env.PHONE_NUMBER_ID || '').trim();
const WINDOW_MS = 24 * 60 * 60 * 1000;

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

const digits = (v) => String(v || '').replace(/\D/g, '');
const last9 = (v) => digits(v).slice(-9);
const toMsisdn = (v) => {
  const d = digits(v);
  if (d.startsWith('254') && d.length >= 12) return d;
  if (d.startsWith('0') && d.length === 10) return '254' + d.slice(1);
  return d.length === 9 ? '254' + d : d;
};

const { url, key } = requireSupabaseEnv();
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(url, key);
const { offerLine } = await import('../utils/founderOffer.js');

const toArg = arg('to', null);
const textArg = arg('text', null);
const apply = Boolean(arg('apply', false));

if (apply && toArg && textArg) {
  if (!TOKEN || !PHONE_ID) {
    console.error('Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID.');
    process.exit(2);
  }
  const res = await fetch(GRAPH + '/' + PHONE_ID + '/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toMsisdn(toArg),
      type: 'text',
      text: { preview_url: true, body: String(textArg) }
    }),
    signal: AbortSignal.timeout(25000)
  });
  const out = await res.json().catch(() => ({}));
  const id = out.messages?.[0]?.id || null;
  const err = out.error;
  console.log(res.status === 200 && id
    ? 'ACCEPTED  ' + toMsisdn(toArg) + '  ' + id + '\n   (a wamid is acceptance; the status callback is delivery)'
    : 'FAILED    ' + toMsisdn(toArg) + '  [' + (err?.code || res.status) + '] ' + (err?.message || 'no id returned'));
  process.exit(res.status === 200 && id ? 0 : 1);
}

// ---- who is open -------------------------------------------------------------
const since = new Date(Date.now() - WINDOW_MS).toISOString();
const { data: rawRows, error } = await sb
  .from('conversations')
  .select('created_at, direction, message_text, raw_payload')
  .eq('direction', 'incoming')
  .gte('created_at', since)
  .order('created_at', { ascending: false })
  .limit(200);
if (error) {
  console.error('Cannot read conversations: ' + error.message);
  process.exit(1);
}

const { data: tenants } = await sb
  .from('bot_tenants')
  .select('client_name, client_phone, point_of_contact_name, portal_token')
  .limit(300);

// conversations has no contact_phone column: the sender lives in raw_payload.
const byPhone = new Map();
for (const r of rawRows || []) {
  const from = digits(r.raw_payload?.from || r.raw_payload?.contacts?.[0]?.wa_id || '');
  if (!from) continue;
  const prev = byPhone.get(from);
  if (!prev) byPhone.set(from, { phone: from, first: r.created_at, last: r.created_at, messages: [r.message_text] });
  else {
    prev.messages.push(r.message_text);
    if (r.created_at < prev.first) prev.first = r.created_at;
    if (r.created_at > prev.last) prev.last = r.created_at;
  }
}

console.log('\n-- Open windows · ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC ---');
console.log('   ' + byPhone.size + ' number(s) wrote in the last 24h. Inside this window a free-form reply is legal.\n');

for (const [phone, row] of byPhone) {
  const tenant = (tenants || []).find((t) => last9(t.client_phone) === last9(phone)
    || last9(t.point_of_contact_phone) === last9(phone));
  const portal = tenant?.portal_token
    ? 'https://alphadome.onrender.com/tenant-dashboard?t=' + encodeURIComponent(tenant.portal_token) + '&phone=' + phone
    : null;
  console.log('   +' + phone + '  (' + (tenant?.client_name || 'not a tenant') + ')  '
    + row.messages.length + ' message(s), last ' + row.last);
  for (const m of row.messages.slice(0, 3)) {
    console.log('      them: ' + String(m || '').replace(/\s+/g, ' ').slice(0, 90));
  }
  console.log('      draft:');
  console.log('        Hi — thanks for writing' + (tenant ? ', your workspace for ' + tenant.client_name + ' is live' : '') + '.'
    + (portal ? ' Sign-in (no password): ' + portal : ''));
  console.log('        The system is ' + offerLine({ existing: true }) + '.');
  console.log('        Send your price list one line per item — Omo 1kg | 320 | 12 — and I will load it today.');
  console.log('      send: node scripts/wa_window.mjs --to ' + phone + ' --text "<the draft>" --apply\n');
}

if (!byPhone.size) {
  console.log('   Nobody is inside the window. A template is the only route back in — see npm run wa:send.\n');
}
