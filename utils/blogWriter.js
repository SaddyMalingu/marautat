/**
 * The article brief.
 *
 * The journey (`utils/contentJourney.js`) decides *what* each page is for. This
 * module decides *how* the page is written, and that is where the published
 * corpus was weakest: every prompt was one sentence ending in "HTML with
 * h2,h3,p,ul,li", so models answered with an outline — heading, four bullets,
 * heading, four bullets. Nine pages of that per offer, on 283 live pages.
 *
 * A brief here is an editorial commission: the reader, the search intent, the
 * scene to open on, the sections that must exist, the shape of the prose, one
 * worked example, one honest limitation section, one call to action, and the
 * phrases that mark machine copy. `utils/blogQuality.js` then checks the draft
 * actually delivered it, and `buildRepairPrompt()` sends the failures back.
 *
 * Pure text assembly — no model calls, no IO — so the brief is testable offline.
 */
import { FRAGMENT_ONLY } from './articleHtml.js';
import { conversionBrief, playbookFor, weakTitleReason } from './conversionPlaybook.js';

export const FALLBACK_CTA = {
  job: 'Apply now',
  product: 'Order now',
  service: 'Request a quote',
  brand: 'Get in touch',
  affiliate: 'See the offer',
  course: 'Enrol today',
};

const TYPE_LABEL = {
  job: 'role',
  product: 'product',
  service: 'service',
  brand: 'business',
  affiliate: 'offer',
  course: 'course',
};

