#!/usr/bin/env node

/**
 * Offline test for the blog quality layer (2026-10-25):
 *   utils/tenantVoice.js  — one voice per tenant, deterministic and distinct
 *   utils/blogWriter.js   — the editorial brief that replaced one-line prompts
 *   utils/blogQuality.js  — the referee that scores what a draft delivered
 *
 * Production failures this protects against:
 *   1) Every tenant's nine pages were written from the same one-sentence prompt,
 *      so they read as one machine's output ("Write an educational blog post …
 *      HTML format, NO markdown"). Two tenants sounded identical.
 *   2) The result shipped as heading + four bullets, again and again: of 283
 *      published pages, 105 broke a rendering rule and the thin ones held 144
 *      characters of prose.
 *   3) Nothing measured quality, so "9 of 9 generated" was always reported as a
 *      success even when the pages were outlines.
 *
 * Runs entirely in-process — no keys, no database, no network.
 *
 * Usage: npm run test:blog-quality
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */

import chalk from 'chalk';
import { VOICE_PROFILES, listVoiceProfiles, resolveTenantVoice, buildVoicePromptBlock } from '../utils/tenantVoice.js';
import { buildArticlePrompt, buildRepairPrompt, buildReviewPrompt, buildAngleBrief, resolveCta } from '../utils/blogWriter.js';
import { analyzeArticle, qualityBrief, describeQuality, QUALITY_TARGETS } from '../utils/blogQuality.js';
import {
  PLAYBOOKS, playbookFor, conversionBrief, readinessCard,
  weakTitleReason, TITLE_SHAPES, ASK_LADDER,
} from '../utils/conversionPlaybook.js';

const logInfo = (msg) => console.log(chalk.blue(`i ${msg}`));
const logPass = (msg) => console.log(chalk.green(`+ ${msg}`));
const logFail = (msg) => console.log(chalk.red(`x ${msg}`));

const results = [];
function record(status, name, detail = '') {
  results.push({ status, name, detail });
  const line = `${name}${detail ? ' — ' + detail : ''}`;
  if (status === 'PASS') logPass(line);
  else logFail(line);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record('PASS', name, detail || '');
  } catch (e) {
    record('FAIL', name, e.message);
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const words = (s) => String(s || '').split(/\s+/).filter(Boolean).length;


const OFFER = {
  title: 'Kassangas Music Shop',
  slug: 'kassangas-music-shop',
  offer_type: 'service',
  compensation_max: 1500,
  compensation_currency: 'KES',
  location_text: 'Nairobi',
  skills: ['Sound engineering', 'Event planning'],
  description: 'Studio recording, mixing and live sound for artists and events in Nairobi.',
  cta_label: 'Request a quote',
};

const JOB = {
  title: 'ML Engineer',
  slug: 'ml-engineer',
  offer_type: 'job',
  compensation_max: 75,
  compensation_currency: 'USD',
  location_text: 'Remote',
  skills: ['Python', 'PyTorch'],
  description: 'Build and ship production machine learning systems.',
};

// --- voices -----------------------------------------------------------------

await check('ships distinct voice profiles, each with a usable prompt block', async () => {
  assert(VOICE_PROFILES.length >= 6, `expected 6+ profiles, got ${VOICE_PROFILES.length}`);
  const ids = listVoiceProfiles();
  assert(new Set(ids).size === ids.length, `duplicate profile id: ${ids.join(',')}`);
  for (const p of VOICE_PROFILES) {
    for (const field of ['id', 'label', 'essence', 'rhythm', 'lexicon', 'avoid', 'ctaStyle']) {
      assert(p[field] && String(p[field]).length > 10, `${p.id} has no ${field}`);
    }
    assert(p.openers.length >= 3, `${p.id} has fewer than 3 style demonstrations`);
  }
  const block = buildVoicePromptBlock({
    brand: 'Kassangas Music Shop', industry: 'music retail', location: 'Nairobi',
    audience: 'a buyer', voice: VOICE_PROFILES[0],
  });
  assert(/VOICE —/.test(block) && /Rhythm:/.test(block) && /Do not sound like:/.test(block), 'voice block is incomplete');
  return `${ids.length} profiles: ${ids.join(', ')}`;
});

await check('assigns the same tenant the same voice on every call', async () => {
  const a = resolveTenantVoice({ site: { id: 'site-1', slug: 'kassangas', name: 'Kassangas Music Shop' } });
  const b = resolveTenantVoice({ site: { id: 'site-1', slug: 'kassangas', name: 'Kassangas Music Shop' } });
  assert(a.id === b.id, `unstable assignment: ${a.id} vs ${b.id}`);
  assert(a.source === 'derived', `unexpected source: ${a.source}`);
  return `stable at ${a.id}`;
});

await check('different tenants land on different voices', async () => {
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    seen.add(resolveTenantVoice({ site: { id: 'tenant-' + i, name: 'Business ' + i } }).id);
  }
  assert(seen.size >= Math.min(6, VOICE_PROFILES.length),
    `24 tenants produced only ${seen.size} distinct voices`);
  return `${seen.size} distinct voices across 24 tenants`;
});

