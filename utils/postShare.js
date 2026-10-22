// Share cards — the link a tenant sends out, plus the copy that travels with it.
//
// The Writer's Flow can publish nine pages for one offer, but until now the only
// things a tenant could do with a page were open it or delete it. Sending the
// link to a customer needs words, and the words should come from the page itself
// rather than from whoever happens to be holding the phone. One page therefore
// yields three things:
//   hook    — the single line that earns the click (<= 140 chars)
//   summary — what the page argues, and who it is for (2-3 sentences)
//   excerpt — a paste-ready snippet for WhatsApp / X (<= 240 chars)
//
// The AI tier writes these when one of its keys is up. When every provider is dry
// (live 2026-10-22: OpenRouter 429 on the remaining free slugs, Gemini quota
// spent, HuggingFace 402) the same shape is composed from the page's own words
// and labelled mode:'template' — the honesty rule already used by
// utils/angleFallback.js, so no tenant is ever told a model wrote copy it did
// not write.
//
// Kept as a pure module (no DB, no network, no env) so scripts/test_post_share.mjs
// can prove the shape offline.

export const SHARE_LIMITS = { hook: 140, summary: 420, excerpt: 240, hashtags: 4 };

// Words that make a hashtag look machine-generated. Title words are the ones a
// buyer would actually search, so everything else is dropped.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'your', 'you', 'how', 'what', 'why', 'when',
  'from', 'into', 'this', 'these', 'those', 'are', 'our', 'its', 'his', 'her',
  'to', 'of', 'in', 'on', 'at', 'by', 'is', 'it', 'be', 'as', 'or', 'we', 'can',
  'will', 'not', 'get', 'got', 'more', 'than', 'ever', 'best', 'top', 'new',
  'guide', 'complete', 'step', 'steps', 'article', 'page', 'post', 'about',
  'all', 'need', 'needs', 'should', 'must', 'made', 'make', 'who', 'take',
]);

export function htmlToText(html) {
  return String(html == null ? '' : html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|section|article)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function tidy(text) {
  return String(text == null ? '' : text)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

// Splits on sentence ends without a lookbehind, so the module also runs on older
// Node builds that some hosts still pin.
export function sentences(text) {
  const clean = tidy(text);
  if (!clean) return [];
  const out = [];
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];
    if ((ch === '.' || ch === '!' || ch === '?') && (next === undefined || next === ' ')) {
      // Keep decimals ("1,500.00") from splitting a line in half.
      if (ch === '.' && /\d/.test(clean[i - 1] || '') && /\d/.test(next || '')) continue;
      const piece = tidy(clean.slice(start, i + 1));
      if (piece) out.push(piece);
      start = i + 1;
    }
  }
  const tail = tidy(clean.slice(start));
  if (tail) out.push(tail);
  return out;
}

// Hard cap at a word boundary. Used for every field, including AI output: a model
// that ignores "max 140 characters" must not produce a 900-character hook.
export function clip(text, max) {
  const clean = tidy(text);
  if (!clean) return '';
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const at = cut.lastIndexOf(' ');
  const body = (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:\-–—]+$/, '');
  return body + '…';
}

export function firstSentences(text, max) {
  const list = sentences(text);
  if (!list.length) return '';
  let out = '';
  for (const s of list) {
    const next = out ? out + ' ' + s : s;
    if (next.length > max) break;
    out = next;
  }
  return out || clip(list[0], max);
}


// The first paragraph that actually says something — the composed fallback pages
// open with one, AI pages open with one, and a page with no <p> at all still
// yields text instead of an empty card.
export function leadParagraph(html) {
  const raw = String(html == null ? '' : html);
  const paragraphs = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(raw))) {
    const text = htmlToText(m[1]);
    if (text.length > 40) paragraphs.push(text);
  }
  return paragraphs[0] || htmlToText(raw);
}

// Heading + its opening line, so the summary can name what the page covers.
export function sections(html) {
  const raw = String(html == null ? '' : html);
  const out = [];
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2[^>]*>|$)/gi;
  let m;
  while ((m = re.exec(raw))) {
    const heading = htmlToText(m[1]);
    const text = firstSentences(htmlToText(m[2]), 200);
    if (heading && text) out.push({ heading, text });
  }
  return out;
}

