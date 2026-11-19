/**
 * The founder's-package copy, checked (2026-11-19).
 *
 * The rules this file exists to enforce:
 *
 *   - the price quoted to an existing tenant is the founder's rate, never the walk-up one;
 *   - no message promises income, a hire or a ranking (a friend who is promised $450 and
 *     is not hired is a lost friend);
 *   - the invoice is deferred until a catalogue exists, and the copy says so;
 *   - the agent lane always leaves submission to the human;
 *   - the proof figure is attributed, not asserted.
 *
 * Run: node scripts/test_founder_offer.mjs   (exit 0 = all passed)
 */
import {
  FOUNDERS_PACKAGE,
  activationMessage,
  agentMessage,
  campaignSteps,
  firstName,
  followUpMessage,
  newClientMessage,
  offerLine,
  priceFor,
  proofMessage
} from '../utils/founderOffer.js';

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

console.log('\n-- the price');
ok("the founder's rate is 1,000", FOUNDERS_PACKAGE.founderPrice === 1000);
ok('the walk-up rate is 3,000', FOUNDERS_PACKAGE.standardPrice === 3000);
ok("an existing tenant is quoted the founder's rate", priceFor({ existing: true }) === 1000);
ok('a new client is quoted the walk-up rate', priceFor({ existing: false }) === 3000);
ok("an unset flag defaults to the founder's rate, not the walk-up one", priceFor({}) === 1000);
ok('the offer line names both prices', /1,000/.test(offerLine({ existing: true }))
  && /3,000/.test(offerLine({ existing: true })), offerLine({ existing: true }));

console.log('\n-- names');
ok('a first name is used', firstName('Francis Kiarie') === 'Francis');
ok('one word is a name', firstName('Canary') === 'Canary');
ok('nothing becomes "there"', firstName('') === 'there' && firstName(null) === 'there');
ok('a single character is not a name', firstName(' M ') === 'there');

console.log('\n-- the activation message');
const activation = activationMessage({
  contactName: 'Francis Kiarie',
  businessName: 'Spreadmasters ltd',
  portalUrl: 'https://x.test/tenant-dashboard?t=abc',
  offerUrl: 'https://x.test/founders-package.html'
});
ok('it greets the person by name', activation.startsWith('Hi Francis'));
ok('it names the business', activation.includes('Spreadmasters ltd'));
ok('it carries the portal link', activation.includes('https://x.test/tenant-dashboard?t=abc'));
ok("it quotes the founder's rate", activation.includes('KES 1,000'));
ok('it names the walk-up rate once', (activation.match(/KES 3,000/g) || []).length === 1);
ok('it defers the invoice until a catalogue exists', /not invoicing you until/i.test(activation));
ok('it asks for the catalogue as the one action', /Reply "catalogue"/.test(activation));
ok('it links the offer page', activation.includes('https://x.test/founders-package.html'));

const noLink = activationMessage({ contactName: 'Dawn', businessName: 'Coach Dawn 3.0' });
ok('without a portal token it does not promise a link below', !/link below/i.test(noLink));
ok('without a portal token it says the link comes separately', /separately/i.test(noLink));

console.log('\n-- the proof message');
const proof = proofMessage({ contactName: 'Marvin', offerUrl: 'https://x.test/founders-package.html' });
ok('it names the Mercor figure', /USD 566/.test(proof));
ok('it attributes the figure to our own ledger', /our own ledger/i.test(proof));
ok('it says the figure is not a forecast', /not a projection/i.test(proof));
ok('it carries the offer link', proof.includes('https://x.test/founders-package.html'));

console.log('\n-- the agent message');
const agent = agentMessage({ contactName: 'Purity' });
ok('it names the marketplace rate as advertised, not as a promise', /advertised around USD 450/i.test(agent));
ok('the human presses submit', /you press submit/i.test(agent));
ok("it says nothing is submitted on the tenant's behalf", /Nothing is submitted on your behalf/i.test(agent));

console.log('\n-- no message promises income');
const everything = [
  activation,
  proof,
  agent,
  followUpMessage({ step: 1, contactName: 'A' }),
  followUpMessage({ step: 2, contactName: 'A' }),
  newClientMessage({ contactName: 'B', businessName: 'B Ltd', offerUrl: 'https://x.test/f' })
];
const promise = /guarantee[sd]? (?:you|income|sales|hires)|\byou will earn\b|guaranteed income|risk[- ]free|double your/i;
for (const [i, text] of everything.entries()) {
  ok(`message ${i + 1} makes no income promise`, !promise.test(text));
}
ok('no message claims a hire is certain', !/will be hired|you will get the role/i.test(everything.join('\n')));

console.log('\n-- the new-client message');
const walkUp = newClientMessage({ contactName: 'Tekla', businessName: 'Sales and marketing', offerUrl: 'https://x.test/f' });
ok('it quotes the walk-up price', walkUp.includes('KES 3,000'));
ok("it mentions the founder's rate as closed", /list is closed/i.test(walkUp));
ok('it closes with a demo, not a discount', /one order through end to end/i.test(walkUp));

console.log('\n-- the sequence');
const steps = campaignSteps({ contactName: 'George', businessName: 'Malingu Global', portalUrl: 'https://x.test/p' });
ok('five steps', steps.length === 5);
ok('they are in day order', steps.map((s) => s.day).join(',') === '0,2,4,7,12', steps.map((s) => s.day).join(','));
ok('each step has an id and text', steps.every((s) => s.id && s.text.length > 40));
ok('the first step is the activation', steps[0].id === 'activation');
ok('the last step closes the loop', /last one from me/i.test(steps[4].text));

console.log('\n-- the page the links point at');
const fs = await import('fs');
const path = await import('path');
const { fileURLToPath } = await import('url');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(root, 'public/founders-package.html'), 'utf8');
ok('the page exists and is a document', /^<!DOCTYPE html>/i.test(page.trim()));
ok('the page shows both prices', page.includes('KES 1,000') && page.includes('KES 3,000'));
ok('the page names what is included', /WhatsApp sales line/.test(page) && /M-Pesa collection/.test(page));
ok('the page refuses to guarantee income', /Guaranteed sales, hires or income/.test(page));
ok('the page carries the Mercor figure as its own ledger', /USD 566/.test(page) && /not a projection/i.test(page));
ok('the page sends the agent lane to a human', /human always presses submit/i.test(page));

if (failures.length) {
  for (const failure of failures) console.error('FAIL ' + failure);
}
console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
