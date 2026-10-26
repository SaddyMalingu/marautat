/**
 * Per-tenant editorial voice.
 *
 * Why this module exists (2026-10-25): every tenant's Writer's Flow run used the
 * same one-line prompt ("Write an educational blog post explaining what X is …
 * HTML format, NO markdown"), so nine pages from one offer read like nine
 * outputs of the same machine, and two different tenants read like each other.
 * The published corpus (283 pages, all audited on 2026-10-26) had the matching
 * symptom: wall-to-wall `<ul>` fragments under headings, no scene, no numbers,
 * no named reader. A tenant selling studio time and a tenant selling pharma
 * supply were being written by the same voice.
 *
 * A voice is therefore resolved per tenant and injected into the brief:
 *   1. an explicit setting wins — `site_tenants.brand_voice` / `.voice` /
 *      `.tone`, else `bot_tenants.tone`, else `bot_templates.tone`;
 *   2. otherwise one of six profiles is assigned deterministically from the
 *      tenant's own identifiers, so the same tenant always sounds like itself
 *      across runs and deploys, and two tenants practically never collide.
 *
 * Pure functions only — no fs, no network, no database — so the profiles and the
 * assignment can be proven offline (scripts/test_blog_quality.mjs).
 */

// Six distinct editorial personalities. `openers` are style demonstrations, not
// lines to copy: a model that reuses one verbatim would make every tenant sound
// alike again, which is exactly the failure this module exists to stop.
export const VOICE_PROFILES = [
  {
    id: 'warm-neighbourhood-expert',
    label: 'the warm neighbourhood expert',
    essence: 'A trusted local specialist who talks to one person, not a market.',
    rhythm: 'Short sentences. Frequent second person. One idea per sentence, then a breather.',
    openers: [
      'You know the moment the quote stops making sense.',
      'Most people come to us after the second quote, not the first.',
      'There is a version of this that costs less and works better. It starts with one question.',
    ],
    lexicon: 'plain words, everyday comparisons, local place names, "you", "we"',
    avoid: 'corporate abstractions ("solutions", "synergy"), statistics without a source, hype',
    ctaStyle: 'an invitation from a person: "tell us what you are working with and we will tell you what we would do"',
  },
  {
    id: 'precise-operator',
    label: 'the precise operator',
    essence: 'An operations lead who respects the reader\'s time and the reader\'s numbers.',
    rhythm: 'Medium sentences, front-loaded facts. Sentences that end on a number or a decision.',
    openers: [
      'Three numbers decide this: scope, timeline, and who signs off.',
      'Start with the constraint, not the wish list.',
      'The cheapest option is rarely the one that survives a scope change.',
    ],
    lexicon: 'measured quantities, units, timelines, named roles, "check", "confirm", "compare"',
    avoid: 'adjectives doing the work of evidence, "seamless", "cutting-edge", emoji',
    ctaStyle: 'a concrete next action with what the reader should bring: "send the scope and we will price it line by line"',
  },
  {
    id: 'bold-challenger',
    label: 'the bold challenger',
    essence: 'The writer who says the uncomfortable thing the buyer already suspects.',
    rhythm: 'A short punch, then a longer sentence that earns it. Occasional one-line paragraph for emphasis.',
    openers: [
      'Most of what you were told about this is a sales script.',
      'If your supplier cannot answer this in one sentence, keep looking.',
      'You do not have a marketing problem. You have a follow-up problem.',
    ],
    lexicon: 'direct verbs, blunt contrasts, "stop", "start", "the real question"',
    avoid: 'sneering, absolutes that can be disproved, insulting the reader\'s past decisions',
    ctaStyle: 'a challenge the reader can accept today: "book the call and bring the number you are trying to move"',
  },
  {
    id: 'measured-advisor',
    label: 'the measured advisor',
    essence: 'A senior consultant who names the trade-offs nobody else puts on the page.',
    rhythm: 'Balanced sentences, deliberate contrasts ("on one hand … on the other"), no exclamation marks.',
    openers: [
      'There is a good reason this decision keeps getting postponed.',
      'Every option here is a trade, and the useful work is naming which one you are making.',
      'Before comparing suppliers, decide what you would refuse to compromise on.',
    ],
    lexicon: 'trade-off language, "it depends on", conditions, evidence, risk, "in practice"',
    avoid: 'false balance, hedging that never lands a recommendation, jargon without a plain gloss',
    ctaStyle: 'a low-pressure review: "walk us through the decision and we will tell you which risks are real"',
  },
  {
    id: 'storytelling-guide',
    label: 'the storytelling guide',
    essence: 'A writer who shows the reader a scene before explaining anything.',
    rhythm: 'Longer, flowing sentences broken by short ones at the turn. Concrete sensory detail.',
    openers: [
      'The first time a customer scans a poster and pays from their phone, something changes in how the team thinks about the shop.',
      'It is 7:40 on a Monday and the phone has already rung twice about the same order.',
      'Picture the folder nobody opens: that is where most of the money leaks.',
    ],
    lexicon: 'scenes, time of day, named places and roles, small concrete details',
    avoid: 'fiction presented as fact, invented customers, purple prose that buries the point',
    ctaStyle: 'the next chapter: "tell us where your story currently stalls and we will map the next scene"',
  },
  {
    id: 'practical-teacher',
    label: 'the practical teacher',
    essence: 'A patient expert who makes a complicated thing feel learnable.',
    rhythm: 'Clear cause-and-effect sentences. One analogy per section, then straight explanation.',
    openers: [
      'Think of it as a shop counter: everything the customer needs should pass over it once.',
      'There are four moving parts here, and only one of them is usually broken.',
      'You do not need to become an expert to judge this well. You need three checks.',
    ],
    lexicon: 'analogies, definitions in plain words, "first", "then", "that means"',
    avoid: 'condescension, unexplained acronyms, lists standing in for explanation',
    ctaStyle: 'a guided first step: "ask us for the checklist and we will walk the first section with you"',
  },
];