await check('an explicit tone wins and an unrecognised one is honoured verbatim', async () => {
  const precise = resolveTenantVoice({ site: { id: 'x', brand_voice: 'precise and technical' } });
  assert(precise.id === 'precise-operator', `brand_voice ignored: ${precise.id}`);
  assert(precise.source === 'configured', `source should be configured, got ${precise.source}`);
  const viaBot = resolveTenantVoice({ site: { id: 'y' }, botTemplate: { tone: 'friendly' } });
  assert(viaBot.id === 'warm-neighbourhood-expert', `bot template tone ignored: ${viaBot.id}`);
  const custom = resolveTenantVoice({ site: { id: 'z', tone: 'dry and slightly sarcastic' } });
  assert(custom.source === 'custom', `custom tone not marked: ${custom.source}`);
  assert(/dry and slightly sarcastic/.test(custom.promptBlock), 'custom tone missing from the prompt block');
  return 'configured, bot-template and free-text tones all reach the brief';
});

await check('reads the market and the reader off the offer', async () => {
  const buyer = resolveTenantVoice({ site: { id: 'k', name: 'Kassangas Music Shop' }, offer: OFFER });
  assert(/music retail/.test(buyer.industry), `industry not derived: ${buyer.industry}`);
  assert(/buyer/.test(buyer.audience), `buyer audience wrong: ${buyer.audience}`);
  assert(/Nairobi/.test(buyer.promptBlock), 'location missing from the voice block');
  const candidate = resolveTenantVoice({ site: { id: 'm', name: 'Mercor' }, offer: JOB });
  assert(/career/.test(candidate.audience), `job audience wrong: ${candidate.audience}`);
  return `${buyer.industry} / ${buyer.audience} / ${candidate.audience}`;
});

// --- the brief --------------------------------------------------------------

const VOICE = resolveTenantVoice({ site: { id: 'kassangas', name: 'Kassangas Music Shop' }, offer: OFFER });

await check('the brief carries voice, reader, scene, questions and CTA', async () => {
  const post = { title: 'Kassangas Music Shop: A Complete Guide', angle: 'awareness', stage: 1, angleName: 'Awareness', angleDescription: 'Help readers understand the offer' };
  const prompt = buildArticlePrompt({ offer: OFFER, post, voice: VOICE, siblings: ['Kassangas Music Shop: What It Costs'] });
  const brief = buildAngleBrief(OFFER, post);
  for (const needle of [
    'THE BUSINESS', 'THE READER', 'THIS PAGE', 'SHAPE', 'LENGTH AND RHYTHM', 'BANNED', 'OUTPUT',
    'Kassangas Music Shop', 'KES 1,500', 'Nairobi', 'Request a quote',
    'Request a quote', 'scene', brief.scene.slice(0, 30), 'Complete Guide',
  ]) {
    assert(prompt.includes(needle), `brief is missing "${needle}"`);
  }
  assert(prompt.includes(VOICE.promptBlock), 'brief does not embed the tenant voice block');
  assert(/no <h1>/i.test(prompt), 'brief does not forbid a second h1');
  assert(/Return the article body only/i.test(prompt), 'brief has no output contract');
  assert(prompt.length > 1200, `brief is too thin to change behaviour (${prompt.length} chars)`);
  return `${prompt.length} chars, ${brief.covers.length} required questions`;
});

await check('every one of the nine angles has its own brief, for buyers and for candidates', async () => {
  const angles = ['awareness', 'consideration', 'preparation', 'action', 'mastery'];
  const seen = new Set();
  for (const type of ['service', 'job']) {
    const offer = type === 'job' ? JOB : OFFER;
    for (const angle of angles) {
      for (const stage of [1, 2]) {
        const brief = buildAngleBrief(offer, { angle, stage });
        assert(brief && brief.job && brief.scene && brief.covers.length >= 4,
          `${type} ${angle}:${stage} has an incomplete brief`);
        const key = type + ':' + brief.job;
        assert(!seen.has(key), `${type} ${angle}:${stage} reuses another angle's brief`);
        seen.add(key);
      }
    }
  }
  assert(seen.size === 20, `expected 20 distinct briefs, got ${seen.size}`);
  return `${seen.size} distinct briefs (10 buyer, 10 career)`;
});

