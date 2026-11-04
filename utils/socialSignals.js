/**
 * Turning what the browser read into rows a human can act on (2026-11-04)
 *
 * Split from `utils/socialIntent.js` on purpose: that module answers "is this a signal", this
 * one answers "what do we store, and what do we refuse to store". The refusal rules are the
 * interesting half, because this table is a list of real people and a wrong row is a stranger
 * being messaged about something they never said.
 *
 * The rules, each of which is a bug that would otherwise ship:
 *
 *   1. **A post needs a URL.** If the adapter could not read the permalink, the tenant cannot go
 *      and check the quote, so there is no row — a signal nobody can verify is a rumour.
 *   2. **Excluded posts are not stored.** "Job vacancy" and "dealer ad" contain the trigger words
 *      for a fleet purchase. Storing them "for completeness" would put them in front of the
 *      tenant on a bad sort, and the tenant would send exactly one of them.
 *   3. **Duplicates are counted, not inserted.** Re-running the same search is normal; doubling
 *      the digest is not.
 */
import { dedupeByPostUrl, draftFirstLine, scorePost } from './socialIntent.js';
import { getSocialPlatform } from './browserActor/tasks/socialPlatforms.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The intent taxonomy, read from the repo rather than from the database.
 *
 * It is a curated list of twelve intents, not tenant data, so it belongs next to the code with
 * the rest of the market knowledge. Cached because it is read on every signal batch, and loud on
 * failure: a missing taxonomy means every post would score `null` and the digest would silently
 * be empty — which reads exactly like "nobody is talking about this".
 */
const TAXONOMY_PATH = path.resolve(import.meta.dirname, '..', 'data', 'aboss_social_intent_taxonomy.json');
let cachedTaxonomy = null;

export function loadTaxonomy(filePath = TAXONOMY_PATH) {
  if (cachedTaxonomy && filePath === TAXONOMY_PATH) return cachedTaxonomy;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed?.intents) || !parsed.intents.length) {
      throw new Error('the taxonomy has no intents');
    }
    if (filePath === TAXONOMY_PATH) cachedTaxonomy = parsed;
    return parsed;
  } catch (error) {
    console.error(`[signals] could not read the intent taxonomy (${filePath}): ${error?.message || error}`);
    return { intents: [], default_market: null, default_city_focus: [] };
  }
}

/** A single request from a worker carries at most this much: it is untrusted input. */
export const MAX_POSTS_PER_REQUEST = 40;
export const MAX_POST_TEXT = 3000;

