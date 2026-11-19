/**
 * The assistant's two new brains, checked (2026-11-19):
 * `utils/platformDossier.js` (what Alphadome is, read live) and `utils/wfOutreach.js`
 * (outreach as a conversation with a brake).
 *
 * Run: node scripts/test_assistant_context.mjs
 */
import { buildPlatformDossier, MAX_PLATFORM_CHARS } from '../utils/platformDossier.js';
import {
  detectOutreach, parseIndustries, parseTarget, renderOutreach,
  describeOutreachPlan, isApproval, isCancel, WF_MAX_TARGET, WF_DEFAULT_TARGET
} from '../utils/wfOutreach.js';
import { FOUNDERS_PACKAGE } from '../utils/founderOffer.js';

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

console.log('\n-- what Alphadome is: read, not remembered');
const live = buildPlatformDossier({
  products: {
    count: 2,
    items: [
      { title: 'The AI Work Application Kit', price: 1500 },
      { title: 'Alphadome Build Log 2026', price: 2500 }
    ]
  },
  tenants: { active: 12 },
  discovery: { count: 14 },
  pages: { published: 997 },
  offers: { published: 351 },
  packsSold: { count: 0 }
});
ok('both prices come from one source', live.text.includes('1,000') && live.text.includes('3,000'),
  String(FOUNDERS_PACKAGE.founderPrice) + '/' + FOUNDERS_PACKAGE.standardPrice);
ok('the packs are named with their prices', /AI Work Application Kit \(KES 1,500\)/.test(live.text), live.text);
ok('what is running is counted', /12 active tenant\(s\)/.test(live.text) && /997 published page/.test(live.text));
ok('the links are given', /\/drops/.test(live.text) && /\/build/.test(live.text) && /\/discovery/.test(live.text));
ok('the model is told not to recite the block', /Do not recite this block/i.test(live.text));
ok('and not to invent a price', /never invent a price/i.test(live.text));

ok('an unreadable catalogue says so instead of quoting a price',
  /unknown \(catalogue could not be read\)/.test(buildPlatformDossier({}).text));
ok('an empty catalogue says not to offer one',
  /catalogue is empty — do not offer one/.test(buildPlatformDossier({ products: { count: 0, items: [] } }).text));

const huge = buildPlatformDossier({
  products: { count: 5, items: Array.from({ length: 5 }, () => ({ title: 'X'.repeat(600), price: 1 })) },
  pages: { published: 9 }
});
ok('the platform block is capped', huge.text.length <= MAX_PLATFORM_CHARS + 1, String(huge.text.length));

console.log('\n-- outreach is recognised, and only by real intent');
ok('"run outreach" is intent', detectOutreach('run outreach for my hotel leads'));
ok('"start a campaign" is intent', detectOutreach('start a campaign please'));
ok("writer's flow counts", detectOutreach("use writer's flow"));
ok('"find leads" counts', detectOutreach('find leads in Mombasa'));
ok('a greeting is not intent', !detectOutreach('hello there'));

console.log('\n-- the conversation, stage by stage');
let turn = renderOutreach({ state: null, text: 'run outreach', tenantName: 'Malingu Ventures' });
ok('the first reply asks what to look for, and refuses to start', turn.action === 'ask'
  && /will not start one from a single word/i.test(turn.reply));
ok('it promises approval before anything happens', /nothing is sent until you approve/i.test(turn.reply));

turn = renderOutreach({ state: turn.state, text: 'hotels in Nairobi that host conferences', tenantName: 'Malingu Ventures' });
ok('the goal is captured', turn.state.keywords[0].startsWith('hotels in Nairobi'));
ok('it then asks for industries', /Which industries/.test(turn.reply));

turn = renderOutreach({ state: turn.state, text: 'hospitality, events and travel' });
ok('industries are parsed', turn.state.industries.length === 3, JSON.stringify(turn.state.industries));
ok('it then asks how many', /How many leads/.test(turn.reply));

turn = renderOutreach({ state: turn.state, text: '15' });
ok('the count is captured', turn.state.target === 15);
ok('and it states the plan instead of running', turn.action === 'ask' && /Here is exactly what will happen/.test(turn.reply));
ok('the plan names the draft', /draft, nothing else/i.test(turn.reply));
ok('the plan says nothing is sent', /are \*not\* sent by this step/.test(turn.reply), turn.reply);
ok('the plan asks for YES', /Reply \*YES\*/.test(turn.reply));

const approved = renderOutreach({ state: turn.state, text: 'yes' });
ok('approval produces the create action', approved.action === 'create');
ok('the created reply says nothing was sent', /Nothing has been sent/.test(approved.reply));
ok('and points at the portal to press Run', /press Run/i.test(approved.reply));

console.log('\n-- the brake holds');
ok('a non-answer at the plan stage does not create',
  renderOutreach({ state: { ...turn.state }, text: 'what do you think?' }).action === 'ask');
ok('"no" cancels and clears the state', (() => {
  const c = renderOutreach({ state: turn.state, text: 'no' });
  return c.action === 'cancel' && c.state.stage === null && /nothing was created/i.test(c.reply);
})());
ok('a one-word goal is refused rather than guessed', renderOutreach({
  state: { stage: 'goal', keywords: [], industries: [], target: WF_DEFAULT_TARGET }, text: 'hotels'
}).state.stage === 'goal');

console.log('\n-- numbers are clamped, never exceeded');
ok('the target cannot exceed the runner maximum', parseTarget('500') === WF_MAX_TARGET, String(parseTarget('500')));
ok('a target of zero becomes one', parseTarget('0') === 1);
ok('no number is null, not a guess', parseTarget('a few') === null);
ok('the plan clamps too',
  describeOutreachPlan({ keywords: ['x'], industries: [], target: 500 }, { maxTarget: 25 }).includes('*25 leads*'));

console.log('\n-- approvals and cancellations are read conservatively');
for (const yes of ['yes', 'Yep', 'ok', 'go ahead', 'confirm', 'do it']) ok('"' + yes + '" approves', isApproval(yes));
for (const no of ['no', 'stop', 'cancel', 'not now', 'later']) ok('"' + no + '" cancels', isCancel(no));
ok('a question is neither', !isApproval('what is this?') && !isCancel('what is this?'));

console.log('\n-- industries parse the way people type');
ok('commas', parseIndustries('retail, logistics').join('|') === 'retail|logistics');
ok('"and"', parseIndustries('hotels and lodges').join('|') === 'hotels|lodges');
ok('"any" means no filter', parseIndustries('any').length === 0);
ok('junk is dropped', parseIndustries('ab,,  ,cd').join('|') === 'ab|cd', JSON.stringify(parseIndustries('ab,,  ,cd')));
ok('single characters are not industries', parseIndustries('a,b').length === 0);

if (failures.length) {
  for (const failure of failures) console.error('FAIL ' + failure);
}
console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

ok('a product question is not intent', !detectOutreach('how much is the guitar?'));
