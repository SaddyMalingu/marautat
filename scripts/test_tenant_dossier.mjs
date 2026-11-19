/**
 * The tenant dossier, checked (2026-11-19).
 *
 * The rules that matter, and each is a test below:
 *
 *   - only the owner's phone is recognised (a customer must never see the numbers);
 *   - "unknown" is not "0" — a table we could not read must not be reported as an empty
 *     business, because the bot would then tell an owner their shop has never sold;
 *   - an empty catalogue or zero orders produces a next action, not an apology;
 *   - the block is bounded, so it cannot crowd out the conversation in the prompt.
 *
 * Run: node scripts/test_tenant_dossier.mjs
 */
import { buildDossier, isOwnerPhone, MAX_BLOCK_CHARS } from '../utils/tenantDossier.js';

let pass = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log('PASS  ' + name);
  } else {
    failures.push(name + (extra ? ' — ' + extra : ''));
    console.log('FAIL  ' + name + (extra ? ' — ' + extra : ''));
  }
};

console.log('\n-- who counts as the owner');
const tenant = { client_name: 'Spreadmasters ltd', client_phone: '254713793488', point_of_contact_phone: '0713000111' };
ok('the client phone is the owner', isOwnerPhone(tenant, '254713793488'));
ok('the local form matches too', isOwnerPhone(tenant, '0713793488'));
ok('a plus and spaces are ignored', isOwnerPhone(tenant, '+254 713 793 488'));
ok('the named contact is recognised', isOwnerPhone(tenant, '0713000111'));
ok('a customer is not the owner', !isOwnerPhone(tenant, '254700000000'));
ok('no phone is not the owner', !isOwnerPhone(tenant, ''));
ok('no tenant is not the owner', !isOwnerPhone(null, '254713793488'));

console.log('\n-- an empty business says what to do next');
const empty = buildDossier({
  tenant,
  catalogue: { count: 0, active: 0, stock_value: 0, out_of_stock: 0 },
  orders: { count: 0, paid: 0, value: 0, last_at: null },
  campaigns: { count: 0, leads_found: 0, outreach_sent: 0 },
  posts: { published: 0 },
  now: '2026-11-19T12:00:00Z'
});
ok('it names the business', empty.text.includes('Spreadmasters ltd'));
ok('it says the catalogue is empty', /Catalogue: EMPTY/.test(empty.text));
ok('it says no orders exist', /Orders: none recorded/.test(empty.text));
ok('it does not apologise, it offers the next action', /Next actions you may offer:/.test(empty.text));
ok('the next action names the price-list format', /Omo 1kg \| 320 \| 12/.test(empty.text));
ok('the gaps are returned for logging', empty.gaps.length >= 2);
ok('a tenant with no line is told so instead of "unknown"', /no dedicated line configured/.test(empty.text));
ok('…and connecting the line is the first next action', empty.gaps.some((g) => /connect the business WhatsApp number/.test(g)));

console.log('\n-- a trading business reads as numbers');
const trading = buildDossier({
  tenant: { ...tenant, whatsapp_phone_number_id: '868405499681303' },
  catalogue: { count: 24, active: 22, stock_value: 1263000, out_of_stock: 3, top: 'Electric Guitar (KES 23,500)' },
  orders: { count: 9, paid: 7, value: 84500, last_at: '2026-11-18T10:00:00Z' },
  conversations: { total: 1284, inbound: 640, last_7d: 12, last_at: '2026-11-19T09:00:00Z' },
  campaigns: { count: 2, leads_found: 41, outreach_sent: 38, last_run_at: '2026-11-16T10:00:00Z' },
  leads: { count: 41, qualified: 12 },
  posts: { published: 3, newest_at: '2026-11-10T10:00:00Z' },
  now: '2026-11-19T12:00:00Z'
});
ok('the catalogue is counted and valued', /22 active product\(s\), KES 1,263,000/.test(trading.text), trading.text);
ok('out-of-stock is named', /3 out of stock/.test(trading.text));
ok('orders carry a value', /9 recorded, KES 84,500/.test(trading.text));
ok('paid is stated when it differs', /7 marked paid/.test(trading.text));
ok('the last order is relative, not a date', /last 1 day\(s\) ago/.test(trading.text));
ok('WhatsApp activity is summarised', /1,284 message\(s\) stored, 640 from customers/.test(trading.text), trading.text);
ok("Writer's Flow reports leads and outreach", /2 campaign\(s\), 41 lead\(s\) found, 38 outreach/.test(trading.text), trading.text);
ok('content is counted', /3 published page\(s\)/.test(trading.text));
ok('a healthy business gets no invented next action', trading.gaps.length === 0);

console.log('\n-- what could not be read is not a zero');
const unreadable = buildDossier({
  tenant: { ...tenant, whatsapp_phone_number_id: '868405499681303' },
  catalogue: null,
  orders: null,
  campaigns: null,
  posts: { published: 0 },
  now: '2026-11-19T12:00:00Z'
});
ok('catalogue reports unknown, never 0', /Catalogue: unknown/.test(unreadable.text));
ok('orders report unknown, never 0', /Orders: unknown/.test(unreadable.text));
ok("Writer's Flow reports unknown, never 0", /Writer's Flow: unknown/.test(unreadable.text));
ok('an unreadable table does not invent a gap either', unreadable.gaps.length === 0, JSON.stringify(unreadable.gaps));

console.log('\n-- the block stays inside the prompt budget');
const huge = buildDossier({
  tenant: { client_name: 'A'.repeat(900) },
  catalogue: { count: 500, active: 500, stock_value: 9e9, out_of_stock: 0, top: 'X'.repeat(900) },
  orders: { count: 999, paid: 998, value: 9e9, last_at: '2026-11-19T00:00:00Z' },
  conversations: { total: 999999, inbound: 999998, last_7d: 99999, last_at: '2026-11-19T00:00:00Z' },
  campaigns: { count: 99, leads_found: 9999, outreach_sent: 9999, last_run_at: '2026-11-19T00:00:00Z' },
  leads: { count: 9999, qualified: 9999 },
  posts: { published: 9999, newest_at: '2026-11-19T00:00:00Z' },
  now: '2026-11-19T12:00:00Z'
});
ok('the block is capped', huge.text.length <= MAX_BLOCK_CHARS + 1, String(huge.text.length));
ok('and says it was cut', huge.text.endsWith('…'));

console.log('\n-- one tenant never sees another');
const a = buildDossier({ tenant: { client_name: 'Kassangas Music Shop' }, catalogue: { count: 1, active: 1, stock_value: 1 } });
const b = buildDossier({ tenant: { client_name: 'Spreadmasters ltd' }, catalogue: { count: 1, active: 1, stock_value: 1 } });
ok("Kassangas's block does not mention Spreadmasters", !a.text.includes('Spreadmasters'));
ok("Spreadmasters' block does not mention Kassangas", !b.text.includes('Kassangas'));

if (failures.length) {
  for (const failure of failures) console.error('FAIL ' + failure);
}
console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
