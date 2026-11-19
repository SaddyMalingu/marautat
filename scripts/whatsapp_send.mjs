/**
 * Send the tenant campaign from the platform's own WhatsApp number (2026-11-19)
 *
 *   node scripts/whatsapp_send.mjs                      # preflight: who am I, what may I send
 *   node scripts/whatsapp_send.mjs --to 254713793488    # one number, still a dry run
 *   node scripts/whatsapp_send.mjs --apply              # send to every active tenant
 *
 * ## Why this is template-only
 *
 * Meta allows a business to send *free-form text* only inside 24 hours of that person's
 * last message. The twelve tenants last wrote months ago (`docs/WHATSAPP_INTENT_AUDIT_2026-11-12.md`:
 * two inbound messages since 1 November), so a text send is rejected with 131047 and
 * counts against the number's quality rating — the same rating that the 10,212
 * `WHATSAPP_STATUS:failed` rows already strained.
 *
 * A template that Meta has approved can be sent at any time. So the preflight asks Meta
 * what this number actually has approved, and refuses to send anything that is not on
 * the list. When there is no approved template it prints the exact payload to create
 * one, because that is the real blocker and it should not be a mystery.
 *
 * Credentials come from the same variables the server uses: WHATSAPP_TOKEN and
 * PHONE_NUMBER_ID. They live on Render; put them in this machine's .env to send from
 * here. Nothing is sent without --apply, and every recipient's result is printed.
 */
import 'dotenv/config';

const GRAPH = 'https://graph.facebook.com/v21.0';

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