await check('job offers get career pages and service offers get buyer pages', async () => {
  const jobPrompt = buildArticlePrompt({ offer: JOB, post: { title: 'ML Engineer Salary Guide', angle: 'awareness', stage: 2 }, voice: resolveTenantVoice({ offer: JOB }) });
  const buyerPrompt = buildArticlePrompt({ offer: OFFER, post: { title: 'Kassangas Music Shop: What It Costs', angle: 'awareness', stage: 2 }, voice: VOICE });
  assert(/career|role|candidate/i.test(jobPrompt), 'job brief does not address a candidate');
  assert(!/Take-home|take-home pay/i.test(buyerPrompt), 'buyer brief leaked career copy');
  assert(/buyer/i.test(buyerPrompt), 'buyer brief does not address a buyer');
  return 'career and buyer briefs stay separate';
});

await check('the call to action resolves from the offer, then the offer type', async () => {
  assert(resolveCta({ cta_label: 'Book a session' }) === 'Book a session', 'cta_label ignored');
  assert(resolveCta({ offer_type: 'course' }) === 'Enrol today', 'course default wrong');
  assert(resolveCta(null) === 'Get in touch', 'brand default wrong');
  return 'cta_label → offer type → brand';
});

await check('the repair prompt names the failures and includes the draft', async () => {
  const draft = '<h2>Cost</h2><ul><li>It depends.</li></ul>';
  const analysis = analyzeArticle(draft);
  const prompt = buildRepairPrompt({ offer: OFFER, post: { title: 'What It Costs', angle: 'awareness', stage: 2 }, voice: VOICE, draft, issues: qualityBrief(analysis) });
  assert(prompt.includes(draft), 'repair prompt omits the draft');
  assert(/WHAT FAILED/.test(prompt) && /THE TARGET/.test(prompt), 'repair prompt has no target');
  assert(/thin-article|few-paragraphs|list-heavy/.test(prompt), 'repair prompt does not name the measured failures');
  assert(/Request a quote/.test(prompt), 'repair prompt lost the CTA');
  return 'repair brief carries issues, target and draft';
});

await check('the review prompt polishes in the tenant voice without changing facts', async () => {
  const prompt = buildReviewPrompt({ offer: OFFER, post: { title: 'What It Costs' }, voice: VOICE, content: '<p>Some copy.</p>', issues: '' });
  assert(/without changing any fact/i.test(prompt), 'review prompt may change facts');
  assert(prompt.includes(VOICE.promptBlock), 'review prompt lost the voice');
  assert(/<p>Some copy\.<\/p>/.test(prompt), 'review prompt lost the article');
  return 'voice-aware polish prompt';
});

// --- the referee -----------------------------------------------------------

// The shape the old prompts produced: headings, bullets, nothing that reads like
// writing. This is the page that must never again be reported as a success.
const OUTLINE = `
<h2>Kassangas Music Shop</h2>
<ul><li>Recording</li><li>Mixing</li><li>Mastering</li><li>Live sound</li></ul>
<h2>Benefits</h2>
<ul><li>Fast turnaround</li><li>Fair price</li><li>Experienced team</li></ul>
<h2>Why choose us</h2>
<ul><li>Quality</li><li>Reliability</li><li>Value</li></ul>
`;

await check('an outline scores as a failure and names why', async () => {
  const a = analyzeArticle(OUTLINE);
  assert(!a.ok, `outline was accepted (${a.summary})`);
  assert(a.score < 55, `outline scored ${a.score}, expected under 55`);
  const codes = a.issues.map((i) => i.code);
  assert(codes.includes('thin-article'), `missing thin-article: ${codes.join(',')}`);
  assert(codes.includes('list-heavy') || codes.includes('bullet-sections'), `missing list signal: ${codes.join(',')}`);
  assert(a.critical.length > 0, 'outline produced no blocking issue');
  return a.summary;
});