export function hashtagsFor(parts, max = SHARE_LIMITS.hashtags) {
  const words = String((parts || []).join(' ')).match(/[A-Za-z][A-Za-z0-9]{2,}/g) || [];
  const seen = new Set();
  const tags = [];
  for (const word of words) {
    const key = word.toLowerCase();
    if (STOP_WORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    tags.push('#' + word.charAt(0).toUpperCase() + word.slice(1));
    if (tags.length >= max) break;
  }
  return tags;
}

// Deterministic card. Never invents a price, a statistic or a claim: every string
// here is lifted from the page that is being shared.
export function deriveShareCard({ title, angle, content, offer } = {}) {
  const pageTitle = tidy(title || (offer && offer.title) || '');
  const angleLabel = tidy(angle || '');
  const raw = String(content == null ? '' : content);

  const lead = leadParagraph(raw);
  const body = lead || pageTitle;
  if (!body) {
    return { hook: '', summary: '', excerpt: '', bullets: [], hashtags: [], mode: 'template' };
  }

  const hook = clip(firstSentences(body, SHARE_LIMITS.hook) || pageTitle || body, SHARE_LIMITS.hook);

  const secs = sections(raw);
  const summaryParts = [firstSentences(lead, 220)];
  if (secs[0] && secs[0].text) summaryParts.push(secs[0].text);
  const summary = firstSentences(summaryParts.filter(Boolean).join(' '), SHARE_LIMITS.summary) || hook;

  const excerpt = firstSentences(body, SHARE_LIMITS.excerpt) || summary;

  return {
    hook,
    summary,
    excerpt,
    bullets: secs.slice(0, 3).map((s) => ({ heading: s.heading, text: s.text })),
    hashtags: hashtagsFor([pageTitle, angleLabel, (offer && offer.location_text) || '', (offer && offer.offer_type) || '']),
    mode: 'template',
  };
}

// One short call, one shape back. The page body is clipped because the card only
// needs the argument and the quotable line; a 2,400-character window keeps a
// free-tier model inside its context and the tenant inside a few seconds.
export function buildSharePrompt(source = {}) {
  const { title, angle, content, offer } = source;
  const body = clip(htmlToText(content), 2400);
  const facts = [];
  if (offer) {
    if (offer.offer_type) facts.push('Offer type: ' + offer.offer_type);
    if (offer.compensation_max != null) {
      facts.push('Price: ' + (offer.compensation_currency || 'KES') + ' ' + offer.compensation_max);
    }
    if (offer.location_text) facts.push('Location: ' + offer.location_text);
  }
  return [
    'Write the share copy for one published web page.',
    'Reply with ONLY minified JSON, no prose and no code fence:',
    '{"hook":"...","summary":"...","excerpt":"..."}',
    'hook: one sentence, max 140 characters, earns the click; no hashtags, no "in this article", no surrounding quotes.',
    'summary: 2-3 sentences, max 400 characters, says what the page argues and who it is for.',
    'excerpt: max 220 characters, the most quotable idea on the page, readable on WhatsApp.',
    'Never invent a price, phone number, statistic, customer name or testimonial that is not in the page.',
    'Page title: ' + tidy(title || (offer && offer.title) || ''),
    angle ? 'Page angle: ' + tidy(angle) : '',
    facts.length ? facts.join(' | ') : '',
    'Page text:',
    body,
  ].filter(Boolean).join('\n');
}

// Tolerant parse: models wrap the JSON in fences or add a sentence before it.
// Returns null when nothing usable came back, so the caller falls back instead of
// shipping a blank card.
export function parseShareCard(text) {
  if (!text) return null;
  let raw = String(text).trim();
  if (!raw) return null;
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const hook = clip(obj.hook, SHARE_LIMITS.hook);
  const summary = clip(obj.summary, SHARE_LIMITS.summary);
  const excerpt = clip(obj.excerpt, SHARE_LIMITS.excerpt);
  if (!hook || !summary || !excerpt) return null;
  return { hook, summary, excerpt };
}
