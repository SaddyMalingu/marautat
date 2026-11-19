/**
 * The GTM playbook, checked (2026-11-19).
 *
 * The rules that make outreach something a business can survive sending:
 *   - an observation is only used if it was actually found;
 *   - one ask per message, three touches, then stop;
 *   - no income promise;
 *   - a lead with no channel is not a lead;
 *   - the same business is never queued twice.
 *
 * Run: node scripts/test_gtm_playbook.mjs
 */
import {
  SEGMENTS, segmentOf, observations, scoreLead, suppressionKey,
  buildSequence, buildPlan, isContactable, MAX_TOUCHES
} from '../utils/gtmPlaybook.js';

let pass = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { failures.push(name + (extra ? ' — ' + extra : '')); console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
};

console.log('\n-- segments');
ok('six segments are defined', Object.keys(SEGMENTS).length === 6, Object.keys(SEGMENTS).join(','));
ok('each carries a pain, an offer and a proof',
  Object.values(SEGMENTS).every((s) => s.pain && s.offer && s.proof && s.queries.length));
ok('an unknown segment is null, not a guess', segmentOf('astronauts') === null);

console.log('\n-- observations come from facts');
ok('a WhatsApp button with no checkout is the observation',
  observations({ has_whatsapp_link: true, has_checkout: false })[0].includes('WhatsApp button'));
ok('a site that already takes payment is not told it cannot',
  !observations({ has_whatsapp_link: true, has_checkout: true }).some((o) => /no way to pay/.test(o)));
ok('nothing found means no observation', observations({}).length === 0);

console.log('\n-- scoring says why');
const strong = scoreLead({ email: 'a@b.co', phone: '254700111222', has_whatsapp_link: true, has_checkout: false, segment: 'tour_operators' }, 'tour_operators');
ok('a contactable, on-segment business scores high', strong.score >= 80, String(strong.score));
ok('every point has a reason', strong.reasons.length >= 4, JSON.stringify(strong.reasons));
ok('a lead with no channel scores low', scoreLead({ org: 'x', segment: 'tour_operators' }, 'tour_operators').score <= 25);
ok('an opt-out scores zero', scoreLead({ email: 'a@b.co', opt_out: true }, 'tour_operators').score === 0);

console.log('\n-- suppression');
ok('a domain is the key when there is one',
  suppressionKey({ website: 'https://www.Example.co.ke/contact' }) === 'domain:example.co.ke');
ok('email when there is no site', suppressionKey({ email: 'A@B.co' }) === 'email:a@b.co');
ok('last nine digits for a phone', suppressionKey({ phone: '254700111222' }) === 'phone:700111222');

console.log('\n-- the sequence');
const lead = {
  org: 'Nairobi Safari Walks', website: 'https://nairobisafariwalks.example', contact_name: 'Grace Wanjiru',
  email: 'info@example.co.ke', has_whatsapp_link: true, has_checkout: false, segment: 'tour_operators'
};
const seq = buildSequence(lead, 'tour_operators');
ok('three touches, never more', seq.touches.length === MAX_TOUCHES);
ok('they are spaced, not blasted', seq.touches.map((t) => t.day).join(',') === '0,3,8');
ok('the first names the real observation', /WhatsApp button/.test(seq.touches[0].body));
ok('the first greets the named person', seq.touches[0].body.startsWith('Hi Grace,'));
ok('the first asks one question', (seq.touches[0].body.match(/\?/g) || []).length === 1, seq.touches[0].body);
ok('the last one closes the loop', /will not keep writing/i.test(seq.touches[2].body));
ok('there is a WhatsApp version without line breaks', !seq.whatsapp_open.includes('\n'));
ok('no income is promised anywhere', !/guaranteed|you will earn|double your|risk[- ]free/i.test(
  seq.touches.map((t) => t.body).join('\n') + seq.whatsapp_open));

console.log('\n-- the plan');
const leads = [
  lead,
  { ...lead, org: 'Same Domain Again' },
  { org: 'No Channel Ltd', segment: 'tour_operators' },
  { org: 'Opted Out Ltd', email: 'x@y.z', opt_out: true },
  { org: 'Blocked Ltd', website: 'https://blocked.example', email: 'b@blocked.example' }
];
const plan = buildPlan(leads, 'tour_operators', { limit: 10, suppress: ['domain:blocked.example'] });
ok('the duplicate domain is dropped', plan.total === 1, String(plan.total));
ok('a lead with no channel never appears', !plan.rows.some((r) => r.org === 'No Channel Ltd'));
ok('an opt-out never appears', !plan.rows.some((r) => r.org === 'Opted Out Ltd'));
ok('a suppressed domain never appears', !plan.rows.some((r) => r.org === 'Blocked Ltd'));
ok('each row carries its sequence', plan.rows.every((r) => r.sequence.touches.length === MAX_TOUCHES));
ok('the plan is ordered by score', plan.rows.every((r, i, a) => i === 0 || a[i - 1].score >= r.score));
ok('the limit is respected', buildPlan(Array.from({ length: 40 }, (_, i) => ({
  org: 'Co ' + i, email: 'a' + i + '@b.co', segment: 'tour_operators'
})), 'tour_operators', { limit: 5 }).rows.length === 5);
ok('contactability is the gate', isContactable({ email: 'a@b.co' }) && !isContactable({ org: 'x' }));

if (failures.length) {
  for (const failure of failures) console.error('FAIL ' + failure);
}
console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
