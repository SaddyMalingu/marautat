/**
 * What a page has to do to earn the click — per offer type.
 *
 * Why this module exists (2026-10-29). The writer brief was written for one
 * reader: a buyer comparing quotes. When the engine was widened to products,
 * services, brands, affiliates and courses, every category inherited a buyer
 * frame, and a job seeker was handed a page that told them how to *evaluate a
 * supplier*. Two datasets say what that costs:
 *
 *   1) Mercor referrals, rolling window: 26 signed up, 159 applications
 *      started, 22 completed, 4 offers, 3 hired. Started -> completed is 13.8%.
 *      Six of every seven people who wanted the work gave up inside the
 *      application. Nothing in the copy had told them what it would ask for, so
 *      the form was the first time they met the requirements.
 *   2) LinkedIn, 48 articles in 12 months: one situational post ("the shift
 *      towards a digital world") took 88,314 impressions and 679 link clicks
 *      — 88% of all clicks in the dataset. Titles built as commands or promises
 *      ("Unlock your future…", "Master the … assessment", "Ready to work as…")
 *      landed at 0, 13 and 2 impressions. Median of all 48 posts: 91.
 *
 * So this module encodes, per offer type: who is reading, the one decision the
 * page is selling, the thing that stops them, the proof that moves them, what
 * they must have ready before they click, and what happens after they click.
 * `utils/blogWriter.js` turns it into prompt text; `utils/blogQuality.js`
 * measures whether the draft delivered it.
 *
 * Pure data and pure string assembly — no model calls, no IO.
 */

// Shared by every type: the ask is a sequence, not a sentence at the bottom.
// Readers who arrive from search scan the first screen, skim the middle, and
// leave from the last paragraph. A page with one ask at the bottom is a page
// where two of those three exits go nowhere.
export const ASK_LADDER = [
  'first-screen ask: name the offer, the number and the next step inside the first 100 words',
  'mid-page ask: one sentence around the middle that gives the reader permission to stop reading and act',
  'closing ask: the concrete next step plus exactly what to bring, send or have ready',
];

