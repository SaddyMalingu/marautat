/**
 * "Does this post say they need something?" (2026-11-04)
 *
 * The listening harness has existed since the ABOSS work: a taxonomy of twelve intents with
 * trigger / warm / exclusion phrases, a Kenyan market focus, and a scorer in
 * `scripts/aboss_run_social_listening.cjs`. What it never had was input — nothing produced
 * `data/ABOSS_SOCIAL_SIGNALS_RAW.csv`, so the scorer always ran over an empty file and the
 * whole pipeline was a well-tested hypothesis.
 *
 * The tenant's own browser is the missing eyes. This module is the part that must not live in
 * either the browser or the database, because it is the part that decides **whether a human
 * being is worth a human being's time**: pure functions, no I/O, tested directly.
 *
 * Two rules carried over from the ops script on purpose:
 *
 *   1. **No fabrication.** A post that matches no intent is dropped, not scored low. An empty
 *      digest is a true statement about the week; a padded one costs the tenant their credibility
 *      the first time they send one.
 *   2. **Exclusion beats inclusion.** "Job vacancy" and "dealer ad" contain the trigger words for
 *      a fleet purchase, and they are the overwhelming majority of such posts.
 *
 * One rule added here: a score is not a decision. `MIN_OUTREACH_SCORE` marks what is worth
 * showing; sending stays with the tenant, always.
 */

/** Below this, a signal is context, not a lead. The panel shows it greyed, never as "ready". */
export const MIN_OUTREACH_SCORE = 65;

/** Score bands, used for the chip colour and the wording. Never a substitute for the number. */
export const CONFIDENCE_BANDS = Object.freeze([
  { min: 70, label: 'HIGH' },
  { min: 50, label: 'MEDIUM' },
  { min: 0, label: 'LOW' }
]);

/**
 * Signals that a post is a commercial inquiry rather than a conversation.
 *
 * Deliberately not global regexes: `.test()` on a `/g/` regex advances `lastIndex` between
 * calls, which made the second post in a row score differently from the first.
 */
const BUDGET_RE = /(ksh|kes|usd|\$)\s?\d+|\bunder\s+\d+|\bbudget\b|\bquote\b/i;
const TIMELINE_RE = /\basap\b|\burgent\b|\bimmediately\b|\btoday\b|\bthis week\b|\bthis month\b|\bnext week\b|\bby end of\b/i;
const DECISION_RE = /(owner|founder|procurement|operations|fleet|manager|head of|director|ceo|coo|commercial)/i;
const CONTACT_WORDS_RE = /whatsapp|\bdm\b|inbox|email me|\bcall me\b/i;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?254|0)(?:\d[\s().-]?){8,10}/;

function clean(value, max = 4000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Kenya-first phone handling, because the channel that actually converts here is WhatsApp and
 * `254 712 345 678`, `+254712345678` and `0712345678` are one number written three ways.
 */
export function normalizeKenyaPhone(raw) {
  const digits = clean(raw, 40).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('254') && digits.length === 12) return `+${digits}`;
  if ((digits.startsWith('07') || digits.startsWith('01')) && digits.length === 10) return `+254${digits.slice(1)}`;
  return null;
}

/** The first usable email and phone in the text, or nulls. Never guesses a number. */
export function extractContact(text) {
  const body = clean(text);
  const emailMatch = body.match(EMAIL_RE);
  const phoneCandidates = body.match(new RegExp(PHONE_RE.source, 'g')) || [];
  let phone = null;
  for (const candidate of phoneCandidates) {
    phone = normalizeKenyaPhone(candidate);
    if (phone) break;
  }
  return { email: emailMatch ? emailMatch[0].toLowerCase() : null, phone };
}

function matchPhrases(haystack, phrases) {
  const hits = [];
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const needle = clean(phrase, 120).toLowerCase();
    // Two-character phrases match half the language; the taxonomy has none, and this keeps it so.
    if (needle.length < 3) continue;
    if (haystack.includes(needle) && !hits.includes(needle)) hits.push(needle);
  }
  return hits;
}

export function confidenceOf(score) {
  const value = Number(score) || 0;
  return (CONFIDENCE_BANDS.find((band) => value >= band.min) || CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1]).label;
}

/** The channel the tenant can actually use, in order of conversion for this market. */
export function recommendedChannel({ phone, email, postUrl, profileUrl }) {
  if (phone) return 'whatsapp';
  if (email) return 'email';
  if (profileUrl || postUrl) return 'social_dm';
  return 'research_needed';
}


/**
 * What the tenant sends. One line, specific, and honest about being a first touch.
 *
 * It is a **draft**, not a message: nothing here is sent by the system, and the wording quotes
 * their post, so the person reading it can tell it came from something they actually wrote.
 */
export function draftFirstLine({ intentName, authorName, authorHandle }) {
  const who = clean(authorName, 80) || clean(authorHandle, 80) || 'there';
  const topic = clean(intentName, 120).toLowerCase() || 'this';
  return `Hi ${who} — saw your post about ${topic}. If it helps, I can put a short, priced shortlist in front of you today; want me to send it?`;
}