const BY_ID = new Map(VOICE_PROFILES.map((v) => [v.id, v]));

// Words a buyer or a bot template might actually have typed into a tone field.
const TONE_ALIASES = [
  [/\b(warm|friendly|neighbourhood|neighborhood|local|approachable|human)\b/i, 'warm-neighbourhood-expert'],
  [/\b(precise|technical|operational|data|exact|analytical|matter[- ]of[- ]fact)\b/i, 'precise-operator'],
  [/\b(bold|confident|direct|punchy|challenger|provocative)\b/i, 'bold-challenger'],
  [/\b(professional|formal|measured|advisory|consultative|corporate|senior)\b/i, 'measured-advisor'],
  [/\b(story|storytelling|narrative|playful|creative|vivid)\b/i, 'storytelling-guide'],
  [/\b(teacher|educational|instructional|patient|helpful|explanatory)\b/i, 'practical-teacher'],
];

// The industry lens keeps examples concrete without asking the model to invent a
// market. Matched on the tenant name, site description and offer text.
const INDUSTRY_LENSES = [
  [/\b(music|instrument|audio|sound|studio|band|guitar|piano)\b/i, 'music retail and studio work'],
  [/\b(pharm|chemist|drug|clinic|health|medical|hospital|nurse|dental)\b/i, 'health and pharmaceutical supply'],
  [/\b(construct|building|architect|survey|quantity|contractor|engineer)\b/i, 'construction, design and build'],
  [/\b(school|college|university|academy|training|tutor|course|education)\b/i, 'education and training'],
  [/\b(hotel|restaurant|lounge|cafe|coffee|bar|kitchen|catering|hospitality)\b/i, 'hospitality and food service'],
  [/\b(fashion|cloth|boutique|tailor|apparel|garment|shoe)\b/i, 'fashion retail and tailoring'],
  [/\b(law|legal|advocate|account|audit|tax|consult|advisory)\b/i, 'professional services'],
  [/\b(farm|agri|dairy|poultry|produce|seed|irrigation)\b/i, 'agriculture and agribusiness'],
  [/\b(logistic|transport|delivery|courier|fleet|freight)\b/i, 'logistics and delivery'],
  [/\b(real ?estate|property|landlord|rental|letting)\b/i, 'property and real estate'],
];