const TOKEN = String(process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
const PHONE_ID = String(process.env.PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
const WABA_ID = String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WABA_ID || '').trim();
const templateName = String(arg('template', process.env.WA_TEMPLATE || '') || '').trim();
const lang = String(arg('lang', process.env.WA_TEMPLATE_LANG || 'en') || 'en');
const apply = Boolean(arg('apply', false));
const onlyTo = String(arg('to', '') || '').trim();
const params = String(arg('params', '') || '').split('|').map((p) => p.trim()).filter(Boolean);

const digits = (v) => String(v || '').replace(/\D/g, '');
const toMsisdn = (v) => {
  const d = digits(v);
  if (d.startsWith('254') && d.length >= 12) return d;
  if (d.startsWith('0') && d.length === 10) return '254' + d.slice(1);
  if (d.length === 9) return '254' + d;
  return d;
};

function missingCredentials() {
  const missing = [];
  if (!TOKEN) missing.push('WHATSAPP_TOKEN');
  if (!PHONE_ID) missing.push('PHONE_NUMBER_ID');
  return missing;
}

async function graph(path, init = {}) {
  const res = await fetch(GRAPH + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(25000)
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const missing = missingCredentials();
if (missing.length) {
  console.log('\n-- WhatsApp send · not configured on this machine ---');
  console.log('   Missing: ' + missing.join(', '));
  console.log('\n   Those two values live in the Render service environment (they are what the');
  console.log('   bot itself uses). Copy them into this project\'s .env, then re-run.');
  console.log('\n   Without them nothing can be sent: the tenant table holds no usable token');
  console.log('   (Kassangas is a 19-character placeholder; every other tenant is empty), and');
  console.log('   guessing a credential is not an option.\n');
  process.exit(2);
}


// ---- who am I, and what may I send -------------------------------------------
const me = await graph(`/${PHONE_ID}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`);
if (me.status !== 200) {
  console.log('\nThe credential does not answer for PHONE_NUMBER_ID=' + PHONE_ID + ':');
  console.log('   ' + (me.body.error?.message || 'HTTP ' + me.status));
  console.log('   Check the id belongs to the same app as the token.\n');
  process.exit(2);
}
console.log('\n-- WhatsApp send · ' + (me.body.verified_name || '(unnamed)') + ' ---');
console.log('   number      ' + (me.body.display_phone_number || '?'));
console.log('   quality     ' + (me.body.quality_rating || 'unknown')
  + '   verification ' + (me.body.code_verification_status || 'unknown'));

let waba = WABA_ID;
if (!waba) {
  const lookup = await graph(`/${PHONE_ID}?fields=whatsapp_business_account_id`);
  waba = String(lookup.body.whatsapp_business_account_id || '').trim();
}

let templates = [];
if (waba) {
  const list = await graph(`/${waba}/message_templates?fields=name,status,language,components&limit=100`);
  templates = list.body.data || [];
  const approved = templates.filter((t) => String(t.status).toUpperCase() === 'APPROVED');
  console.log('   templates   ' + approved.length + ' approved of ' + templates.length
    + (list.body.error ? ' (could not read: ' + list.body.error.message + ')' : ''));
  templates = approved;
} else {
  console.log('   templates   unknown — set WHATSAPP_BUSINESS_ACCOUNT_ID to check');
}

const chosen = templateName
  ? templates.find((t) => t.name === templateName)
  : templates[0];

if (!chosen) {
  console.log('\nNOTHING CAN BE SENT YET — and this is the reason, not a code gap:');
  console.log('   Meta allows free-form text only within 24h of the recipient\'s last message.');
  console.log('   These tenants last wrote months ago, so a text send would come back 131047');
  console.log('   and count against the quality rating above.');
  console.log('\n   Create one template (WhatsApp Manager → Message templates, category Marketing):');
  console.log('     Hi {{1}}, Saddy from Alphadome. {{2}} workspace is live — the link below');
  console.log('     signs you in, no password to copy: {{3}}');
  console.log('     The system is KES 1,000 a month (new clients KES 3,000). I am not invoicing');
  console.log('     until your catalogue is loaded and one order has gone through end to end.');
  console.log('     Reply "catalogue" and I will load it. What the fee covers: {{4}}');
  console.log('   Then:  node scripts/whatsapp_send.mjs --template <name> --apply\n');
  process.exit(3);
}

// ---- who gets it --------------------------------------------------------------
const { url, key } = await import('../utils/supabaseEnv.js').then((m) => m.requireSupabaseEnv());
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(url, key);
const { data: tenants, error } = await sb
  .from('bot_tenants')
  .select('client_name, client_phone, point_of_contact_name, portal_token, is_active, status');
if (error) {
  console.log('\nCannot read bot_tenants: ' + error.message + '\n');
  process.exit(1);
}

const recipients = (tenants || [])
  .filter((t) => t.is_active !== false && String(t.status || 'active') === 'active')
  .filter((t) => !onlyTo || digits(t.client_phone).includes(digits(onlyTo)))
  .map((t) => ({ name: t.point_of_contact_name || t.client_name, business: t.client_name, phone: toMsisdn(t.client_phone), portal: t.portal_token }))
  .filter((t) => t.phone);

if (!recipients.length) {
  console.log('\nNo recipient matches' + (onlyTo ? ' "' + onlyTo + '"' : '') + '.\n');
  process.exit(1);
}

console.log('\n   recipients  ' + recipients.length + (apply ? '' : '   (dry run — nothing is sent)'));

const site = String(process.env.SITE_URL || 'https://alphadome.onrender.com').replace(/\/+$/, '');
const offerUrl = site + '/founders-package.html';
const { firstName } = await import('../utils/founderOffer.js');

/**
 * The parameters a template body takes, per person.
 *
 * A campaign that sends the same three words to twelve people is spam; these are the
 * values that make each message about that business — their name, their business, their
 * own sign-in link, and the page that prices it.
 */
const paramsFor = (person) => (params.length ? params : [
  firstName(person.name),
  person.business || 'your',
  person.portal ? `${site}/tenant-dashboard?t=${encodeURIComponent(person.portal)}&phone=${encodeURIComponent(person.phone)}` : site + '/founders-package.html',
  offerUrl
]);

const send = async (to, body) => graph(`/${PHONE_ID}/messages`, {
  method: 'POST',
  body: JSON.stringify(body)
});

let sent = 0;
const failed = [];
for (const person of recipients) {
  const personParams = paramsFor(person);
  const body = {
    messaging_product: 'whatsapp',
    to: person.phone,
    type: 'template',
    template: {
      name: chosen.name,
      language: { code: chosen.language || lang },
      components: [{
        type: 'body',
        parameters: personParams.map((p) => ({ type: 'text', text: String(p) }))
      }]
    }
  };
  if (!apply) {
    console.log('   would send  ' + person.phone + '  ' + person.name + '  [' + personParams.join(' | ') + ']');
    continue;
  }
  const res = await send(person.phone, body);
  const id = res.body.messages?.[0]?.id || null;
  if (res.status === 200 && id) {
    sent += 1;
    console.log('   SENT       ' + person.phone + '  ' + person.name + '  (' + id + ')');
  } else {
    const msg = res.body.error?.message || ('HTTP ' + res.status);
    const code = res.body.error?.code || '';
    failed.push({ phone: person.phone, code, msg });
    console.log('   FAILED     ' + person.phone + '  ' + person.name + '  ' + (code ? '[' + code + '] ' : '') + msg);
  }
  // Meta rate-limits per second; a burst of twelve is fine, but a slower loop keeps the
  // quality rating's error rate honest and gives a readable log.
  await new Promise((r) => setTimeout(r, 400));
}

if (!apply) {
  console.log('\nDry run. Nothing sent. Re-run with --apply to deliver this template.\n');
  console.log('Note: a template\'s text is fixed by Meta, so the per-tenant wording in');
  console.log('utils/founderOffer.js is what goes in the template body, with the name,');
  console.log('business and portal link as parameters.\n');
  process.exit(0);
}

console.log('\n   sent ' + sent + ' of ' + recipients.length + (failed.length ? ', ' + failed.length + ' failed' : ''));
for (const f of failed) console.log('   - ' + f.phone + ' [' + f.code + '] ' + f.msg);
console.log('\n   Portal links used in messages come from bot_tenants.portal_token — a tenant');
console.log('   without one gets a message with no link (see npm run tenants:campaign).\n');
process.exit(failed.length ? 1 : 0);


console.log('   template    ' + chosen.name + ' (' + chosen.language + ')');
if (params.length) console.log('   params      ' + params.join(' | '));
