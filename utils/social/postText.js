/**
 * Post text composition (2026-10-31)
 *
 * One share card, two destinations, two different rules. The card itself already
 * exists — utils/postShare.js produces hook (<=140), excerpt (<=240) and tags,
 * and admin/tenant_dashboard.html already joins them as
 * `[hook, excerpt, absolute_url]`. That join is fine for a human pasting into
 * WhatsApp. It is not fine for an API that rejects at 280.
 *
 * The rules that actually matter, and that are easy to get wrong:
 *
 *   1. X counts every URL as 23 characters (t.co), regardless of its real
 *      length. A 60-character URL therefore costs 23, not 60 — so a composer
 *      that truncates by `text.length` throws away room it never needed, or
 *      (worse) appends a URL it then cannot afford.
 *   2. Emoji and CJK count as 2.
 *   3. A URL must never be cut. A truncated link is a 404 the tenant sends to
 *      a customer.
 *   4. Hashtags are the first thing to go, then the excerpt. The hook and the
 *      link are the post.
 *
 * Pure: no network, no env, no IO — scripts/test_social_publish.mjs proves it.
 */

export const X_LIMIT = 280;
/** X's t.co link weighting: every URL counts as this many characters. */
export const X_URL_WEIGHT = 23;
export const LINKEDIN_LIMIT = 3000;
/** LinkedIn collapses the body behind "see more" at roughly this point. */
export const LINKEDIN_FOLD = 210;

const URL_RE = /https?:\/\/[^\s]+/g;
// Ranges X weights as 2: CJK, Hangul, fullwidth forms, and astral emoji.
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}]/u;

function charWeight(ch) {
  return WIDE_RE.test(ch) ? 2 : 1;
}

function countChars(text) {
  let total = 0;
  for (const ch of Array.from(String(text ?? ''))) total += charWeight(ch);
  return total;
}

/** Length as X measures it: URLs collapse to X_URL_WEIGHT, wide chars cost 2. */
export function weightedLength(text) {
  const value = String(text ?? '');
  let total = 0;
  let cursor = 0;
  for (const match of value.matchAll(URL_RE)) {
    total += countChars(value.slice(cursor, match.index));
    total += X_URL_WEIGHT;
    cursor = match.index + match[0].length;
  }
  total += countChars(value.slice(cursor));
  return total;
}

/** Cut to a weight budget at a word boundary, adding an ellipsis only if cut. */
export function trimToWeight(text, maxWeight) {
  const value = String(text ?? '').trim();
  if (!value || maxWeight <= 0) return '';
  if (countChars(value) <= maxWeight) return value;

  const ellipsis = '…';
  const budget = maxWeight - charWeight(ellipsis);
  if (budget <= 0) return '';

  const chars = Array.from(value);
  let used = 0;
  let end = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const w = charWeight(chars[i]);
    if (used + w > budget) break;
    used += w;
    end = i + 1;
  }
  let out = chars.slice(0, end).join('');
  // Drop a trailing partial word unless that would empty the string.
  const lastSpace = out.lastIndexOf(' ');
  if (lastSpace > 0 && out.length - lastSpace <= 18) out = out.slice(0, lastSpace);
  out = out.replace(/[\s,;:\-–—]+$/, '');
  return out ? out + ellipsis : '';
}

/** Normalise tags to `#Tag`, dedupe case-insensitively, cap the count. */
export function normalizeHashtags(list, max = 3) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)) {
    const word = String(raw || '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push('#' + word);
    if (out.length >= max) break;
  }
  return out;
}


/**
 * Compose an X post within `limit`, keeping the link intact.
 * @returns {{text: string, weighted: number, remaining: number, dropped: {excerpt: boolean, hashtags: boolean}}}
 */
export function composeXPost({ hook, excerpt, url, hashtags = [], limit = X_LIMIT } = {}) {
  const link = String(url || '').trim();
  if (!link) throw new Error('composeXPost needs a url');

  const head = String(hook || '').trim();
  const body = String(excerpt || '').trim();
  const tags = normalizeHashtags(hashtags);

  const assemble = ({ headText, bodyText, tagList }) => {
    const parts = [headText, bodyText, link].filter(Boolean);
    return parts.join('\n\n') + (tagList.length ? '\n\n' + tagList.join(' ') : '');
  };
  const result = (text, dropped) => ({
    text,
    weighted: weightedLength(text),
    remaining: limit - weightedLength(text),
    dropped
  });

  const dropped = { hashtags: false, excerpt: false, hookTrimmed: false };

  // 1. The full post.
  let text = assemble({ headText: head, bodyText: body, tagList: tags });
  if (weightedLength(text) <= limit) return result(text, dropped);

  // 2. Shed hashtags — they are the least valuable part of the post.
  if (tags.length) {
    dropped.hashtags = true;
    text = assemble({ headText: head, bodyText: body, tagList: [] });
    if (weightedLength(text) <= limit) return result(text, dropped);
  }

  // 3. Shed the excerpt.
  if (body) {
    dropped.excerpt = true;
    text = assemble({ headText: head, bodyText: '', tagList: [] });
    if (weightedLength(text) <= limit) return result(text, dropped);
  }

  // 4. Trim the hook around the link. The link is never touched.
  const budget = limit - weightedLength(link) - 4;
  const trimmed = trimToWeight(head, Math.max(0, budget));
  dropped.hookTrimmed = trimmed !== head;
  text = assemble({ headText: trimmed, bodyText: '', tagList: [] });
  return result(text, dropped);
}

/**
 * Compose the LinkedIn body. LinkedIn allows 3,000 characters and shows only the
 * first ~210 before "see more", so the hook has to lead and the link has to be
 * reachable without expanding.
 */
export function composeLinkedInPost({ hook, excerpt, url, hashtags = [], limit = LINKEDIN_LIMIT } = {}) {
  const link = String(url || '').trim();
  if (!link) throw new Error('composeLinkedInPost needs a url');

  const tags = normalizeHashtags(hashtags, 4);
  const head = String(hook || '').trim();
  const tagBlock = tags.length ? '\n\n' + tags.join(' ') : '';
  const excerptBudget = limit - head.length - link.length - tagBlock.length - 8;
  const body = excerptBudget > 40 ? trimToWeight(String(excerpt || '').trim(), excerptBudget) : '';

  let text = [head, body, link].filter(Boolean).join('\n\n') + tagBlock;
  if (text.length > limit) text = text.slice(0, limit);

  const fold = text.split('\n')[0] || '';
  return {
    text,
    length: text.length,
    foldLength: fold.length,
    // The hook is the only line guaranteed to be visible before "see more".
    foldRisk: fold.length > LINKEDIN_FOLD,
    // Assisted publishing: the human presses Post, not the agent. See
    // routes/socialPublish.js for why this is a rule, not a preference.
    assisted: true
  };
}