function clamp(value, max) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function cleanUrl(value) {
  const raw = clamp(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // A LinkedIn post permalink is the only thing we can hand a tenant to verify. Anything else
    // (a tracker, a shortener) is dropped rather than followed.
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * What a worker is allowed to say about the posts it read.
 *
 * Unknown fields are dropped, text is bounded, and a post without a permalink or with a stub of
 * text is discarded: this body comes from a machine we do not control.
 */
export function sanitizeListeningPosts(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = [];
  for (const item of raw.slice(0, MAX_POSTS_PER_REQUEST)) {
    const postUrl = cleanUrl(item?.postUrl || item?.url);
    const postText = clamp(item?.postText || item?.text, MAX_POST_TEXT);
    if (!postUrl || !postText || postText.length < 20) continue;
    cleaned.push({
      postUrl,
      postText,
      authorName: clamp(item?.authorName, 120),
      authorHandle: clamp(item?.authorHandle, 80),
      profileUrl: cleanUrl(item?.profileUrl),
      locationHint: clamp(item?.locationHint, 120)
    });
  }
  // Same post twice in one batch is one post. The adapter already dedupes; a worker is not
  // trusted to have done it.
  return dedupeByPostUrl(cleaned);
}

/**
 * Score posts into rows, and say what was thrown away and why.
 *
 * @returns {{rows: object[], matched: number, notRelevant: number, excluded: number}}
 */
export function buildSignalRows({ posts, taxonomy, tenantId, platform = 'linkedin', runId = null, options = {} }) {
  const rows = [];
  let notRelevant = 0;
  let excluded = 0;

  for (const post of Array.isArray(posts) ? posts : []) {
    const scored = scorePost({
      text: post.postText,
      authorName: post.authorName,
      authorHandle: post.authorHandle,
      location: post.locationHint,
      postUrl: post.postUrl,
      profileUrl: post.profileUrl
    }, taxonomy, options);

    if (!scored) {
      notRelevant += 1;
      continue;
    }
    if (scored.exclusionHits.length) {
      // Rule 2: an excluded post is not a low-scoring signal, it is the wrong subject.
      excluded += 1;
      continue;
    }

    rows.push({
      tenant_id: tenantId,
      platform,
      post_url: post.postUrl,
      post_text: post.postText,
      author_name: post.authorName,
      author_handle: post.authorHandle,
      profile_url: post.profileUrl,
      location_hint: post.locationHint,
      intent_id: scored.intentId,
      intent_name: scored.intentName,
      buyer_signal_strength: scored.buyerSignalStrength,
      intent_score: scored.intentScore,
      confidence: scored.confidence,
      trigger_hits: scored.triggerHits,
      warm_hits: scored.warmHits,
      exclusion_hits: [],
      contact_email: scored.contactEmail,
      contact_phone: scored.contactPhone,
      recommended_channel: scored.recommendedChannel,
      draft_first_line: draftFirstLine({
        intentName: scored.intentName,
        authorName: post.authorName,
        authorHandle: post.authorHandle
      }).slice(0, getSocialPlatform(platform)?.draftLimit || 1000),
      run_id: runId
    });
  }

  return { rows, matched: rows.length, notRelevant, excluded };
}

/** Narrow a stored row to what the panel may see. */
export function publicSignal(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    authorName: row.author_name || null,
    authorHandle: row.author_handle || null,
    profileUrl: row.profile_url || null,
    postUrl: row.post_url,
    postText: String(row.post_text || '').slice(0, 600),
    intentId: row.intent_id,
    intentName: row.intent_name,
    score: Number(row.intent_score) || 0,
    confidence: row.confidence,
    triggerHits: Array.isArray(row.trigger_hits) ? row.trigger_hits : [],
    recommendedChannel: row.recommended_channel || null,
    draftFirstLine: row.draft_first_line || null,
    contactPhone: row.contact_phone || null,
    contactEmail: row.contact_email || null,
    status: row.status || 'new',
    capturedAt: row.captured_at || row.created_at || null
  };
}

export const SOCIAL_SIGNALS_TABLE = 'social_signals';

/**
 * What a tenant may set a signal to. `new` is what the listener writes; the rest are the tenant's
 * record of their own work, and no code path changes them.
 */
export const SIGNAL_STATUSES = Object.freeze(['new', 'drafted', 'sent', 'ignored']);

/**
 * The store.
 *
 * Insert is deliberately two-phase: read the URLs that already exist, then insert only the new
 * ones, then — if the unique constraint still fires because another run wrote the same post in
 * between — retry row by row. That last step is not theoretical: the referral capture lost a
 * whole 20-item batch to one 23505 on 2026-11-03, and the same shape of race exists here.
 */
export function createSocialSignalStore({ table }) {
  if (typeof table !== 'function') throw new Error('createSocialSignalStore needs a table() accessor');

  async function existingUrls({ tenantId, urls }) {
    const wanted = (Array.isArray(urls) ? urls : []).filter(Boolean);
    if (!tenantId || !wanted.length) return new Set();
    const { data, error } = await table()
      .select('post_url')
      .eq('tenant_id', tenantId)
      .in('post_url', wanted);
    if (error) throw error;
    return new Set((Array.isArray(data) ? data : []).map((row) => row.post_url));
  }

  /** @returns {{inserted: number, duplicates: number, failed: number}} */
  async function insertMany({ tenantId, rows }) {
    const list = (Array.isArray(rows) ? rows : []).filter((row) => row && row.post_url);
    if (!tenantId || !list.length) return { inserted: 0, duplicates: 0, failed: 0 };

    const already = await existingUrls({ tenantId, urls: list.map((row) => row.post_url) });
    const fresh = list.filter((row) => !already.has(row.post_url));
    if (!fresh.length) return { inserted: 0, duplicates: list.length, failed: 0 };

    const { data, error } = await table()
      .insert(fresh.map((row) => ({ ...row, tenant_id: tenantId })))
      .select('id');
    if (!error) {
      return { inserted: Array.isArray(data) ? data.length : fresh.length, duplicates: list.length - fresh.length, failed: 0 };
    }
    if (String(error.code || '') !== '23505') throw error;

    // One of these posts landed between the read and the write. Retry individually so a single
    // duplicate cannot lose the other thirty-nine.
    let inserted = 0;
    let duplicates = list.length - fresh.length;
    let failed = 0;
    for (const row of fresh) {
      const single = await table().insert({ ...row, tenant_id: tenantId }).select('id');
      if (!single.error) inserted += 1;
      else if (String(single.error.code || '') === '23505') duplicates += 1;
      else failed += 1;
    }
    return { inserted, duplicates, failed };
  }

  /** The digest: best first, then newest, and only what is still worth a human's time. */
  async function recent({ tenantId, limit = 12, minScore = 50, includeDone = false }) {
    let query = table()
      .select('*')
      .eq('tenant_id', tenantId)
      .gte('intent_score', Number(minScore) || 0)
      .order('intent_score', { ascending: false })
      .order('captured_at', { ascending: false })
      .limit(Math.max(1, Number(limit) || 12));
    if (!includeDone) query = query.neq('status', 'ignored');
    const { data, error } = await query;
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  /** Counts for the panel's one-line summary: how many are untouched, and how many sent. */
  async function summary({ tenantId }) {
    const { data, error } = await table()
      .select('status')
      .eq('tenant_id', tenantId)
      .gte('intent_score', 50);
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    const counts = { new: 0, drafted: 0, sent: 0, ignored: 0 };
    for (const row of rows) {
      const status = String(row.status || 'new');
      counts[status] = (counts[status] || 0) + 1;
    }
    return { total: rows.length, ...counts };
  }

  async function setStatus({ tenantId, id, status }) {
    const { data, error } = await table()
      .update({ status })
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  return { existingUrls, insertMany, recent, summary, setStatus };
}