await check('cliché and filler are detected as named issues', async () => {
  const a = analyzeArticle('<h2>Why it matters</h2><p>In today\'s fast-paced world, it is important to note that we delve into seamless solutions. In conclusion, this is a game-changer.</p>');
  const codes = a.issues.map((i) => i.code);
  assert(codes.includes('cliche'), `cliché not detected: ${codes.join(',')}`);
  const phrases = a.issues.filter((i) => i.code === 'cliche').map((i) => i.detail).join(' | ');
  assert(/fast-paced|delve|seamless/.test(phrases), `cliché detail is unhelpful: ${phrases}`);
  return phrases.split(' | ').length + ' banned phrases named';
});

// A page that meets the house standard. Synthetic, but shaped exactly like the
// copy the brief asks for: prose paragraphs, a scene, numbers, one list, a CTA.
const PROSE = `
<h2>The quote that stops making sense</h2>
<p>The phone rings at 7:40 on a Monday and the caller wants a figure for a three-song session before lunch. You give a number, they go quiet, and twenty minutes later a cheaper quote arrives from a studio two streets away. The gap between the two numbers is rarely the hourly rate. It is almost always the list of things one studio included and the other left for later, written down nowhere, agreed by nobody.</p>
<p>This guide settles one decision: how to compare two quotes for studio time when neither document explains itself. By the end you will have a short set of questions that make the numbers comparable, and you will know which answers should end the conversation.</p>
<h2>What actually moves the price</h2>
<p>Four things do most of the work. The first is how many hours the room is booked for, which sounds obvious until you see that one quote covers a four hour block and the other covers eight. The second is who does the editing, because a session that ends at the desk is cheaper than one that ends at a finished master, and the difference is often two full working days.</p>
<p>The third is the gear you actually use, not the gear on the website. A vintage console in the photographs costs money whether or not your session touches it, and you should ask directly what the rate includes. The fourth is the date. A Friday evening in December is not priced like a Tuesday morning in March, and a studio that quotes a flat rate has already decided who absorbs that difference.</p>
<h2>A worked comparison</h2>
<p>Take two quotes at KES 1,500 per hour and KES 2,200 per hour. On an eight hour session the second is 5,600 shillings more, which is the point where most buyers stop reading. Now add the mixing day the cheaper quote excludes at 4,000 shillings, the two revision rounds the other studio includes, and the transfer fee nobody mentioned until delivery. The gap narrows to under a thousand shillings and the cheaper quote is the one that asks more of your time.</p>
<ul>
<li>Ask every studio for the same three lines: hours in the room, hours after the room, and revisions included.</li>
<li>Get the delivery date in writing, including who signs off the final master.</li>
<li>Confirm what happens if the session runs long, and at what rate.</li>
<li>Ask whether the price changes for a weekend or a public holiday.</li>
</ul>
<h2>Negotiating without losing the room</h2>
<p>There is room to negotiate, and it is almost never on the hourly rate. Ask for a second revision round instead of a discount, because revisions cost the studio time it has already scheduled and the rate is the number it uses to compare you with every other client. If the budget genuinely will not stretch, cut a song rather than an hour, since half a session produces a worse file than one finished track and you will pay twice for the same room.</p>
<p>Trade scope for time when you can. A session booked for a Tuesday morning often costs less than the same session on a Saturday, and a delivery two weeks out costs less than one demanded in three days. Those are real savings that do not touch the quality of the work, and a studio will usually offer them if you ask before the booking is confirmed rather than after.</p>
<h2>What this is not</h2>
<p>A comparison sheet does not tell you which room sounds better, and it will not protect you from a studio that simply does not deliver. It also does not replace listening to previous work, which takes fifteen minutes and tells you more than any document. If a studio refuses to put scope in writing, the price is not the problem and a discount will not fix it.</p>
<h2>The first conversation</h2>
<p>Bring the three numbers you already know: how many songs, how many hours you can afford in the room, and the date you need the finished file. Ask for the same three lines from every studio you contact and keep the answers side by side. When you have them, request a quote from us and we will price the same scope line by line, so the comparison you make is the comparison we both agree on.</p>
`;

await check('a prose page clears the gate', async () => {
  const a = analyzeArticle(PROSE);
  assert(a.ok, `prose page rejected: ${a.summary} :: ${qualityBrief(a)}`);
  assert(a.score >= 80, `prose page scored only ${a.score}`);
  assert(a.words >= QUALITY_TARGETS.minWords, `fixture is too short (${a.words} words) to prove the floor`);
  assert(a.listOnlySections <= QUALITY_TARGETS.maxListOnlySections, 'fixture has too many bullet sections');
  assert(a.cta, 'fixture has no CTA');
  return a.summary;
});