function esc(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

export function resolveCta(offer) {
  if (!offer) return FALLBACK_CTA.brand;
  return esc(offer.cta_label) || FALLBACK_CTA[offer.offer_type] || FALLBACK_CTA.brand;
}

export function offerFacts(offer) {
  if (!offer) {
    return { type: 'brand', price: null, currency: 'KES', place: '', skills: [], title: 'this business', description: '' };
  }
  const raw = offer.compensation_max;
  const n = raw == null || raw === '' ? null : Number(raw);
  const price = n != null && isFinite(n)
    ? (esc(offer.compensation_currency) || 'KES') + ' ' + n.toLocaleString('en-KE')
    : (raw ? esc(raw) : null);
  return {
    type: esc(offer.offer_type) || 'job',
    price,
    currency: esc(offer.compensation_currency) || 'KES',
    place: esc(offer.location_text),
    skills: Array.isArray(offer.skills) ? offer.skills.map(esc).filter(Boolean) : [],
    title: esc(offer.title) || 'this business',
    description: esc(offer.description),
  };
}


// One brief per journey angle and stage. `covers` are the questions the page
// must answer; `scene` is the concrete opening the voice can dramatise; `avoid`
// names the failure mode that page falls into.
const BUYER_BRIEFS = {
  'awareness:1': {
    job: 'Explain what this actually is, in the reader\'s language, before any selling.',
    scene: 'a reader mid-conversation with a supplier, trying to work out what the quote covers',
    covers: [
      'what the reader is buying, in one plain paragraph',
      'how the work usually runs from first enquiry to delivery',
      'who it suits and who it does not',
      'what is normally included and what is normally extra',
      'the first question that separates a good supplier from a cheap one',
    ],
    avoid: 'do not pitch; do not list features; do not claim results',
  },
  'awareness:2': {
    job: 'Explain what drives the price and how to compare two quotes honestly.',
    scene: 'two quotes for the same job, far apart, with no explanation of the difference',
    covers: [
      'the four or five things that actually move the price',
      'why a lower headline figure can cost more by month three',
      'how to compare quotes on identical scope, line by line',
      'which exclusions to ask about before signing',
      'how to negotiate without trading away quality',
    ],
    avoid: 'never invent market prices; use the listed price as a starting anchor only',
  },
  'consideration:1': {
    job: 'Give the reader an honest readiness test, including when to wait.',
    scene: 'a reader who has budget but is not sure the timing is right',
    covers: [
      'a readiness checklist they can score themselves',
      'the situation where this is the right spend',
      'the situation where it is not, and what to do instead',
      'the three misconceptions that waste the most money',
      'what changes in the first month after committing',
    ],
    avoid: 'do not make every answer a yes; a page that sells to everyone convinces no one',
  },
  'consideration:2': {
    job: 'Show the reader how to judge competing proposals without being swayed by the presentation.',
    scene: 'three proposals, all confident, all different, and no shared basis for comparison',
    covers: [
      'the criteria to agree internally before reading any proposal',
      'how to compare scope line by line instead of on the total',
      'the questions that reveal how a supplier handles problems',
      'the warning signs hidden in a polished document',
      'how to record the decision so it survives a change of staff',
    ],
    avoid: 'do not turn the page into a template dump; explain why each criterion earns its place',
  },
  'preparation:1': {
    job: 'Give the reader a seven-day plan for everything to settle before they make contact.',
    scene: 'a buyer with a deadline, a rough idea, and no written scope',
    covers: [
      'the five decisions to make before the first conversation',
      'how to set a budget range you can defend',
      'the timeline constraints worth stating, and the ones that are just wishes',
      'the evidence to gather so the first quote is accurate',
      'the mistakes that send a project back to the start',
    ],
    avoid: 'do not pad the plan with generic productivity advice; every day must move the decision',
  },
  'preparation:2': {
    job: 'Show the reader how to write a brief that produces comparable, accurate quotes.',
    scene: 'a one-paragraph brief that came back as three incompatible quotes',
    covers: [
      'how to state the outcome in one sentence a supplier can price',
      'what to include about scope, quantities and site conditions',
      'the attachments that remove the guesswork',
      'how to ask for the same breakdown from every supplier',
      'how to review a delivery against the brief you wrote',
    ],
    avoid: 'do not reproduce a form; explain the consequence of leaving each item out',
  },
  'action:1': {
    job: 'Tell the reader exactly what happens after they say yes, step by step.',
    scene: 'the week after the deposit clears, when expectations are set or lost',
    covers: [
      'what happens between committing and the first delivery',
      'who does what, and who signs off',
      'the first checkpoint and what it should prove',
      'the three things that most often delay a start',
      'what to do in the first 48 hours if something feels wrong',
    ],
    avoid: 'no delivery dates the business has not published',
  },
  'action:2': {
    job: 'Show how to take a working engagement to a second site, team or season without breaking it.',
    scene: 'a second branch quietly inheriting the first branch\'s assumptions',
    covers: [
      'what to standardise before adding a second site',
      'the order to roll out in, and why order matters',
      'what reliably breaks when scope multiplies',
      'how to compare results against the original baseline',
      'the reporting that keeps multiple sites honest',
    ],
    avoid: 'do not imply multi-site capacity the offer does not state',
  },
  'mastery:1': {
    job: 'Explain how to get compounding value in the first year, quarter by quarter.',
    scene: 'a twelve-month review where the only question is whether the spend paid for itself',
    covers: [
      'quarterly milestones for the first year',
      'the handful of metrics worth tracking, and the ones that flatter',
      'how to handle the scope changes that always appear',
      'when to renegotiate, and with what evidence',
      'the signal that it is time to change supplier',
    ],
    avoid: 'no invented percentages; describe what to measure, not what it will be',
  },
  'mastery:2': {
    job: 'Give the reader a twelve-month plan for getting more out of the relationship each quarter.',
    scene: 'a renewal conversation where nobody can point to what improved',
    covers: [
      'what to review at each quarter, and with whom',
      'the two or three measures that show whether it is working',
      'how to price and approve a scope change without restarting the relationship',
      'the signs that the engagement has gone stale',
      'how to renegotiate with evidence instead of opinion',
    ],
    avoid: 'no promises about savings or returns; describe the review discipline instead',
  },
};

export function buildAngleBrief(offer, post) {
  const type = (offer && offer.offer_type) || 'job';
  const stage = (post && post.stage) || 1;
  const angle = (post && post.angle) || 'awareness';
  const table = type === 'job' ? JOB_BRIEFS : BUYER_BRIEFS;
  const brief = table[angle + ':' + stage] || table[angle + ':1'] || BUYER_BRIEFS['awareness:1'];
  return Object.assign({ key: angle + ':' + stage, table: type === 'job' ? 'career' : 'buyer' }, brief);
}

// Phrases the quality gate also rejects. Repeated here so the first draft can
// avoid them instead of paying for a repair pass.
const BANNED_PHRASES = [
  'in today\'s fast-paced world', 'in the ever-evolving landscape', 'delve into',
  'unlock your potential', 'game-changer', 'seamless', 'cutting-edge',
  'it\'s important to note', 'in conclusion', 'whether you\'re a ... or a ...',
  'navigate the complexities', 'we\'re excited to announce',
];

function shapeRules(post, facts, cta) {
  const buyer = facts.type !== 'job';
  return [
    'SHAPE — follow this, it is the difference between an article and an outline',
    '1. Open with two to four sentences of a concrete scene or a blunt claim. Never open with a definition, never with the title restated, never with a cliché.',
    '2. Second paragraph: one or two sentences naming the decision this article settles for the reader.',
    '3. Five or six <h2> sections, in the order below. Each section opens with at least one full paragraph of two to four sentences BEFORE any list. A list must explain or extend prose that is already there — it never replaces it.',
    '4. At most three lists in the entire article, three to five items each, and every item a full sentence carrying a specific detail, not a two-word label.',
    '5. Include one worked example built from real numbers: ' +
      (facts.price ? 'the listed price (' + facts.price + ')' : 'an explicitly labelled illustrative calculation') +
      ', plus timelines, quantities or percentages that you show your arithmetic for. Label any estimate as an estimate.',
    '6. Include one honest section on what this is not, who it does not suit, or what can go wrong. ' +
      (buyer ? 'A buyer trusts a page that names the downside.' : 'A candidate trusts a page that names the downside.'),
    '7. Close with one paragraph of two to three sentences that uses the call to action "' + cta +
      '" and says exactly what the reader should bring or do next. No "conclusion" heading.',
    '8. Optional <h3> sub-headings inside a section, at most one per section. No tables of contents, no "Introduction"/"Conclusion" headings.',
    // Rules 9-12 exist because the measured failure was not style but
    // conversion: 88% of the legacy corpus put the only ask in the final
    // paragraph, and Mercor lost 86% of started applications at the form.
    '9. First 100 words: name what is on offer' + (facts.price ? ', the figure (' + facts.price + ')' : '') +
      ' and the next step. The scene sets the mood in sentence one; the reader must know what this page is selling before the second paragraph ends.',
    '10. Mid-page ask: at the start of section four, one sentence that gives the reader permission to stop reading — it says what happens if they act now and what to have ready. It must not be the closing paragraph repeated.',
    '11. Answer the hesitation named in THE CONVERSION JOB inside the body. A page that only sells at the end convinces nobody who is skimming.',
    '12. Never invent the middle of the journey: no invented application steps, assessment format, delivery promise, guarantee or processing time. Describe what the reader should ask for instead.',
  ].join('\n');
}

function factsBlock(facts) {
  const lines = [
    '- Business: ' + facts.title,
    '- What is on offer: a ' + (TYPE_LABEL[facts.type] || facts.type),
  ];
  if (facts.price) lines.push('- Listed price: ' + facts.price + ' (state it as a starting point, not a fixed quote)');
  if (facts.place) lines.push('- Location / market: ' + facts.place);
  if (facts.description) lines.push('- The business describes it as: ' + facts.description);
  if (facts.skills.length) lines.push('- Capabilities on record: ' + facts.skills.join(', '));
  lines.push('- Call to action wording to use: "' + facts.cta + '"');
  lines.push('- FACT RULE: the only facts you may state are the ones above and the general knowledge in this brief. ' +
    'Never invent a client name, testimonial, award, partner, statistic, guarantee, delivery date or price. ' +
    'When a number is unknown, say what the reader should ask for in writing instead of inventing one.');
  return lines.join('\n');
}
// Career copy for `offer_type=job` (the legacy Mercor catalog). Same shape,
// a different reader: the candidate, not the buyer.
const JOB_BRIEFS = {
  'awareness:1': {
    job: 'Explain what the role actually does all day, and who thrives in it.',
    scene: 'a candidate reading the job title for the fifth time and still unsure what the work looks like',
    covers: [
      'what the role does in a normal week',
      'the part of the job nobody mentions in the advert',
      'which backgrounds move into it successfully',
      'how the role sits next to adjacent titles',
      'the signal that this is the wrong fit',
    ],
    avoid: 'no salary claims before the salary page; no "follow your passion" filler',
  },
  'awareness:2': {
    job: 'Explain how the pay actually works and what moves it up or down.',
    scene: 'two offers with the same title and very different numbers',
    covers: [
      'how the headline figure converts to weekly and monthly take-home',
      'the factors that move pay: seniority, market, contract type',
      'how the listed baseline compares with adjacent roles',
      'what to ask before accepting a number',
      'the negotiation levers that are not money',
    ],
    avoid: 'never present a market average as a fact without a source; use the listed baseline',
  },
  'consideration:1': {
    job: 'Give the candidate a scoring sheet for whether this career fits them.',
    scene: 'someone with the skills but not the temperament, deciding',
    covers: [
      'the skills that can be learned and the traits that cannot',
      'a self-scoring checklist with a decision rule',
      'the misconceptions that cause early exits',
      'the honest downsides of the day-to-day',
      'what to try before committing to the switch',
    ],
    avoid: 'do not flatter the reader into a yes',
  },
  'consideration:2': {
    job: 'Show how to prepare evidence that makes a hiring manager take the application seriously.',
    scene: 'a shortlist where every portfolio looks the same',
    covers: [
      'the three pieces of evidence that outperform a CV',
      'how to build one realistic sample project',
      'how to describe work you cannot show publicly',
      'what interviewers probe after the portfolio',
      'the preparation that takes one evening and changes the outcome',
    ],
    avoid: 'no "just be confident" advice; give concrete actions',
  },
  'action:1': {
    job: 'Walk the reader through getting hired: channels, sequence, and the first 90 days.',
    scene: 'the inbox after twenty applications and two replies',
    covers: [
      'where these roles are actually advertised and filled',
      'the application sequence that gets replies',
      'how to handle a take-home task',
      'what to negotiate before signing',
      'what the first 90 days should look like',
    ],
    avoid: 'no guarantees about hiring outcomes',
  },
  'action:2': {
    job: 'Explain remote work in this role: how it is assessed, and how to prove you can do it.',
    scene: 'a remote interview where the candidate talks about tools instead of outcomes',
    covers: [
      'how remote performance is actually judged',
      'the evidence remote hiring managers ask for',
      'the tools and habits that make remote work visible',
      'how pay and time zones affect the offer',
      'the failure mode of remote candidates in the first quarter',
    ],
    avoid: 'do not claim remote availability the listing does not state',
  },
  'mastery:1': {
    job: 'Map the five-year progression and the skills that unlock each step.',
    scene: 'a competent mid-level practitioner wondering why promotion stalled',
    covers: [
      'what changes between junior, mid and senior work',
      'the skills to build each year',
      'the credentials worth the time and the ones that are not',
      'the pay milestones and what earns them',
      'how the role is likely to change as tooling improves',
    ],
    avoid: 'no invented salary ladders; name what to verify in the market',
  },
  'preparation:1': {
    job: 'Give the candidate a seven-day plan for the assessment stage, with worked examples.',
    scene: 'an assessment invite that arrives on a Friday with no instructions',
    covers: [
      'what these assessments usually test, and what they do not',
      'two sample questions worked through out loud',
      'the study material that is actually worth the hours',
      'the mistakes that fail otherwise strong candidates',
      'a day-by-day plan for the week before',
    ],
    avoid: 'do not reveal or claim to reveal any employer\'s live assessment content',
  },
  'preparation:2': {
    job: 'Show how to build a portfolio that survives a ten-second skim.',
    scene: 'a hiring manager skimming forty portfolios in an evening',
    covers: [
      'the three things a reviewer looks for and the order they look',
      'five project ideas that fit around a full-time job',
      'how to present work you cannot share publicly',
      'the portfolio mistakes that read as junior',
      'how to tailor the same portfolio to a specific role',
    ],
    avoid: 'no invented employers or case studies; use the reader\'s own work',
  },
  'mastery:2': {
    job: 'Explain how to stay valuable as the role and its tooling change.',
    scene: 'a strong practitioner whose toolkit was state of the art two years ago',
    covers: [
      'which parts of the role are being automated and which are not',
      'the skills that compound across employers',
      'how to keep learning without a formal course',
      'the signals that a specialisation is going stale',
      'how to reposition without starting over',
    ],
    avoid: 'no predictions presented as fact; describe how to test the market instead',
  },
};


/**
 * The full commission for one page. Replaces the one-line journey prompt.
 *
 * @param {{offer: object, post: object, voice: object, siblings?: string[]}} input
 * @returns {string}
 */
export function buildArticlePrompt(input) {
  const offer = input.offer || {};
  const post = input.post || {};
  const voice = input.voice || {};
  const siblings = (input.siblings || []).filter(Boolean);
  const facts = offerFacts(offer);
  facts.cta = resolveCta(offer);
  const brief = buildAngleBrief(offer, post);
  const min = facts.type === 'job' ? 900 : 850;
  const max = facts.type === 'job' ? 1300 : 1200;

  const lines = [];
  lines.push('You are the staff writer for ' + (voice.brand || facts.title) + '. Write ONE finished article. ' +
    'It will be published as-is on the business\'s own blog, under the reader\'s search query, so it has to be worth reading and worth acting on.');
  lines.push('');
  lines.push('THE BUSINESS');
  lines.push(factsBlock(facts));
  lines.push('');
  lines.push(voice.promptBlock || 'VOICE: write plainly, in second person, with concrete detail.');
  lines.push('');
  lines.push('THE READER');
  lines.push('A person who searched for "' + (post.title || facts.title) + '". They are ' +
    (voice.audience || 'deciding whether this is worth their money') + '. ' +
    'More precisely, they are ' + playbookFor(offer).reader + '. ' +
    'They will leave in ten seconds if the first paragraph reads like a brochure. They will stay if it names the situation they are already in.');
  lines.push('');
  lines.push('THIS PAGE');
  lines.push('- Title: ' + (post.title || facts.title));
  lines.push('- Journey angle: ' + (post.angleName || post.angle || 'Awareness') +
    ' (stage ' + (post.stage || 1) + ') — ' + (post.angleDescription || ''));
  lines.push('- What this page must do: ' + brief.job);
  lines.push('- Open on this scene: ' + brief.scene + '.');
  lines.push('- It must answer, in roughly this order:');
  for (const c of brief.covers) lines.push('    · ' + c);
  lines.push('- The trap on this page: ' + brief.avoid + '.');
  if (siblings.length) {
    lines.push('- Other pages in this series already cover: ' + siblings.join(' | ') +
      '. Do not repeat their angle; assume the reader may read all of them.');
  }
  lines.push('');
  lines.push(shapeRules(post, facts, facts.cta));
  lines.push('');
  lines.push('THE CONVERSION JOB — why this page exists');
  lines.push(conversionBrief(offer, facts));
  lines.push('- The page is not finished when the reader understands. It is finished when they act.');
  const weak = weakTitleReason(post.title);
  if (weak) {
    lines.push('- Title warning: the assigned title uses a pattern that measurably loses readers (' + weak + '). ' +
      'Do not repeat the title in the body; earn the click with the first sentence instead.');
  }
  lines.push('');
  lines.push('LENGTH AND RHYTHM');
  lines.push('- ' + min + ' to ' + max + ' words of body copy. Meeting the floor matters more than the ceiling: a thin page is the failure mode this brief exists to fix.');
  lines.push('- Vary sentence length on purpose. A short sentence after two long ones is what makes a page readable.');
  lines.push('- Write "you" for the reader and "we" only where the business is genuinely speaking.');
  lines.push('- Prefer concrete nouns and verbs over adjectives. If a sentence would survive on any other business\'s blog, rewrite it.');
  lines.push('');
  lines.push('BANNED');
  lines.push('- A heading followed only by a list. Prose first, always.');
  lines.push('- These phrases: ' + BANNED_PHRASES.join('; ') + '.');
  lines.push('- Emoji, markdown, HTML comments, "As an AI", meta commentary about the article, a table of contents, a "Conclusion" heading.');
  lines.push('- Invented clients, testimonials, awards, partners, statistics, guarantees or delivery dates.');
  lines.push('');
  lines.push('OUTPUT');
  lines.push('Return the article body only, starting with a <p> element and ending with a <p> element.' +
    ' Allowed tags: <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>, <table>, <thead>, <tbody>, <tr>, <th>, <td>.' +
    ' No <h1> — the page template already prints the title.' + FRAGMENT_ONLY);
  return lines.join('\n');
}


/**
 * Editor's second pass. Used when `analyzeArticle()` says the draft did not meet
 * the house standard. The draft is included so the model rewrites rather than
 * inventing a different article.
 */
export function buildRepairPrompt(input) {
  const post = input.post || {};
  const voice = input.voice || {};
  const facts = offerFacts(input.offer);
  facts.cta = resolveCta(input.offer);
  const brief = buildAngleBrief(input.offer, post);
  const issues = input.issues || 'The article reads as an outline rather than an article.';

  return [
    'You are the editor for ' + (voice.brand || facts.title) + '. The draft below failed the house standard for a published article.',
    'Rewrite it completely. Do not patch it sentence by sentence, and do not shorten it by deleting whole ideas.',
    '',
    'WHAT FAILED — fix every line',
    issues,
    '',
    'THE TARGET',
    '- At least eight substantial <p> paragraphs of two to four sentences each.',
    '- At least five <h2> sections. Every section starts with prose; lists only ever follow prose.',
    '- Under 30% of the words inside <li> elements, and no more than two lists in the whole page.',
    '- One worked example with numbers, and one honest paragraph about what this is not.',
    '- The offer' + (facts.price ? ' and the figure (' + facts.price + ')' : '') + ' named inside the first 100 words.',
    '- A mid-page ask around the middle of the article, not only at the end.',
    '- A "Before you ' + (facts.type === 'job' ? 'apply' : facts.type === 'product' ? 'order' : 'get in touch') +
      '" section listing what the reader must have ready, and a short passage on what happens after they act.',
    '- A closing paragraph that uses "' + facts.cta + '".',
    '- Facts must survive the rewrite. Keep every true specific; remove anything invented.',
    '',
    'THE COMMISSION (unchanged)',
    '- Title: ' + (post.title || facts.title),
    '- Purpose: ' + brief.job,
    '- Opening scene: ' + brief.scene,
    '- Must answer: ' + brief.covers.join('; ') + '.',
    '- Avoid: ' + brief.avoid + '.',
    '',
    'THE CONVERSION JOB (unchanged)',
    conversionBrief(input.offer, facts),
    '',
    (voice.promptBlock || ''),
    '',
    'DRAFT TO REPLACE',
    '<article>' + String(input.draft || '') + '</article>',
    '',
    'Return the rewritten article body only, as an HTML fragment starting with <p>.' + FRAGMENT_ONLY,
  ].join('\n');
}

/**
 * Polish pass for an existing page (the tenant portal's Review button). Voice
 * aware, but conservative: it may not change facts or the call to action.
 */
export function buildReviewPrompt(input) {
  const voice = input.voice || {};
  const facts = offerFacts(input.offer);
  const problems = input.issues ? '\nMeasured problems to correct:\n' + input.issues + '\n' : '';
  return [
    'You are editing one existing article for ' + (voice.brand || facts.title) + '.',
    'Improve it without changing any fact, price, date or the call to action. Keep every specific that is already correct.',
    '',
    'House standard: prose first. Two to four sentences per paragraph, a list only after the prose it summarises, ' +
    'no more than two lists per page, no heading followed by a bare list, no cliché openers and no "Conclusion" heading.',
    'Remove markdown, asterisks, emoji and any sentence that would read the same on a competitor\'s blog.',
    problems,
    (voice.promptBlock || ''),
    '',
    'ARTICLE',
    '<article>' + String(content(input)) + '</article>',
    '',
    'Return the improved article body only, as an HTML fragment.' + FRAGMENT_ONLY,
  ].join('\n');
}

function content(input) {
  return String((input && input.content) || '');
}