export const PLAYBOOKS = {
  job: {
    label: 'the candidate',
    reader: 'someone who wants this work and is not yet sure they will be taken seriously',
    decision: 'whether to spend twenty minutes applying to this role today',
    // The measured blocker. 159 people started an application against 22
    // completions: the drop is not interest, it is friction discovered late.
    blocker: 'they do not know what the application will demand, so the form is where they find out and quit',
    proof: [
      'the pay as take-home, not as a headline rate',
      'what the work looks like on an ordinary Tuesday',
      'that the requirements are ones they can meet this week',
    ],
    readiness: [
      'your CV saved as a PDF you can upload in one step',
      'two or three work samples, or one sentence on what you cannot share publicly',
      'the hours you can genuinely commit each week, including overlap with the client time zone',
      'the rate you will accept, and the floor below which you walk away',
      'confirmation you can be paid, and can work legally where the client is',
    ],
    afterClick: [
      'the application form, which asks for the CV, your availability and your rate',
      'a short skills assessment, usually timed, taken in one sitting',
      'a matching step where the client sees your profile',
      'an offer, then onboarding paperwork before the first paid task',
    ],
    objection: 'the work is real and the money is real, but nobody explains the middle part — the form and the test',
    askEarly: 'state the rate, the hours and who the role suits in plain words, then say applying takes twenty minutes',
    askMid: 'name the one requirement readers most often fail, and tell them how to fix it before they start',
    askClose: 'tell them to apply now and to have the five things listed ready, so the form takes one pass instead of three',
  },

  service: {
    label: 'the buyer',
    reader: 'someone with a job to get done and two or three quotes to compare',
    decision: 'whether to send this business the scope and ask for a price',
    blocker: 'they cannot tell what the price includes, so every quote looks like a gamble',
    proof: [
      'what is included and what costs extra, line by line',
      'how long delivery actually takes, and what delays it',
      'the first question a good supplier asks and a cheap one skips',
    ],
    readiness: [
      'the outcome in one sentence, with quantities',
      'the date it has to be finished, and what happens if it slips',
      'the site, address or access constraints',
      'a budget range you can defend internally',
      'photos, plans or examples of what you want',
    ],
    afterClick: [
      'a reply with the questions the scope did not answer',
      'a written quote against that scope, with exclusions named',
      'a deposit or booking to hold the date',
      'a delivery date, then the work itself',
    ],
    objection: 'a cheaper quote is not a cheaper job, and the difference is always in the exclusions',
    askEarly: 'name the price or the range, what drives it, and how fast a quote comes back',
    askMid: 'list what to send so the quote is accurate the first time',
    askClose: 'ask for the scope now, and say exactly what to include in the message',
  },

  product: {
    label: 'the shopper',
    reader: 'someone deciding whether this item is the right one and whether to buy it here',
    decision: 'whether to order this item today',
    blocker: 'they cannot confirm it fits, arrives when they need it, or can be returned',
    proof: [
      'the price and exactly what is in the box',
      'delivery time and coverage, stated plainly',
      'the returns position, in one sentence',
    ],
    readiness: [
      'the model, size or compatibility detail of the item you are replacing',
      'the delivery address, with any access notes',
      'whether you need it by a specific date',
    ],
    afterClick: [
      'an order confirmation with the total, including delivery',
      'a dispatch note with a tracking reference',
      'delivery, and a working returns window',
    ],
    objection: 'the item is only right if it fits the thing they already own, and that is the question they came to answer',
    askEarly: 'put the price, the compatibility answer and the delivery line in the first paragraph',
    askMid: 'answer the fit question outright, including who should not buy it',
    askClose: 'tell them to order now and what to have ready — the model number or the size',
  },

  brand: {
    label: 'the local customer',
    reader: 'someone nearby deciding whether to walk in, call, or keep looking',
    decision: 'whether to contact this business today',
    blocker: 'they do not know what the business actually does, where it is, or whether it is still open',
    proof: [
      'what the business does, in one sentence',
      'where it is and when it is open',
      'how a first conversation goes',
    ],
    readiness: [
      'what you need, in one line',
      'when you need it',
      'the best number or address to reply to',
    ],
    afterClick: [
      'a reply the same working day',
      'a short conversation to confirm what is needed',
      'a price or an appointment',
    ],
    objection: 'most people cannot tell two businesses in the same street apart, so the page has to say what makes this one different',
    askEarly: 'say what the business does, where it is and how to reach it in the first paragraph',
    askMid: 'describe the first conversation so the reader knows what contacting costs them',
    askClose: 'invite the call or the visit and give the one detail to mention',
  },

  affiliate: {
    label: 'the deal hunter',
    reader: 'someone comparing this offer against two others and suspicious of hype',
    decision: 'whether to open this offer now',
    blocker: 'every page about this offer sounds like an advert, so they trust none of them',
    proof: [
      'what the offer actually is, at what price',
      'who it suits and who it wastes money on',
      'the catch, named honestly',
    ],
    readiness: [
      'the plan or tier you are comparing',
      'the billing period you want',
      'the one feature you cannot do without',
    ],
    afterClick: [
      'the provider page with the current price',
      'a checkout or trial sign-up',
      'the terms, including cancellation',
    ],
    objection: 'the page that names the catch is the only one the reader believes',
    askEarly: 'state the offer, the price and the catch inside the first paragraph',
    askMid: 'compare it to the obvious alternative, including when the alternative wins',
    askClose: 'send them to the offer and say what to check before paying',
  },

  course: {
    label: 'the learner',
    reader: 'someone who wants the outcome and is weighing the time and the fee',
    decision: 'whether to enrol on this course now',
    blocker: 'they cannot tell whether they will finish it, or whether it leads anywhere',
    proof: [
      'what they can do at the end that they cannot do now',
      'the weekly time commitment, honestly',
      'what the fee includes and what it does not',
    ],
    readiness: [
      'the outcome you want, in one sentence',
      'the hours a week you can protect',
      'the start date you are aiming for',
      'the device and connection you will learn on',
    ],
    afterClick: [
      'enrolment and payment',
      'a welcome message with the first session and the schedule',
      'the first assignment, marked with feedback',
      'a certificate or portfolio piece at the end',
    ],
    objection: 'most people who start a course do not finish it, so the page has to be honest about the weekly cost in hours',
    askEarly: 'name the outcome, the fee and the weekly hours in the first paragraph',
    askMid: 'describe the week that usually breaks people, and how to survive it',
    askClose: 'invite them to enrol and tell them the date the next cohort starts',
  },
};

const KNOWN = Object.keys(PLAYBOOKS);

/** The playbook for an offer type, defaulting to `service` for unknown types. */
export function playbookFor(offer) {
  const type = String((offer && offer.offer_type) || 'service').toLowerCase();
  const key = KNOWN.includes(type) ? type : 'service';
  return Object.assign({ type: key }, PLAYBOOKS[key]);
}

/**
 * Title patterns that measurably lose. Kept as data so the writer, the gate and
 * `utils/contentJourney.js` all agree on one list.
 *
 * Evidence: LinkedIn articles 2025-10 to 2026-10. "Unlock your future as a
 * defense analyst" reached 16 members. "Master the defense analyst assessment"
 * reached 6. "Ready to work as a remote defense analyst" reached 1. The posts
 * that travelled were situational ("the shift towards a digital world", 59,563
 * members reached; "the day-to-day life of a physics PhD coding expert", 3,726).
 */