await check('the gate is deterministic, so a score can be trusted in a log', async () => {
  const a = analyzeArticle(PROSE);
  const b = analyzeArticle(PROSE);
  assert(a.score === b.score && a.words === b.words, 'two runs of the same HTML disagreed');
  assert(/\/100/.test(describeQuality(a)), 'describeQuality is not a score line');
  return describeQuality(a);
});

// --- conversion playbook (2026-10-29) ---------------------------------------
// The corpus was well written and still lost the click. These checks pin the
// two measurements that explain it: Mercor completed 22 of 159 started
// applications, and on LinkedIn every command-shaped title died.

await check('every offer type has its own playbook, not a buyer template', async () => {
  const types = Object.keys(PLAYBOOKS);
  assert(types.length === 6, `expected 6 offer types, got ${types.length}: ${types.join(',')}`);
  for (const t of types) {
    const p = playbookFor({ offer_type: t });
    assert(p.type === t, `${t} resolved to ${p.type}`);
    for (const field of ['reader', 'decision', 'blocker', 'objection', 'askEarly', 'askMid', 'askClose']) {
      assert(p[field] && String(p[field]).length > 20, `${t} has no usable ${field}`);
    }
    assert(p.proof.length >= 3, `${t} lists ${p.proof.length} proofs`);
    assert(p.readiness.length >= 3, `${t} lists ${p.readiness.length} readiness items`);
    assert(p.afterClick.length >= 3, `${t} lists ${p.afterClick.length} after-click steps`);
  }
  const unknown = playbookFor({ offer_type: 'nonsense' });
  assert(unknown.type === 'service', `unknown type did not fall back to service: ${unknown.type}`);
  return `${types.length} types, each with readiness and an after-click sequence`;
});

await check('the job brief pre-answers the application, not the job advert', async () => {
  const brief = conversionBrief({ offer_type: 'job' }, { price: 'USD 75' });
  assert(/Before you apply/.test(brief), 'no readiness section for jobs');
  assert(/CV saved as a PDF/.test(brief), 'the CV requirement is not named');
  assert(/assessment/.test(brief), 'the assessment step is not named — 159 started, 22 finished');
  assert(/ASK LADDER/.test(brief), 'no ask ladder');
  assert(/USD 75/.test(brief), 'the listed figure is not pushed into the first paragraph');
  const buyer = conversionBrief({ offer_type: 'service' }, { price: 'KES 1,500' });
  assert(!/CV saved as a PDF/.test(buyer), 'the service brief inherited the candidate readiness list');
  assert(/Before you get in touch/.test(buyer), 'service readiness heading missing: ' + buyer.slice(0, 200));
  return 'job readiness list + ask ladder present; service list stays separate';
});

await check('the briefs now carry the conversion job into the prompt', async () => {
  const post = { title: 'ML Engineer pay: what $75/hr means after tax and hours', angle: 'awareness', stage: 2, angleName: 'Awareness', angleDescription: 'Help readers understand the offer' };
  const voice = resolveTenantVoice({ site: { id: 'mercor', name: 'Mercor' }, offer: JOB });
  const prompt = buildArticlePrompt({ offer: JOB, post, voice });
  for (const needle of ['THE CONVERSION JOB', 'ASK LADDER', 'Before you apply', 'Mid-page ask', 'First 100 words']) {
    assert(prompt.includes(needle), `prompt is missing "${needle}"`);
  }
  assert(/\$75|USD 75/.test(prompt), 'the rate is not in the brief');
  const repair = buildRepairPrompt({ offer: JOB, post, voice, draft: '<p>x</p>', issues: '- thin' });
  assert(/THE CONVERSION JOB/.test(repair), 'repair prompt dropped the conversion commission');
  assert(/mid-page ask/i.test(repair), 'repair prompt does not ask for a mid-page ask');
  return `${prompt.length} chars incl. ask ladder`;
});

