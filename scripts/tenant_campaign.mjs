/**
 * The tenant campaign (2026-11-19)
 *
 * Builds, per active tenant, the five messages of the founder's-package campaign and a
 * `wa.me` hand-off for each — so the founder sends them from his own WhatsApp, which is
 * the only channel that works for an acquaintance without a Meta template approval.
 *
 *   node scripts/tenant_campaign.mjs                    # every tenant, every step
 *   node scripts/tenant_campaign.mjs --step activation  # what to send today
 *   node scripts/tenant_campaign.mjs --tenant 254713... # one tenant
 *   node scripts/tenant_campaign.mjs --csv > campaign.csv
 *
 * Read-only: it reads tenants and catalogues, prints messages and links. It never sends
 * a message and never writes a row. Sending is a person pressing a link that already
 * carries the text.
 *
 * Why a hand-off and not the bot: a free-form WhatsApp message outside the 24-hour
 * customer-service window fails, and 10,212 failed sends are already in this database
 * (`docs/WHATSAPP_INTENT_AUDIT_2026-11-12.md`). A `wa.me` link opened by the founder is
 * a person-to-person message, which is exactly what this conversation is.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { requireSupabaseEnv } from '../utils/supabaseEnv.js';
import { buildWhatsAppInviteLink } from '../utils/discoveryApprovals.js';
import {
  campaignSteps,
  newClientMessage,
  offerLine,
  priceFor,
  firstName,
  FOUNDERS_PACKAGE
} from '../utils/founderOffer.js';

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

const SITE = String(process.env.SITE_URL || 'https://alphadome.onrender.com').replace(/\/+$/, '');
const OFFER_URL = `${SITE}/founders-package.html`;
const stepFilter = arg('step', null);
const tenantFilter = String(arg('tenant', '') || '').toLowerCase();
const asCsv = process.argv.slice(2).includes('--csv');
const asJson = process.argv.slice(2).includes('--json');

const { url, key } = requireSupabaseEnv();
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(url, key);

const problems = [];
async function read(table, select) {
  const { data, error } = await sb.from(table).select(select);
  if (error) {
    problems.push(`${table}: ${error.message}`);
    return [];
  }
  return data || [];
}

const [tenants, products, submissions] = await Promise.all([
  read('bot_tenants', 'id, client_name, client_phone, point_of_contact_name, portal_token, status, is_active'),
  read('bot_products', 'bot_tenant_id'),
  read('discovery_submissions', 'business_name, phone, challenges, status, submitted_at')
]);

const productCount = new Map();
for (const p of products) {
  const id = String(p.bot_tenant_id || '');
  productCount.set(id, (productCount.get(id) || 0) + 1);
}

const channels = new Map();
for (const s of submissions) {
  const digits = String(s.phone || '').replace(/\D/g, '').slice(-9);
  if (digits) channels.set(digits, s);
}

const rows = tenants
  .filter((t) => t.is_active !== false && String(t.status || 'active') === 'active')
  .filter((t) => {
    if (!tenantFilter) return true;
    return String(t.client_phone || '').toLowerCase().includes(tenantFilter)
      || String(t.client_name || '').toLowerCase().includes(tenantFilter);
  })
  .map((t) => {
    const name = t.point_of_contact_name || t.client_name || '';
    const phone = t.client_phone || t.point_of_contact_phone || '';
    const onShelf = productCount.get(String(t.id)) || 0;
    const portalUrl = t.portal_token
      ? `${SITE}/tenant-dashboard?t=${encodeURIComponent(t.portal_token)}&phone=${encodeURIComponent(phone)}`
      : null;
    const context = channels.get(String(phone).replace(/\D/g, '').slice(-9)) || null;
    const steps = campaignSteps({
      contactName: name,
      businessName: t.client_name || '',
      portalUrl: portalUrl || '',
      offerUrl: OFFER_URL,
      existing: true
    }).map((step) => ({
      ...step,
      wa: phone ? buildWhatsAppInviteLink({ phone, message: step.text }) : null
    }));
    return {
      tenant: t.client_name || name,
      contact: name,
      first: firstName(name),
      phone,
      price_kes: priceFor({ existing: true }),
      products: onShelf,
      portal_url: portalUrl,
      asked: context ? context.challenges || '' : '',
      blockers: [
        onShelf === 0 ? 'empty catalogue — nothing to sell' : null,
        !portalUrl ? 'no portal token — issue one before inviting' : null,
        !phone ? 'no phone number' : null
      ].filter(Boolean),
      steps
    };
  })
  .sort((a, b) => a.tenant.localeCompare(b.tenant));

const stepsToShow = (row) => (stepFilter ? row.steps.filter((s) => s.id === String(stepFilter)) : row.steps);

if (asJson) {
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    offer: offerLine({ existing: true }),
    offer_url: OFFER_URL,
    tenants: rows.map((r) => ({ ...r, steps: stepsToShow(r) })),
    problems
  }, null, 2));
  process.exit(0);
}

if (asCsv) {
  // One row per message, because the thing being pasted into a phone is a message.
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  console.log(['tenant', 'contact', 'phone', 'price_kes', 'products', 'day', 'step', 'blockers', 'text', 'wa_link'].join(','));
  for (const row of rows) {
    for (const step of stepsToShow(row)) {
      console.log([
        row.tenant, row.contact, row.phone, row.price_kes, row.products,
        step.day, step.id, row.blockers.join('; '), step.text, step.wa || ''
      ].map(esc).join(','));
    }
  }
  process.exit(0);
}

const htmlPath = arg('html', null);
if (htmlPath) {
  // The send desk: one page, one button per tenant, ordered so the first message is
  // the one with a concrete deliverable. Opening it on a laptop gives WhatsApp Web;
  // on a phone it opens the app. The message sits in a <pre> so Copy is exact — a
  // mistyped link in a first message is worse than no message.
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pin = String(arg('first', '') || '').trim();
  const ordered = [...rows].sort((a, b) => {
    const pinned = (r) => (pin && (r.phone.includes(pin) || r.tenant.toLowerCase().includes(pin.toLowerCase())) ? 0 : 1);
    return pinned(a) - pinned(b) || a.blockers.length - b.blockers.length || a.tenant.localeCompare(b.tenant);
  });

  const cards = ordered.map((row, i) => {
    const step = row.steps.find((s) => s.id === (stepFilter || 'activation')) || row.steps[0];
    const blockers = row.blockers.length ? row.blockers.join(' · ') : 'ready to send';
    return `
  <article class="card${i === 0 ? ' first' : ''}">
    <header>
      <label><input type="checkbox" data-key="sent-${esc(row.phone)}"> <b>${esc(row.tenant)}</b></label>
      <span class="meta">${esc(row.contact)} · ${esc(row.phone || 'no phone')} · ${row.products} product(s)</span>
    </header>
    <p class="blockers">${esc(blockers)}</p>
    <pre id="t-${i}">${esc(step.text)}</pre>
    <div class="actions">
      ${step.wa ? `<a class="open" href="${esc(step.wa)}" target="_blank" rel="noopener">Open in WhatsApp</a>` : '<span class="open disabled">no phone</span>'}
      <button class="copy" data-target="t-${i}" type="button">Copy message</button>
      ${row.portal_url ? `<a class="ghost" href="${esc(row.portal_url)}" target="_blank" rel="noopener">Check their portal</a>` : '<span class="ghost disabled">no portal token</span>'}
    </div>
  </article>`;
  }).join('\n');

  const page = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Send desk · ${esc(offerLine({ existing: true }))}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background:#081421; color:#eef5fb; line-height:1.55; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px 18px 60px; }
  h1 { font-size: 1.35rem; margin: 0 0 6px; }
  .lede { color:#a9bccd; margin: 0 0 18px; font-size: .95rem; }
  .bar { display:flex; gap: 12px; align-items:center; flex-wrap:wrap; margin-bottom: 18px; }
  .count { color:#ffd166; font-weight: 700; }
  .card { background: rgba(12,26,43,.82); border:1px solid #1e3550; border-radius:14px; padding:16px; margin: 14px 0; }
  .card.first { border-color:#ff8a00; box-shadow: 0 0 0 2px rgba(255,138,0,.25); }
  .card.done { opacity:.45; }
  header { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:baseline; }
  header b { font-size:1.05rem; }
  .meta { color:#a9bccd; font-size:.82rem; }
  .blockers { color:#c9b9b9; font-size:.8rem; margin:6px 0 10px; }
  pre { white-space: pre-wrap; background:#0a1725; border:1px solid #1e3550; border-radius:10px;
    padding:12px; font-size:.86rem; margin:0; color:#dfe9f3; }
  .actions { display:flex; gap:10px; margin-top:12px; flex-wrap:wrap; }
  a.open { background:linear-gradient(90deg,#ff8a00,#ffd166); color:#201000; font-weight:700;
    text-decoration:none; padding:9px 16px; border-radius:9px; font-size:.9rem; }
  button.copy { background:#12263c; color:#eef5fb; border:1px solid #2a4767; padding:9px 14px;
    border-radius:9px; font:inherit; font-size:.9rem; cursor:pointer; }
  a.ghost { color:#7ef9c8; font-size:.85rem; align-self:center; text-decoration:none; }
  .disabled { color:#5b7286; }
</style></head><body><div class="wrap">
  <h1>Send desk — ${esc(offerLine({ existing: true }))}</h1>
  <p class="lede">Nothing on this page sends by itself: press <b>Open in WhatsApp</b> and the message is already
    written; press <b>Copy message</b> to paste it yourself. Ticks are kept in this browser only.</p>
  <div class="bar"><span class="count" id="progress">0 / ${ordered.length} sent</span>
    <span class="meta">${pin ? 'Pinned first: ' + esc(pin) + '. Then' : ''} fewest blockers first.</span></div>
  ${cards}
</div>
<script>
  var boxes = Array.prototype.slice.call(document.querySelectorAll('input[type=checkbox]'));
  function refresh() {
    var done = boxes.filter(function (b) { return b.checked; }).length;
    document.getElementById('progress').textContent = done + ' / ' + boxes.length + ' sent';
    boxes.forEach(function (b) { b.closest('.card').classList.toggle('done', b.checked); });
  }
  boxes.forEach(function (b) {
    try { b.checked = localStorage.getItem(b.dataset.key) === '1'; } catch (e) {}
    b.addEventListener('change', function () {
      try { localStorage.setItem(b.dataset.key, b.checked ? '1' : '0'); } catch (e) {}
      refresh();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('button.copy'), function (btn) {
    btn.addEventListener('click', function () {
      var el = document.getElementById(btn.dataset.target);
      var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy message'; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(el.textContent).then(done, function () {
          window.getSelection().selectAllChildren(el);
        });
      } else { window.getSelection().selectAllChildren(el); }
    });
  });
  refresh();
</script></body></html>`;

  fs.writeFileSync(path.resolve(String(htmlPath)), page, 'utf8');
  console.log(`Wrote ${ordered.length} message(s) to ${path.resolve(String(htmlPath))}`);
  console.log('First card: ' + ordered[0].tenant + ' (' + ordered[0].phone + ')');
  console.log('Nothing was sent. Open the file and press the buttons.');
  process.exit(0);
}



console.log(`   ${rows.length} active tenant(s) · ${OFFER_URL}`);
console.log('   Read-only. Send from your own WhatsApp; a bot cannot open this conversation.\n');

for (const row of rows) {
  console.log(`== ${row.tenant}  (${row.contact} · ${row.phone || 'no phone'})`);
  console.log(`   ${row.products} product(s) · ${row.price_kes} KES/month founder's rate`);
  if (row.blockers.length) console.log(`   BLOCKERS: ${row.blockers.join(' · ')}`);
  if (row.asked) console.log(`   asked for: ${row.asked}`);
  if (!row.portal_url) console.log('   portal: no token — POST /admin/api/tenants/:id/portal-link first');
  for (const step of stepsToShow(row)) {
    console.log(`\n   day ${step.day} · ${step.id}`);
    for (const line of step.text.split('\n')) console.log('   | ' + line);
    if (step.wa) console.log(`   OPEN: ${step.wa}`);
  }
  console.log('');
}

// The other half of the campaign: people who are not tenants yet, at the walk-up price.
if (!stepFilter) {
  const notTenants = [];
  const tenantPhones = new Set(rows.map((r) => String(r.phone).replace(/\D/g, '').slice(-9)));
  for (const s of submissions) {
    const digits = String(s.phone || '').replace(/\D/g, '').slice(-9);
    if (!digits || tenantPhones.has(digits) || String(s.status || '') === 'rejected') continue;
    notTenants.push(s);
  }
  if (notTenants.length) {
    console.log(`-- New clients (${FOUNDERS_PACKAGE.standardPrice} KES/month) ---`);
    for (const s of notTenants.slice(0, 5)) {
      const text = newClientMessage({ contactName: s.name || '', businessName: s.business_name || '', offerUrl: OFFER_URL });
      console.log(`\n== ${s.business_name || s.name}  (${s.phone})`);
      for (const line of text.split('\n')) console.log('   | ' + line);
      if (s.phone) console.log(`   OPEN: ${buildWhatsAppInviteLink({ phone: s.phone, message: text })}`);
    }
    console.log('');
  }
}

if (problems.length) {
  console.log('COULD NOT READ');
  for (const p of problems) console.log('   - ' + p);
}
console.log('Next: open the day-0 link for each tenant, then the proof on day 2. The fee is invoiced after a catalogue is loaded.\n');