/**
 * Score one post against the taxonomy.
 *
 * Returns `null` when the post is not about anything we sell — the honest answer for most posts,
 * and the reason a quiet week shows an empty digest instead of a padded one.
 *
 * @param {{text?: string, authorName?: string, authorHandle?: string, location?: string,
 *          postUrl?: string, profileUrl?: string}} post
 * @param {object} taxonomy the parsed `data/aboss_social_intent_taxonomy.json`
 * @param {{market?: string, cities?: string[]}} [options]
 */
export function scorePost(post = {}, taxonomy = {}, options = {}) {
  // Accept both spellings: the worker-facing shape says `postText` (it is a post, not an offer)
  // and this function says `text`. Translating in one place beats translating in every caller.
  const text = clean(post.text || post.postText);
  if (text.length < 12) return null;

  // Author and location are scored with the body: "Nairobi" in a location field is as good a
  // signal as "Nairobi" in the sentence, and a decision-maker title is often only in the byline.
  const blob = [text, post.authorName, post.authorHandle, post.location].map((part) => clean(part, 400)).join(' ');
  const lower = blob.toLowerCase();

  const cities = [
    options.market || taxonomy.default_market,
    ...(options.cities || taxonomy.default_city_focus || [])
  ].map((city) => clean(city, 60).toLowerCase()).filter(Boolean);

  const contact = extractContact(text);
  const hasContact = Boolean(contact.email || contact.phone) || CONTACT_WORDS_RE.test(blob);

  let best = null;
  for (const intent of Array.isArray(taxonomy.intents) ? taxonomy.intents : []) {
    const triggerHits = matchPhrases(lower, intent.trigger_phrases);
    const warmHits = matchPhrases(lower, intent.warm_phrases);
    // No phrase at all is not a weak match, it is a different subject. This is the line that
    // keeps the digest from filling with posts that merely mention a budget.
    if (!triggerHits.length && !warmHits.length) continue;

    const exclusionHits = matchPhrases(lower, intent.exclusion_phrases);

    let score = triggerHits.length ? 35 : 20;
    if (BUDGET_RE.test(blob)) score += 15;
    if (TIMELINE_RE.test(blob)) score += 15;
    if (cities.some((city) => lower.includes(city))) score += 10;
    if (hasContact) score += 10;
    if (DECISION_RE.test(blob)) score += 10;
    if (exclusionHits.length) score -= 40;
    score = Math.max(0, Math.min(100, score));

    const candidate = { intent, triggerHits, warmHits, exclusionHits, score };
    if (!best || candidate.score > best.score) best = candidate;
  }

  if (!best) return null;

  return {
    intentId: String(best.intent.intent_id || 'unknown'),
    intentName: String(best.intent.intent_name || best.intent.intent_id || 'Unknown'),
    buyerSignalStrength: best.intent.buyer_signal_strength ? String(best.intent.buyer_signal_strength) : null,
    intentScore: best.score,
    confidence: confidenceOf(best.score),
    triggerHits: best.triggerHits,
    warmHits: best.warmHits,
    exclusionHits: best.exclusionHits,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    recommendedChannel: recommendedChannel({
      phone: contact.phone,
      email: contact.email,
      postUrl: post.postUrl,
      profileUrl: post.profileUrl
    }),
    offerAngle: best.intent.offer_angle ? String(best.intent.offer_angle) : null,
    decisionRoles: Array.isArray(best.intent.decision_roles) ? best.intent.decision_roles.slice(0, 6) : []
  };
}


/** Is this worth a human's attention today? */
export function isOutreachReady(signal) {
  return Boolean(signal) && Number(signal.intentScore) >= MIN_OUTREACH_SCORE && !(signal.exclusionHits || []).length;
}

/**
 * What to search for, from the taxonomy rather than from a hand-written list.
 *
 * Hottest intents first, and distinct phrases: LinkedIn's content search is the most expensive
 * read in the run (a page, a render, a scroll), so six slots must mean six different subjects,
 * not six paraphrases of one.
 */
export function planSearchQueries(taxonomy = {}, { intents = 3, perIntent = 2 } = {}) {
  const ordered = (Array.isArray(taxonomy.intents) ? [...taxonomy.intents] : [])
    .map((intent, index) => ({ intent, index }))
    // `buyer_signal_strength` is 'hot' where people ask to buy, 'warm' where they ask for help:
    // hot first, then the taxonomy's own order.
    .sort((a, b) => {
      const rank = (row) => (String(row.intent.buyer_signal_strength || '').toLowerCase() === 'hot' ? 0 : 1);
      return rank(a) - rank(b) || a.index - b.index;
    })
    .slice(0, intNumber(intents, 3));

  const queries = [];
  for (const { intent } of ordered) {
    const phrases = (Array.isArray(intent.trigger_phrases) ? intent.trigger_phrases : [])
      .map((phrase) => clean(phrase, 80))
      .filter(Boolean)
      .slice(0, intNumber(perIntent, 2));
    for (const phrase of phrases) {
      if (queries.some((row) => row.phrase.toLowerCase() === phrase.toLowerCase())) continue;
      queries.push({ intentId: String(intent.intent_id || ''), phrase });
    }
  }
  return queries;
}

function intNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Two posts with the same URL are one signal — a re-run of the same search must not double the
 * digest. The URL is the identity because a post's text gets edited and its id does not.
 */
export function dedupeByPostUrl(signals) {
  const seen = new Set();
  const out = [];
  for (const signal of Array.isArray(signals) ? signals : []) {
    const key = clean(signal?.postUrl, 500).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }
  return out;
}
