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

/**
 * "Who can help me with this?" — the words that separate a person asking from a person talking.
 *
 * English and Swahili, because the taxonomy's own languages are both and a Kenyan buyer asking
 * for a supplier often asks in Swahili. This is scored **on top of** the intent phrases: a post
 * that says "need supplier" is a topic, one that says "need supplier — anyone know one?" is a
 * person waiting for an answer.
 */
const QUESTION_CUE_RE = /\b(anyone know|any one know|who can|who knows|recommend|recommendations?|suggestions?|any advice|where can i|looking for (a |the )?recommendation|natafuta|naomba msaada|msaada|ninahitaji|nisaidie|wapi ninaweza)\b/i;
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
 * How old is this post, in hours — from whatever the page wrote.
 *
 * Pages write age five ways: "2h", "3 days ago", "2 days ago", an ISO timestamp in `datetime`,
 * or a Unix timestamp in seconds (Reddit's `created-timestamp`). All of them are the same fact.
 * Anything unreadable returns `null`, not 0: "we don't know" and "just posted" must not score
 * the same, and half the point of reading age is to stop replying to a week-old thread.
 */
export function parsePostedAgoHours(raw, now = Date.now()) {
  const text = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!text) return null;

  // Unix seconds or milliseconds, which is how Reddit stamps a card.
  if (/^\d{10}(\d{3})?$/.test(text)) {
    const value = Number(text);
    const ms = text.length === 13 ? value : value * 1000;
    const hours = (now - ms) / 3_600_000;
    return Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 10) / 10 : null;
  }

  // ISO or RFC date from a `datetime` attribute.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      const hours = (now - parsed) / 3_600_000;
      return hours >= 0 ? Math.round(hours * 10) / 10 : null;
    }
    return null;
  }

  // "5m", "2h", "3d", "2 hours ago", "just now", "yesterday".
  if (/just now|wewe|now\b/.test(text)) return 0;
  if (/^\s*ju?st\b/.test(text)) return 0;
  const relative = text.match(/(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months|y|yr|year|years)\b/);
  if (relative) {
    const value = Number(relative[1]);
    const unit = relative[2];
    // Longest-first, because 'minutes' starts with 'm' and 'months' starts with 'mo'.
    const hoursPer = /^(s|sec)/.test(unit) ? 1 / 3600
      : /^mo/.test(unit) ? 24 * 30
        : /^(m|min|minute)/.test(unit) ? 1 / 60
          : /^h/.test(unit) ? 1
            : /^d/.test(unit) ? 24
              : /^w/.test(unit) ? 24 * 7
                : 24 * 365;
    const hours = value * hoursPer;
    return Number.isFinite(hours) ? Math.round(hours * 10) / 10 : null;
  }
  return null;
}

/**
 * Engagement as numbers, from whatever the page showed.
 *
 * "1.2K comments", "12", "12 comments" — all the same fact. Anything unreadable becomes 0 rather
 * than a guess, because this feeds a score someone will act on.
 */
export function normalizeEngagement(raw = {}) {
  const parse = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
    const text = String(value == null ? '' : value).replace(/,/g, '').trim().toLowerCase();
    const match = text.match(/(\d+(?:\.\d+)?)\s*([km])?/);
    if (!match) return 0;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return 0;
    const multiplier = match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : 1;
    return Math.max(0, Math.round(base * multiplier));
  };
  return {
    comments: parse(raw.comments ?? raw.replies),
    likes: parse(raw.likes ?? raw.reactions),
    shares: parse(raw.shares ?? raw.reposts)
  };
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
  /** Is this someone asking for an answer, rather than stating a fact? */
  const askingCue = QUESTION_CUE_RE.test(blob);
  const engagement = normalizeEngagement(post.engagement || {});
  const postedAgoHours = Number.isFinite(Number(post.postedAgoHours)) ? Math.max(0, Number(post.postedAgoHours)) : null;

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
    // A question is worth more than a statement: "need supplier" is a topic, "need supplier —
    // anyone know one?" is someone waiting for an answer they will give to whoever replies first.
    if (askingCue) score += 8;
    // Reach: a post other people already answered is a live conversation, and a reply there is
    // seen by everyone in it. Counts are read from the page, never assumed.
    if (engagement.comments >= 3) score += 6;
    else if (engagement.comments >= 1) score += 3;
    if (engagement.likes >= 5) score += 4;
    else if (engagement.likes >= 1) score += 2;
    // Timing: nobody hires from a three-week-old thread.
    if (postedAgoHours !== null) {
      if (postedAgoHours <= 24) score += 6;
      else if (postedAgoHours <= 72) score += 3;
    }
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
    decisionRoles: Array.isArray(best.intent.decision_roles) ? best.intent.decision_roles.slice(0, 6) : [],
    // The evidence behind the extra points, kept with the score so a human can disagree with it.
    askingCue,
    engagement,
    postedAgoHours
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