function esc(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

// FNV-1a: tiny, stable, and dependency-free. The only property we need is that
// the same tenant lands on the same profile on every machine and every deploy.
function hash(value) {
  let h = 0x811c9dc5;
  const s = String(value || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function matchProfile(text) {
  const probe = esc(text);
  if (!probe) return null;
  const direct = BY_ID.get(probe.toLowerCase());
  if (direct) return direct;
  for (const [pattern, id] of TONE_ALIASES) {
    if (pattern.test(probe)) return BY_ID.get(id);
  }
  return null;
}

function industryLens(...parts) {
  const probe = parts.map(esc).filter(Boolean).join(' ');
  for (const [pattern, label] of INDUSTRY_LENSES) {
    if (pattern.test(probe)) return label;
  }
  return '';
}

/** Every profile id, in assignment order. Used by the tests and the runbook. */
export function listVoiceProfiles() {
  return VOICE_PROFILES.map((v) => v.id);
}

// The audience a page is written for. A job page speaks to a candidate; every
// other offer type speaks to the person who has to justify the spend. Same rule
// `utils/contentJourney.js` uses to branch its titles.
function defaultAudience(offer) {
  const type = offer && offer.offer_type;
  return type && type !== 'job'
    ? 'the buyer who has to justify this spend'
    : 'someone weighing this career move';
}

/**
 * Resolve the voice one tenant writes in.
 *
 * @param {{site?: object, tenant?: object, botTemplate?: object, offer?: object}} input
 * @returns {{id: string, label: string, source: string, brand: string,
 *            industry: string, location: string, audience: string,
 *            voice: object, promptBlock: string, signature: string}}
 */
export function resolveTenantVoice(input = {}) {
  const site = input.site || {};
  const tenant = input.tenant || {};
  const botTemplate = input.botTemplate || {};
  const offer = input.offer || {};

  const brand = esc(site.name || tenant.client_name || offer.brand_name || 'the business');
  // `metadata` is the column every deployed site_tenants row already has, so a
  // tenant can choose a voice without waiting for a migration. The dedicated
  // `brand_voice` / `voice` / `tone` columns are still honoured first for hosts
  // that added them.
  const settings = (site.metadata && typeof site.metadata === 'object') ? site.metadata : {};
  const configured = esc(
    site.brand_voice || site.voice || site.tone ||
    settings.voice || settings.brand_voice || settings.tone ||
    tenant.tone || tenant.brand_voice ||
    botTemplate.tone || botTemplate.voice,
  );

  const identity = esc(site.id || site.slug || tenant.id || tenant.client_phone || brand);
  const matched = matchProfile(configured);
  const voice = matched || VOICE_PROFILES[hash(identity) % VOICE_PROFILES.length];
  // Configured text that matches no profile is still honoured as a custom
  // instruction — a tenant that typed "dry, slightly sarcastic" meant it.
  const customNote = configured && !matched ? configured : '';

  const industry = esc(site.industry || tenant.industry) ||
    industryLens(brand, site.description, offer.title, offer.description, (offer.skills || []).join(' ')) ||
    'the reader\'s own market';
  const location = esc(site.location || offer.location_text || tenant.location);
  const audience = esc(site.audience || offer.audience) || defaultAudience(offer);

  return {
    id: voice.id,
    label: voice.label,
    source: matched ? 'configured' : (customNote ? 'custom' : 'derived'),
    brand,
    industry,
    location,
    audience,
    voice,
    promptBlock: buildVoicePromptBlock({ brand, industry, location, audience, voice, customNote }),
    signature: voice.id,
  };
}

/**
 * The block the article brief embeds. Deliberately concrete: rhythm, lexicon,
 * what to avoid, and three demonstrations of the *style* (never lines to paste).
 */
export function buildVoicePromptBlock(v) {
  if (!v || !v.voice) return '';
  const voice = v.voice;
  const lines = [];
  lines.push('VOICE — ' + voice.label.toUpperCase() + ' (' + voice.id + ')');
  lines.push('Who is speaking: the staff writer for ' + v.brand + '. ' + voice.essence);
  lines.push('Rhythm: ' + voice.rhythm);
  lines.push('Lean on: ' + voice.lexicon + '.');
  lines.push('Do not sound like: ' + voice.avoid + '.');
  lines.push('Call to action style: ' + voice.ctaStyle + '.');
  lines.push('Style demonstrations (imitate the cadence, never copy the words):');
  for (const o of voice.openers) lines.push('  - ' + o);
  lines.push('Reader in mind: ' + v.audience + '.');
  lines.push('Market to keep concrete: ' + v.industry + (v.location ? ' in ' + v.location : '') + '.');
  if (v.customNote) {
    lines.push('The business also described its tone in its own words: "' + v.customNote +
      '". Honour that where it does not conflict with the rules above.');
  }
  return lines.join('\n');
}