await check('titles that died on LinkedIn are rejected by name', async () => {
  const dead = [
    'Unlock Your Future as a Defense Analyst',
    'Master the Defense Analyst Assessment With These Tips',
    'Ready to Work as a Remote Defense Analyst?',
    'Discover How PhD LifeScience Researchers Work',
    'What is a Chief of Staff? A Complete Guide for 2026',
    'Apply Now!',
  ];
  for (const t of dead) assert(weakTitleReason(t), `accepted a losing title: ${t}`);
  const alive = [
    'The day-to-day life of a Physics PhD coding expert',
    'Is $150/hr really what a senior software engineer earns?',
    'What the Chief of Staff application asks for, before you start it',
    'What Kassangas Music Shop costs in Nairobi',
  ];
  for (const t of alive) assert(!weakTitleReason(t), `rejected a working title: ${t} (${weakTitleReason(t)})`);
  assert(Object.keys(TITLE_SHAPES).length === 6, 'title shapes do not cover every offer type');
  assert(ASK_LADDER.length === 3, 'the ask ladder is not three rungs');
  return '6 losing patterns rejected, 4 working shapes accepted';
});

await check('a job page with no readiness section is named, not passed', async () => {
  const job = analyzeArticle(PROSE, { offerType: 'job', title: 'Unlock Your Future as a Defense Analyst' });
  const jobCodes = job.issues.map((i) => i.code);
  assert(jobCodes.includes('no-readiness'), 'a job page without "Before you apply" passed: ' + jobCodes.join(','));
  assert(jobCodes.includes('weak-title'), 'the weak title was not flagged: ' + jobCodes.join(','));
  assert(job.conversion.readinessHeading === false, 'readinessHeading should be false');
  // The check adapts to the offer type instead of accepting any "Before you …".
  const asService = analyzeArticle(PROSE, { offerType: 'service' });
  const svcIssue = asService.issues.find((i) => i.code === 'no-readiness');
  assert(svcIssue, 'a service page without a readiness section was passed');
  assert(/Before you get in touch/.test(svcIssue.detail), 'service detail asked for the wrong verb: ' + svcIssue.detail);
  const withHeading = analyzeArticle('<h2>Before you get in touch</h2><p>Send the scope and the date you need it finished.</p>' + PROSE, { offerType: 'service' });
  assert(!withHeading.issues.some((i) => i.code === 'no-readiness'), 'a page with the right heading still failed');
  return 'job: no-readiness + weak-title; service: verb-specific heading accepted';
});

await check('one ask at the bottom is not enough', async () => {
  const line = 'The studio diary decides the rate, so a Tuesday morning session costs less than the same room on a Saturday afternoon.';
  const mid = [0, 1, 2, 3].map((i) => `<p>${line} This is point ${i + 1} of the same argument about timing and price.</p>`).join('');
  const tail = [5, 6, 7].map((i) => `<p>${line} It follows that the quote for session ${i} should list the same three lines.</p>`).join('');
  const html = `<h2>The room</h2>${mid}<h2>The price</h2>${tail}<p>Send us the song count and the date, and we will quote KES 1,500 against that scope line by line.</p>`;
  const a = analyzeArticle(html, { offerType: 'service' });
  assert(a.conversion.midAsk === false, 'a page with one closing ask reported a mid-page ask');
  assert(a.issues.map((i) => i.code).includes('no-mid-ask'), 'no-mid-ask was not raised: ' + a.issues.map((i) => i.code).join(','));
  return `midAsk=${a.conversion.midAsk}, firstPerson=${a.conversion.firstPerson}`;
});

await check('a repeated paragraph blocks the page', async () => {
  const para = 'You have compared, assessed and prepared, and the next step is the application form itself. It asks for a CV, your availability and the rate you will accept, and it takes about twenty minutes to finish.';
  const a = analyzeArticle(`<p>${para}</p><p>${para}</p>` + PROSE, { offerType: 'job' });
  assert(a.conversion.duplicateParagraphs >= 1, 'the repeated paragraph was not counted');
  assert(a.critical.includes('duplicate-paragraph'), 'a repeated paragraph did not block: ' + a.critical.join(','));
  return `${a.conversion.duplicateParagraphs} duplicate(s) blocking`;
});

await check('the readiness card lists what the reader needs before the click', async () => {
  const card = readinessCard({ offer_type: 'job' });
  assert(/<h3>Before you apply<\/h3>/.test(card), 'no heading: ' + card.slice(0, 60));
  assert((card.match(/<li>/g) || []).length >= 5, 'fewer than five readiness items');
  assert(/CV/.test(card), 'the CV line is missing from the card');
  assert(/rate/.test(card), 'the rate line is missing from the card');
  const shop = readinessCard({ offer_type: 'product' });
  assert(/Before you order/.test(shop), 'product card heading wrong: ' + shop.slice(0, 60));
  return `${(card.match(/<li>/g) || []).length} items on the job card`;
});

const failed = results.filter((r) => r.status === 'FAIL');
logInfo(`${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);