export const WEAK_TITLE_PATTERNS = [
  { re: /^\s*unlock\b/i, why: '"Unlock" titles read as an advert (16 members reached on the live test)' },
  { re: /^\s*master(?:ing)?\b/i, why: '"Master …" titles read as a course pitch (6 members reached)' },
  { re: /^\s*ready to\b/i, why: '"Ready to …" titles are a command, not a situation (1 member reached)' },
  { re: /^\s*discover\b/i, why: '"Discover" buries the subject behind the verb' },
  { re: /^\s*(?:ultimate|essential)\s+guide\b/i, why: 'a generic guide promise; nobody searches for it' },
  { re: /\b(?:19|20)\d{2}\s*$/i, why: 'a trailing year is filler that dates the page' },
  { re: /!\s*$/, why: 'an exclamation mark on a commercial page reads as spam' },
];

/** True when a title uses one of the losing patterns above. */
export function weakTitleReason(title) {
  const t = String(title || '');
  for (const p of WEAK_TITLE_PATTERNS) if (p.re.test(t)) return p.why;
  return '';
}

/**
 * Titles that earn the click, by offer type. The rule behind all of them: name
 * a situation the reader is already in, or a number they already care about.
 * Never a promise, never a command, never a year.
 */
export const TITLE_SHAPES = {
  job: [
    'What a <role> actually does all day',
    'The day-to-day reality of <role> work',
    '<role> pay: what $<rate>/hr means after tax and hours',
    'Is $<rate>/hr good money for <role>?',
    'What the <role> application asks for, before you start it',
  ],
  service: [
    'What <service> costs in <place>, and what moves the price',
    'How to compare two <service> quotes without getting burned',
    'What to send a <service> supplier so the first quote is right',
  ],
  product: [
    'Is <product> the right fit for what you already own?',
    'What <product> costs, what is in the box, and what it will not do',
    'Buying <product> in <place>: delivery, price and returns',
  ],
  brand: [
    'What <business> does, where to find it, and what a first visit is like',
    'Inside <business>: who it is for and what it costs',
  ],
  affiliate: [
    'Is <offer> worth it? Price, the catch, and who should skip it',
    '<offer> compared: what you get, what you pay, what to check first',
  ],
  course: [
    'What <course> teaches you, in how many weeks, for how much',
    'Is <course> worth the fee? What you can do at the end',
  ],
};

/**
 * The conversion commission, as prompt lines. This is the part the old
 * one-line prompts never had: an ask ladder, the blocker, the readiness list,
 * and the after-click sequence.
 */
export function conversionBrief(offer, facts) {
  const p = playbookFor(offer);
  const price = (facts && facts.price) || null;
  const verb = p.type === 'job' ? 'apply' : p.type === 'product' ? 'order'
    : p.type === 'course' ? 'enrol' : p.type === 'affiliate' ? 'click' : 'get in touch';
  const lines = [];
  lines.push('- Reader: ' + p.reader + '.');
  lines.push('- The one decision this page sells: ' + p.decision + '.');
  lines.push('- Why they hesitate: ' + p.blocker + '. Answer it in the body, not in the closing paragraph.');
  lines.push('- Proof they need before they will act: ' + p.proof.join('; ') + '.');
  lines.push('- ASK LADDER — all three must appear:');
  lines.push('    1. ' + p.askEarly + '.');
  lines.push('    2. ' + p.askMid + '.');
  lines.push('    3. ' + p.askClose + '.');
  lines.push('- Objection to answer out loud: ' + p.objection + '.');
  lines.push('- Required section, head it "Before you ' + verb + '": one short prose paragraph, then a list of exactly these, addressed to the reader as "you": ' + p.readiness.join('; ') + '.');
  lines.push('- Required section: what happens after they act, in order, in prose — ' + p.afterClick.join(' then ') + '.');
  if (price) lines.push('- The listed figure (' + price + ') belongs in the first paragraph, not at the bottom.');
  return lines.join('\n');
}

/**
 * Deterministic readiness card for the page template. The model is asked to
 * write this section too, so the reader meets it twice: once in prose, once as
 * a scannable list directly above the button. This block targets the measured
 * 86% of applications that are started and abandoned.
 */
export function readinessCard(offer, opts) {
  const p = playbookFor(offer);
  const verb = p.type === 'job' ? 'apply' : p.type === 'product' ? 'order'
    : p.type === 'course' ? 'enrol' : 'get in touch';
  const heading = (opts && opts.heading) || ('Before you ' + verb);
  const items = p.readiness
    .map((r) => '<li>' + String(r).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>')
    .join('');
  return '<h3>' + heading + '</h3><ul>' + items + '</ul>';
}

/** One-line description of the ask, for logs and the admin console. */
export function describePlaybook(offer) {
  const p = playbookFor(offer);
  return p.type + ': ' + p.decision;
}

