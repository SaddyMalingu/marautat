import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getContentJourney, getAllAngles } from '../utils/contentJourney.js';
// Composes angle copy from the offer's own fields when every AI provider is out
// of quota. Imported as a pure function so it can be unit-tested without a host.
import { composeAnglePost } from '../utils/angleFallback.js';
// One theme per page: model copy may never restyle the article (utils/articleHtml.js).
import { sanitizeArticleHTML, auditBlogHTML, escapeAttr, FRAGMENT_ONLY } from '../utils/articleHtml.js';
// Share-card copy for one published page. Pure module: the AI tier writes the
// hook/summary/excerpt when it is up, and the page's own words are used when it
// is not, so the Share screen never comes back empty on a dry tier.
import { deriveShareCard, buildSharePrompt, parseShareCard } from '../utils/postShare.js';
// The article brief (2026-10-25). The journey decides what each page is for;
// the brief decides how it is written — reader, scene, sentence shape, worked
// example, honest limitation, CTA — because the one-line prompts shipped until
// now produced heading-plus-bullets pages (283 audited pages, mostly outlines).
import { buildArticlePrompt, buildRepairPrompt, buildReviewPrompt } from '../utils/blogWriter.js';
// The referee. Measures what the draft actually delivered so a thin page cannot
// be reported as a success, and names the failures a repair prompt must fix.
import { analyzeArticle, qualityBrief, describeQuality } from '../utils/blogQuality.js';
// Each tenant writes in its own voice, resolved from its own settings or, when
// it has none, deterministically from its identity.
import { resolveTenantVoice } from '../utils/tenantVoice.js';
const __f = fileURLToPath(import.meta.url);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SITE = process.env.SITE_URL || 'https://alphadome.onrender.com';
const BLOG = path.join(process.cwd(), 'public', 'blog');
const IMG = path.join(process.cwd(), 'public', 'images', 'blog');

const VM = '<meta name="google-site-verification" content="nQc8r4A_tjZX4469pNlpTR5hf7bfjEazZtITnrrHZUU">';


export async function restoreFromDB() {
  try {
    if (!fs.existsSync(BLOG)) fs.mkdirSync(BLOG, { recursive: true });
    const { data, error } = await sb.from('blog_posts').select('*').eq('status', 'published');
    if (error) { console.error('[DB] Restore error:', error.message); return 0; }
    if (!data || !data.length) { console.log('[DB] No posts to restore'); return 0; }
    // The offer behind each page carries the CTA wording (and the job/buyer
    // split). Loaded once: a broken page rebuilt one-at-a-time used to pay an
    // extra round-trip each, and the first boot after the 2026-10-26 repair has
    // 105 of them.
    const offerIds = [...new Set(data.map((p) => p.opportunity_id).filter(Boolean))];
    const offers = new Map();
    if (offerIds.length) {
      const { data: offerRows, error: offerErr } = await sb.from('opportunities')
        .select('id, title, offer_type, cta_label')
        .in('id', offerIds);
      if (offerErr) console.warn('[DB] Offers unavailable, CTA falls back to the default: ' + offerErr.message);
      for (const row of offerRows || []) offers.set(row.id, row);
    }
    let rebuilt = 0;
    for (const post of data) {
      if (!post.html_content) continue;
      let html = post.html_content;
      // A page written before sanitizeArticleHTML() existed carries the model's
      // own <style> and can render white-on-white forever, because this restore
      // copies html_content byte-for-byte on every boot. Rebuild it from the
      // stored article body instead, and persist the repair.
      const audit = auditBlogHTML(html);
      if (!audit.ok && post.content) {
        try {
          const offer = post.opportunity_id
            ? (offers.get(post.opportunity_id) || { id: post.opportunity_id })
            : null;
          const fixed = buildHTML({
            title: post.title || post.slug,
            slug: post.slug,
            content: post.content,
            thumb: post.thumbnail_url || null,
            date: post.created_at || post.updated_at || null,
          }, offer);
          if (auditBlogHTML(fixed).ok) {
            html = fixed;
            rebuilt++;
            await sb.from('blog_posts').update({ html_content: fixed }).eq('slug', post.slug);
            console.warn('[DB] Rebuilt unreadable page ' + post.slug + ' (' + audit.issues.join(', ') + ')');
          } else {
            console.warn('[DB] Page still fails the audit after rebuild: ' + post.slug);
          }
        } catch (e) {
          console.warn('[DB] Rebuild failed for ' + post.slug + ': ' + e.message);
        }
      }
      fs.writeFileSync(path.join(BLOG, post.slug + '.html'), html, 'utf8');
    }
    console.log('[DB] Restored ' + data.length + ' posts' + (rebuilt ? ' (' + rebuilt + ' rebuilt from their article body)' : ''));
    return data.length;
  } catch (e) { console.error('[DB] Restore error:', e.message); return 0; }
}

function clean(c) {
  if (!c) return c;
  // Markdown and the HTML document guard both live in sanitizeArticleHTML(), so
  // every writer path (generation, duplicate retry, review, page rebuild) gets
  // the same rules from one place instead of three drifting copies.
  return sanitizeArticleHTML(c).replace(/\n{3,}/g, '\n\n').trim();
}

// Last failure reason from the AI provider, surfaced to callers so a tenant or
// operator can see *why* generation produced nothing without reading host logs.
let lastAiError = null;

// Provider fallback order: OpenRouter → Gemini → Groq → Cerebras → Mistral →
// OpenAI → HuggingFace. Any single key being present is enough to generate; set
// OPENROUTER_MODEL / GEMINI_MODEL / GROQ_MODEL / CEREBRAS_MODEL / MISTRAL_MODEL /
// OPENAI_MODEL / HF_MODEL to pin a specific model. Every provider below speaks the
// same OpenAI-compatible shape, so adding one is a key + a URL + a model list, not
// a new code path.
//
// Why the list got longer (live 2026-10-23, four keys on the host): "multi-model
// fallback" was true inside OpenRouter and false everywhere else — Gemini had one
// alias, so a tenant click could only ever land on `gemini-flash-latest`. When
// that alias went quiet for 15s the tier was dry with three other keys in hand
// (HF 402, OpenRouter's free pool 429/404). Three independent free tiers (Groq,
// Cerebras, Mistral) mean a Gemini-side quota or a slow alias is now a detour, not
// an outage.
// OpenRouter free-tier slugs are retired without notice — the 2026-10-22 outage
// was llama-3.1-8b-instruct:free answering 404 "This model is unavailable for
// free". Generation therefore falls through this list (see ai()) instead of
// dying with whichever slug expires. Pin OPENROUTER_MODEL to freeze one.
//
// Free tier limits are per model AND per upstream pool, so the list is also the
// rate-limit budget: a 429 on one slug must land on the next one (live 2026-10-22,
// gemma-4-31b "temporarily rate-limited upstream" blocked all 9 angles). Every
// slug below was free when it was added (https://openrouter.ai/api/v1/models),
// which is not a promise: `minimax/minimax-m3.1-flash:free` answered 404 hours
// later. A slug that 404s is retired for the life of the process by ai(), so a
// dead entry costs one request per deploy instead of one per angle.
export const OPENROUTER_FREE_MODELS = [
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m3.1-flash:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  // Same family as the first slug but a different upstream pool, so a gemma
  // throttle does not take out both.
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3.5-lightning:free',
  'poolside/laguna-s-2.1:free',
  // OpenRouter's own free router: last resort, it picks whatever free model is
  // healthy right now (its 429s clear as the pool rotates).
  'openrouter/free',
];

// Gemini's free tier is the zero-spend recovery path, so it gets the same
// treatment OpenRouter's slugs already had: a *list*, fastest first, not one
// alias to bet the run on.
//   gemini-flash-lite-latest  the light path — answers copy in ~1-2s
//   gemini-flash-latest       the alias the host ran on 2026-10-23; stronger and
//                             markedly slower (it burned a whole 15s slice with
//                             zero bytes on a Review that day)
// Both are the same free quota, so a 429 on one is a 429 on the other (the quota
// belongs to the Google Cloud project, not the slug) — but a *slow* or *retired*
// alias is slug-specific, which is exactly the failure that was unfixable with a
// single model. GEMINI_MODEL pins a model and still leads the list, same rule as
// OPENROUTER_MODEL: a pin is a preference, never a trap.
export const GEMINI_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
];

// Groq: free tier, no card, OpenAI-compatible, and the fastest first token of
// anything in this file (LPU inference). Its free limit is a *rate* limit, which
// is the cheap kind — it clears in a minute and the walk advances to the next
// slug meanwhile. Added 2026-10-23 10:40 after a live Review spent 15s on a silent
// Gemini alias and 13s on OpenRouter's throttled free pool with no copy produced.
export const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  // Smaller and separate pool: a 70B throttle must not take out the whole key.
  'llama-3.1-8b-instant',
  'openai/gpt-oss-20b',
];

// Cerebras: free tier, no card, OpenAI-compatible, wafer-scale inference (again
// very fast). Kept last among the free tiers because its free quota is the
// smallest of the three, so it is the backstop rather than the workhorse.
export const CEREBRAS_MODELS = [
  'llama3.1-8b',
  'gpt-oss-120b',
];

// Mistral La Plateforme (https://console.mistral.ai): free "experiment" tier, no
// card, OpenAI-compatible — a fourth independent company and the only one of them
// hosted in the EU. Slotted after Cerebras because its free tier is the most
// tightly rate-limited of the free options: a good last free step before paid
// OpenAI. Small models lead because a 9-angle run has to fit inside a per-minute
// cap; `mistral-large-latest` is the strongest and slowest fallback.
export const MISTRAL_MODELS = [
  'mistral-small-latest',
  'open-mistral-nemo',
  'mistral-large-latest',
];

// Which env var holds each provider's key. The Render dashboard is a text box, so
// a plausible spelling is a real risk, not a hypothetical: on 2026-10-23 the host
// was given `GROK_API_KEY` and `OPEN_ROUTER_API_KEY` — both keys valid, both
// invisible to this chain, and the only symptom would have been a tier that
// silently stayed missing (exactly how the 2026-10-22 outage hid behind a healthy
// `hf=true`). The canonical name leads; the spellings a human actually types still
// count. Keep in sync with PROVIDERS in scripts/check_ai_key.mjs and the boot log
// in server.js / utils/logger.js.
function keyFrom() {
  for (let i = 0; i < arguments.length; i++) {
    const v = process.env[arguments[i]];
    if (v && String(v).trim()) return String(v).trim();
  }
  return undefined;
}

// A pin leads its provider's list. Shared by every provider so the rule is one
// function instead of five copies that drift (the lesson of `54931a4`).
function pinnedFirst(pin, list) {
  return pin ? [pin, ...list.filter((m) => m !== pin)] : list.slice();
}

// A candidate that answers 404 is retired, not throttled: every later angle on
// this process would pay the same round-trip for the same answer. Live
// 2026-10-22 18:03: `minimax/minimax-m3.1-flash:free` 404'd on the first walk of
// the run (it was verified free earlier the same day). Per-process, so a redeploy
// re-probes the whole list.
const retiredModels = new Set();
export function getRetiredModels() { return Array.from(retiredModels); }

// A slug that emits no byte before its box closes is not slow, it is unusable.
// Live 2026-10-23 05:17-05:18, one tenant clicking Review, Review, Share:
// `nvidia/nemotron-3.5-lightning:free` was handed 13.1s, then 30.0s, then 13.5s
// and answered none of them — 56s of a three-click session re-proving the same
// silence, `POST …/review 200 - 16209ms` and `32230ms` both ending in "AI tier
// unavailable — copy unchanged". Two *fair* boxes with no byte retire the slug
// for the process, exactly like a 404. A *trickling* upstream is a different
// animal — it does emit bytes, just too slowly, and is cut by the box without
// ever being counted here.
const silentBoxes = new Map();
// Once a slug has sat out a fair box, the next attempt is a probe for recovery,
// not another full share of the deadline.
const STALL_PROBE_MS = 8000;
// 0 disables stall retirement (a silent slug is then re-boxed on every click).
function stallRetireAfter() {
  const n = Number(process.env.BLOG_AI_STALL_RETIRE_AFTER == null ? 2 : process.env.BLOG_AI_STALL_RETIRE_AFTER);
  return n > 0 ? n : 0;
}

// A *key* can die for reasons that outlive the angle. Live 2026-10-23 04:24-04:27:
// HF answered 402 "You have no remaining credits" on every call and Gemini's free
// tier answered 429 "You exceeded your current quota" on every call, yet each walk
// — nine angles, every Share, every Review — paid a fresh round trip to rediscover
// it. `POST …/review 200 - 31336ms` ended in "AI tier unavailable — copy unchanged".
// Worse, the fair share above counted those dead keys as providers that could still
// answer, so the one key that might work was left with a third of the deadline
// (Share: 15s/3 = 5s slices; Review: 45s/3 = 15s slices).
//   auth/billing (401/402/403, "no remaining credits") -> out for this process
//   daily free-tier quota (429 "exceeded your current quota") -> out for a while
// A plain 429 ("rate limit", "temporarily rate-limited upstream") is per-minute and
// stays eligible: that one really does clear, and the slug walk below handles it.
const providerCooldowns = new Map();
export function getProviderCooldowns() {
  return Array.from(providerCooldowns.entries()).map(function (entry) {
    return { name: entry[0], reason: entry[1].reason, permanent: !!entry[1].permanent };
  });
}
// Exposed for the offline suite: process-level state must not leak between cases.
export function resetRetiredModels() { retiredModels.clear(); providerCooldowns.clear(); silentBoxes.clear(); }

// Gemini's free tier resets daily, but a 429 can also be a per-minute limiter; five
// minutes stops a nine-angle run from re-probing without hiding a fast recovery.
// 0 disables the quota cooldown (every 429 is retried on the next angle).
function quotaCooldownMs() {
  const ms = Number(process.env.BLOG_PROVIDER_QUOTA_COOLDOWN_MS == null ? 300000 : process.env.BLOG_PROVIDER_QUOTA_COOLDOWN_MS);
  return ms > 0 ? ms : 0;
}

// 0 = retry this provider on the next angle; Infinity = not again this process.
function providerCooldownMs(status, text) {
  const probe = String(text || '') + ' ' + String(status || '');
  if (status === 401 || status === 403) return Infinity;
  if (status === 402 || /no remaining credits|insufficient.*(credit|balance)|invalid.*api[_ ]?key/i.test(probe)) return Infinity;
  if (/exceeded your current quota|check your plan and billing|daily limit/i.test(probe)) return quotaCooldownMs();
  return 0;
}

function coolDownProvider(name, status, text) {
  const ms = providerCooldownMs(status, text);
  if (!ms) return false;
  const existing = providerCooldowns.get(name);
  if (existing && existing.permanent) return true;
  const permanent = ms === Infinity;
  providerCooldowns.set(name, {
    until: permanent ? Infinity : Date.now() + ms,
    permanent,
    reason: permanent ? String(status || 'auth') + ' needs an account fix, not a retry' : 'quota ' + String(status || ''),
  });
  // Only on the transition: the walk asks once per slug during the same angle and
  // seven identical "cooling down" lines per angle is just noise.
  if (!existing) {
    console.warn('[AI] ' + name + (permanent
      ? ' retired for this process (' + (status || 'auth') + ') — no point re-probing every angle'
      : ' cooling down for ' + Math.round(ms / 1000) + 's (' + (status || 'quota') + ') — the other keys keep their full share'));
  }
  return true;
}

// 0 when the provider may be dialled now, else the moment it may be again.
function coolingUntil(p) {
  const c = providerCooldowns.get(p.name);
  if (!c) return 0;
  if (c.until !== Infinity && Date.now() >= c.until) { providerCooldowns.delete(p.name); return 0; }
  return c.until;
}

// A router slug carries no upstream latency promise: `openrouter/free` picks a
// model per request, and it held the *whole* per-attempt timeout twice on
// 2026-10-22 (13:55 → a 90s run took 109s; 18:03 → 30s of a 45s angle, after
// which Gemini was cut at 6.3s and HF never ran). A last-resort candidate gets a
// last-resort time box. 0 disables it.
function modelAttemptCapMs(slug) {
  if (slug !== 'openrouter/free') return Infinity;
  const cap = Number(process.env.BLOG_ROUTER_MODEL_CAP_MS == null ? 8000 : process.env.BLOG_ROUTER_MODEL_CAP_MS);
  return cap > 0 ? cap : Infinity;
}

const AI_PROVIDERS = [
  {
    name: 'openrouter',
    // OPENROUTER_KEY is the name the rest of the platform (server.js, kernel)
    // uses for the same credential — accept both so one key serves everything.
    // `OPEN_ROUTER_API_KEY` is the spelling the Render dashboard actually received
    // on 2026-10-23; see keyFrom().
    key: () => keyFrom('OPENROUTER_API_KEY', 'OPENROUTER_KEY', 'OPEN_ROUTER_API_KEY'),
    url: () => (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1') + '/chat/completions',
    models: () => {
      // A pin is a *preference*, not a trap. Live outage (2026-10-22): the host
      // had OPENROUTER_MODEL pinned to llama-3.1-8b-instruct:free, OpenRouter
      // retired that slug for free use, and every call answered 404 while three
      // working free models sat right here in the list. So the pin leads and the
      // verified free models still act as fallback.
      const pinned = process.env.OPENROUTER_MODEL;
      return pinnedFirst(pinned, OPENROUTER_FREE_MODELS);
    },
    headers: (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }),
  },
  {
    // Google AI Studio: free tier, no credit card, OpenAI-compatible endpoint.
    // This is the zero-spend recovery path when a paid account runs dry (the
    // 2026-10-22 HF 402 incident). Two slugs, fastest first (see GEMINI_MODELS):
    // live 2026-10-23 10:40 the key was healthy — the daily quota had reset, no
    // 429 anywhere — but `gemini-flash-latest` sent zero bytes for the whole 15s
    // slice, so Review still answered "AI tier unavailable — copy unchanged". One
    // alias is a single point of failure; a list makes it a slow candidate.
    name: 'gemini',
    key: () => process.env.GEMINI_API_KEY,
    url: () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai') + '/chat/completions',
    models: () => pinnedFirst(process.env.GEMINI_MODEL, GEMINI_MODELS),
    headers: (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }),
  },
  {
    // Groq (https://console.groq.com/keys): free tier, no card, OpenAI-compatible.
    // Fastest of the free tiers and the first fallback for Gemini because it fails
    // *fast* — a throttled Groq key answers 429 in ~100ms, so a dead free tier
    // costs the tenant a fraction of a second instead of 15s of silence.
    name: 'groq',
    // GROK_API_KEY is the misspelling the host was provisioned with on 2026-10-23;
    // a valid key under a wrong name is a silent outage, so it still counts.
    key: () => keyFrom('GROQ_API_KEY', 'GROK_API_KEY'),
    url: () => (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1') + '/chat/completions',
    models: () => pinnedFirst(process.env.GROQ_MODEL, GROQ_MODELS),
    headers: (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }),
  },
  {
    // Cerebras (https://cloud.cerebras.ai): free tier, no card, OpenAI-compatible.
    // A different company, a different quota, a different speed profile — which is
    // the whole point: "the provider is down" and "our account on that provider is
    // down" are different failures, and this is the cheapest way to survive both.
    name: 'cerebras',
    key: () => process.env.CEREBRAS_API_KEY,
    url: () => (process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1') + '/chat/completions',
    models: () => pinnedFirst(process.env.CEREBRAS_MODEL, CEREBRAS_MODELS),
    headers: (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }),
  },
  {
    // Mistral La Plateforme (https://console.mistral.ai): free experiment tier,
    // OpenAI-compatible. Slotted after Cerebras because its free tier is the most
    // tightly rate-limited of the free options — the last free step before paid
    // OpenAI. Added 2026-10-23, when a fourth key was provisioned on a host whose
    // tier had just answered zero copy from three of them.
    name: 'mistral',
    key: () => keyFrom('MISTRAL_API_KEY', 'MISTRALAI_API_KEY'),
    url: () => (process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1') + '/chat/completions',
    models: () => pinnedFirst(process.env.MISTRAL_MODEL, MISTRAL_MODELS),
    headers: (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }),
  },
  {
    name: 'openai',
    key: () => process.env.OPENAI_API_KEY,
    url: () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions',
    model: () => process.env.OPENAI_MODEL || 'gpt-4o-mini',
    headers: (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }),
  },
  {
    name: 'hf',
    key: () => keyFrom('HF_API_KEY', 'HF_API_KEY_WRITERS_FLOW'),
    url: () => (process.env.HF_BASE_URL || 'https://router.huggingface.co/v1') + '/chat/completions',
    model: () => process.env.HF_MODEL || 'meta-llama/Llama-3.1-8B-Instruct:novita',
    headers: (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }),
  },
];

// Billing / auth failures will fail for every angle, so there is no point
// burning the whole journey on them. Rate limits do NOT belong here: a 429 (or
// Gemini's "You exceeded your current quota") clears within a minute, so the
// journey should keep going instead of stopping after the first post.
const FATAL_AI = /(^|\D)(401|402|403)(\D|$)|no remaining credits|insufficient.*(credit|balance)|invalid.*(token|key)|unauthor|not authorized/i;
const TRANSIENT_AI = /(^|\D)(408|409|425|429|5\d\d)(\D|$)|rate limit|too many requests|quota|resource[_ ]exhausted|overloaded|timed? ?out|ECONNRESET|ETIMEDOUT|empty content/i;

let lastAiFatal = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A model can be unusable for this call while its siblings are healthy: the slug
// is retired (404) or its upstream is throttled (429 "temporarily rate-limited
// upstream", 5xx). Those must advance to the next model of the same provider —
// live 2026-10-22, one throttled gemma slug blocked all 9 angles. Auth/billing
// failures (401/402/403) do not change per model, so they stop the provider
// immediately instead of burning the rest of the list.
function shouldTryNextModel(status) {
  if (!status) return false;
  if (status === 404 || status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status <= 599;
}

// One exhausted provider must not abort the journey — only a chain where every
// attempted provider failed on auth/billing is hopeless. Regression this guards
// against (2026-10-22): HF answered 402 on every call while OpenRouter/Gemini
// answered fine, but the fail-fast tested the *joined* error string
// ("... | hf 402 ..."), so generation stopped after the first post.
function classifyFailure(status, text) {
  const probe = (status ? String(status) + ' ' : '') + (text || '');
  if (TRANSIENT_AI.test(probe)) return 'transient';
  if (FATAL_AI.test(probe)) return 'fatal';
  return 'unknown';
}

// Which provider served the last successful call. The WhatsApp reply path writes
// it to conversations.llm_provider, so a tenant's chat history says who answered
// instead of a generic "openrouter" label that may not be the one that ran.
let lastAiProvider = null;

// Exposed so verification scripts (scripts/test_ai_providers.mjs) can drive the
// fallback chain against a local stub instead of the real providers.
export function getLastAiError() { return lastAiError; }
export function isAiFailureFatal() { return lastAiFatal; }
export function getLastAiProvider() { return lastAiProvider; }

// `messages` is optional: callers that already build a chat stack (the WhatsApp
// reply path, which carries system prompt + tenant context + history) pass it in
// so they get *this* provider walk instead of keeping one of their own. The
// writers keep passing a single prompt string, exactly as before.
async function ai(prompt, deadline, messages) {
  const axios = (await import('axios')).default;
  const failures = [];
  const chatMessages = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: 'user', content: prompt }];
  // A stalled provider used to burn 120s per attempt, so a dry tier could hold
  // the tenant's request open for many minutes (live 2026-10-22: 9 angles, 4+
  // minutes and counting). Cap each attempt, and when the caller passes a
  // deadline, never start an attempt that cannot finish before it.
  const baseTimeout = Number(process.env.BLOG_AI_TIMEOUT_MS == null ? 30000 : process.env.BLOG_AI_TIMEOUT_MS);
  // The deadline also has to be *shared*, not merely respected by each call.
  // Live 2026-10-22 18:03 (90s run, 45s angle budget): OpenRouter answered 429/404
  // in a few seconds, then stalled 30s on the `openrouter/free` router — 37s of the
  // angle gone. Gemini, never tried, was aborted after 6.3s mid-call and HF was
  // skipped as "budget spent", so the tier reported dry and nine pages were
  // composed from the offer data. One provider's queue must not own the next
  // provider's chance: each keyed provider now gets an equal slice of what is
  // left, and time it does not use rolls into the following slice.
  const keyedProviders = AI_PROVIDERS.filter(function (q) { return !!q.key(); });
  // Only providers that could still answer claim a slice: a key that is out of
  // credits or out of daily quota must not shrink a healthy key's share. Live
  // 2026-10-23, three keyed providers and one alive meant Share got 5s slices and
  // Review 15s slices — the live key was cut mid-call while two corpses held the
  // rest of the deadline.
  let providersLeft = keyedProviders.filter(function (q) { return !coolingUntil(q); }).length;
  if (keyedProviders.length && !providersLeft) {
    // Nothing left to walk. Answer now instead of holding a Share/Review button
    // (or an angle) for 16-31s to rediscover a tier that is already known dead.
    const cooling = getProviderCooldowns();
    lastAiFatal = cooling.every(function (c) { return c.permanent; });
    lastAiError = 'every keyed provider is cooling down — ' +
      cooling.map(function (c) { return c.name + ' (' + c.reason + ')'; }).join(', ');
    console.error('[AI] ' + lastAiError + (lastAiFatal ? ' (fatal)' : ''));
    return null;
  }
  for (const p of AI_PROVIDERS) {
    const key = p.key();
    if (!key) continue;
    const until = coolingUntil(p);
    if (until) {
      const cool = providerCooldowns.get(p.name);
      failures.push({
        name: p.name, status: 0, kind: cool.permanent ? 'fatal' : 'transient',
        text: 'cooling down — ' + cool.reason +
          (until === Infinity ? ' (this process)' : ' (' + Math.ceil((until - Date.now()) / 1000) + 's left)'),
      });
      continue;
    }
    if (deadline && Date.now() >= deadline) {
      failures.push({ name: p.name, status: 0, text: 'skipped — run budget spent', kind: 'transient' });
      continue;
    }
    const shareEnd = deadline
      ? Date.now() + Math.max(1000, Math.floor((deadline - Date.now()) / Math.max(1, providersLeft)))
      : 0;
    providersLeft--;
    const models = (typeof p.models === 'function' ? p.models() : [p.model()])
      .filter(function (m) { return !retiredModels.has(m); });
    let failure = null;
    if (!models.length) {
      failures.push({ name: p.name, status: 0, text: 'every model slug retired for this process', kind: 'transient' });
      continue;
    }
    for (let mi = 0; mi < models.length; mi++) {
      const limit = deadline ? Math.min(deadline, shareEnd) : 0;
      const remaining = limit ? limit - Date.now() : baseTimeout;
      if (deadline && remaining < 1000) {
        failure = { name: p.name, status: 0, text: 'out of time before ' + models[mi], kind: 'transient' };
        break;
      }
      // `timeout` alone is not a wall-clock bound: in Node it is a *socket
      // inactivity* timeout, so a provider that trickles its response keeps the
      // socket "active" and the value is never reached. Live 2026-10-22 13:55 the
      // openrouter/free attempt started with 12.8s of run budget left and answered
      // 30.7s later (the whole BLOG_AI_TIMEOUT_MS), so a 90s run finished in 108s
      // and the tenant waited 109s. The AbortController is the hard bound: it
      // destroys the socket at the deadline even mid-response.
      const budget = Math.max(1, Math.min(
        baseTimeout,
        remaining,
        modelAttemptCapMs(models[mi]),
        silentBoxes.has(models[mi]) ? STALL_PROBE_MS : Infinity
      ));
      const ctl = new AbortController();
      const timer = setTimeout(function () { ctl.abort(); }, budget);
      // Did the upstream send anything at all? An abort with bytes behind it is a
      // slow model; an abort with nothing is a dead one. axios reports progress per
      // chunk, before the body is parsed — exactly the signal needed to tell them
      // apart (live 2026-10-23: nemotron-3.5-lightning sent 0 bytes in 30s).
      let sawBytes = false;
      try {
        const r = await axios.post(p.url(), {
          model: models[mi],
          messages: chatMessages,
          max_tokens: 3000,
          temperature: 0.7,
        }, {
          headers: p.headers(key), timeout: budget, signal: ctl.signal,
          onDownloadProgress: function (e) { if (e && e.loaded > 0) sawBytes = true; },
        });
        const content = r.data?.choices?.[0]?.message?.content || null;
        if (!content) {
          failure = { name: p.name, status: 200, text: 'empty content (' + models[mi] + ')', kind: 'transient' };
          // A model that answers 200 with nothing (reasoning models running out
          // of tokens, filtered output) is as unusable as a retired slug: try the
          // next candidate before giving up on the provider.
          if (mi < models.length - 1) { failure = null; continue; }
          break;
        }
        if (failures.length || mi > 0) {
          console.log('[AI] ' + p.name + ' served with ' + models[mi] +
            (failures.length ? ' after ' + failures.length + ' failed provider(s)' : ''));
        }
        lastAiError = null;
        lastAiFatal = false;
        // Which provider actually served. This was declared (line 350) and never
        // assigned, so the WhatsApp path's `conversations.llm_provider` recorded
        // "chain" for every reply — including the ones OpenRouter and Gemini
        // answered. Set before returning so the caller's log cannot disagree with
        // the walk that ran.
        lastAiProvider = p.name;
        return content;
      } catch (e) {
        // Our own timer fired, not the provider: the run budget ran out mid-call.
        // Nothing else on this key can finish, so stop walking its models.
        if (ctl.signal.aborted) {
          const slug = models[mi];
          const strikes = silentBoxes.get(slug) || 0;
          // Only a box that was a real chance is evidence: an attempt cut to 2s by a
          // neighbour's share says nothing about the model behind it.
          const fair = budget >= Math.min(baseTimeout, STALL_PROBE_MS);
          const silent = !sawBytes && fair;
          const silentCount = silent ? strikes + 1 : strikes;
          if (silent) silentBoxes.set(slug, silentCount);
          failure = {
            name: p.name, status: 0, kind: 'transient',
            text: 'aborted after ' + (budget / 1000).toFixed(1) + 's (' + slug + ') — time box spent',
          };
          const retireAfter = stallRetireAfter();
          if (silent && retireAfter && silentCount >= retireAfter) {
            // Same verdict as a 404, different evidence: the slug had its time and
            // produced nothing, so the next click must not pay for it again.
            retiredModels.add(slug);
            console.warn('[AI] ' + p.name + ' retired ' + slug + ' (no bytes in ' + silentCount +
              ' time boxes) — dropped for this process');
          } else {
            console.warn('[AI] ' + p.name + ' ' + slug + ' aborted after ' + (budget / 1000).toFixed(1) +
              's — time box spent, next provider keeps its own share of the run budget');
          }
          break;
        }
        const status = e.response?.status;
        const raw = e.response?.data;
        const body = raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw)) : '';
        const text = (body || e.message || '').slice(0, 240);
        failure = { name: p.name, status: status || 0, text, kind: classifyFailure(status, text) };
        // A key that says "no remaining credits" or "exceeded your current quota"
        // will say the same on the next angle, and until it is skipped it keeps
        // claiming a third of somebody else's deadline.
        const cooled = coolDownProvider(p.name, status, text);
        // Every slug on one key reads the same billing/quota counter, so once the
        // key is out the rest of the list is dead too: don't spend the provider's
        // whole share proving it seven times (live 2026-10-23: 6.9s of naps and
        // seven 429s per angle, on three dead keys, per angle, forever).
        if (cooled) break;
        // A 404 is deterministic for that slug, so remember it for the process
        // instead of re-paying the round-trip on every angle of every run.
        if (status === 404 && !retiredModels.has(models[mi])) {
          retiredModels.add(models[mi]);
          console.warn('[AI] ' + p.name + ' retired ' + models[mi] + ' (404) — dropped for this process');
        }
        // A retired free slug answers 404 ("This model is unavailable for
        // free") and a throttled one answers 429 ("temporarily rate-limited
        // upstream"). Neither is a reason to abandon the other models on the
        // same key: advance to the next candidate, pausing briefly on a 429 so
        // the retry does not immediately hit the same limiter.
        if (shouldTryNextModel(status) && mi < models.length - 1) {
          const step = 400 * (mi + 1);
          console.warn('[AI] ' + p.name + ' model ' + models[mi] + ' unusable (' + (status || 'err') +
            ') — trying ' + models[mi + 1]);
          if (status === 429) {
            // Pause so the retry does not hit the same limiter, but never nap away
            // the last second of the slice: live 2026-10-23 the 400-1500ms naps
            // (6.9s across seven slugs) ate most of a 5s Share slice before the
            // walk was halfway down the list.
            const nap = Math.min(step, 800);
            const left = limit ? limit - Date.now() : Infinity;
            if (left > nap + 400) await sleep(nap);
          }
          failure = null;
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    if (failure) failures.push(failure);
  }
  // Only hopeless when every provider we could try said auth/billing. A single
  // dead provider next to a healthy one must never stop the journey.
  lastAiFatal = failures.length === 0 || failures.every(function (f) { return f.kind === 'fatal'; });
  lastAiError = failures.length
    ? failures.map(function (f) { return ((String(f.name) + ' ' + (f.status || '')).trim() + ' ' + f.text).slice(0, 240); }).join(' | ').slice(0, 900)
    : 'no AI provider key configured (OPENROUTER_API_KEY / GEMINI_API_KEY / GROQ_API_KEY / CEREBRAS_API_KEY / MISTRAL_API_KEY / OPENAI_API_KEY / HF_API_KEY)';
  console.error('[AI] All providers failed →', lastAiError, '(fatal=' + lastAiFatal + ')');
  return null;
}
export { ai };

async function genImage(prompt, slug) {
  try {
    const t = process.env.REPLICATE_API_TOKEN;
    if (!t) { console.log('[IMG] No key'); return null; }
    const { default: Replicate } = await import('replicate');
    const rep = new Replicate({ auth: t });
    const out = await rep.run('google/nano-banana-pro', { input: { prompt: 'Professional blog header: ' + prompt + '. Modern, clean, tech workspace. 16:9, no text.' } });
    if (!fs.existsSync(IMG)) fs.mkdirSync(IMG, { recursive: true });
    const axios = (await import('axios')).default;
    const res = await axios.get(out, { responseType: 'arraybuffer' });
    fs.writeFileSync(path.join(IMG, slug + '.png'), res.data);
    console.log('[IMG] Generated: ' + slug);
    return '/images/blog/' + slug + '.png';
  } catch (e) { console.error('[IMG] Error:', e.message); return null; }
}

function isDuplicate(content, existing) {
  const norm = content.toLowerCase().replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  for (const e of existing) {
    const en = e.toLowerCase().replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const w1 = new Set(norm.split(' '));
    const w2 = new Set(en.split(' '));
    const inter = new Set([...w1].filter(x => w2.has(x)));
    if (inter.size / Math.max(w1.size, w2.size) > 0.5) return true;
  }
  return false;
}

// One offer must never run two journeys at once. Live 2026-10-22 a tenant's
// double click (on top of an interrupted verifier run) put two walks on the same
// offer: they rate-limited each other on the shared free tier, both stretched
// past 14 minutes, and the pages that did get written could not be saved (the
// offer had been deleted underneath them). A per-offer lock answers the second
// call immediately instead of competing with the first.
const inFlightOffers = new Set();

// A tenant's voice, resolved once per journey.
//
// `bot_tenants` is the identity the portal logs in with; `site_tenants` is the
// blog's own row and the natural home for an explicit `brand_voice` / `tone`;
// `bot_templates.tone` is the third source and it is the one field a tenant has
// already filled in for its WhatsApp bot. Every lookup is best-effort: a host
// whose schema predates a column, or a template table that does not exist, must
// still generate with the house voice rather than fail the run.
async function loadTenantVoice(offer) {
  var site = null, tenant = null, botTemplate = null;
  if (offer && offer.tenant_id) {
    try {
      var siteRes = await sb.from('site_tenants').select('*').eq('id', offer.tenant_id).maybeSingle();
      if (!siteRes.error) site = siteRes.data;
      else console.warn('[GEN] Voice: site_tenants unavailable (' + siteRes.error.message + ') — using the house voice');
    } catch (e) {
      console.warn('[GEN] Voice: site_tenants lookup failed (' + e.message + ')');
    }
  }
  if (site && site.client_phone) {
    try {
      var tenantRes = await sb.from('bot_tenants')
        .select('id, client_name, client_phone').eq('client_phone', site.client_phone).maybeSingle();
      if (!tenantRes.error) tenant = tenantRes.data;
    } catch (e) { /* identity is optional */ }
  }
  if (tenant && tenant.id) {
    try {
      var tplRes = await sb.from('bot_templates')
        .select('tone, system_prompt').eq('bot_tenant_id', tenant.id).eq('is_default', true).maybeSingle();
      if (tplRes.error) {
        // is_default may not exist on an older shape; any template still carries a tone.
        tplRes = await sb.from('bot_templates').select('tone, system_prompt').eq('bot_tenant_id', tenant.id).limit(1).maybeSingle();
      }
      if (!tplRes.error) botTemplate = tplRes.data;
    } catch (e) { /* tone is optional */ }
  }
  var voice = resolveTenantVoice({ site: site, tenant: tenant, botTemplate: botTemplate, offer: offer });
  console.log('[GEN] Voice: ' + voice.id + ' (' + voice.source + ') for ' + voice.brand +
    (voice.industry ? ' — ' + voice.industry : ''));
  return voice;
}

// What the portal is allowed to show about the voice. The full prompt block is
// an internal instruction and must not travel to the browser.
function voiceMeta(voice) {
  if (!voice) return null;
  return { id: voice.id, label: voice.label, brand: voice.brand, source: voice.source };
}



export async function generateBlogPostsForOpportunity(oppId, opts) {
  const runKey = oppId ? String(oppId) : null;
  if (runKey && inFlightOffers.has(runKey)) {
    console.warn('[GEN] Refused a second run for ' + runKey + ' — one is already in progress');
    return {
      success: false,
      busy: true,
      posts: [],
      error: 'Blog generation is already running for this offer. Wait for it to finish — a second run would only rate-limit the first one.',
    };
  }
  if (runKey) inFlightOffers.add(runKey);
  try {
    return await generateJourney(oppId, opts);
  } finally {
    if (runKey) inFlightOffers.delete(runKey);
  }
}

async function generateJourney(oppId, opts) {
  opts = opts || {};
  var rev = opts.review !== false, img = opts.images !== false;
  var d = await sb.from('opportunities').select('*').eq('id', oppId).single();
  var o = d.data;
  if (!o) return { error: 'Not found' };
  if (!fs.existsSync(BLOG)) fs.mkdirSync(BLOG, { recursive: true });
  console.log('[GEN] ' + o.title);
  var existing = [];
  if (fs.existsSync(BLOG)) {
    var ef = fs.readdirSync(BLOG).filter(function(x){return x.endsWith('.html') && x !== 'index.html';});
    existing = ef.map(function(f){return fs.readFileSync(path.join(BLOG, f), 'utf8');});
  }
  var journey = getContentJourney(o);
  // One voice for the whole journey: nine pages under nine voices would read
  // like nine different businesses.
  var voice = await loadTenantVoice(o);
  var journeyTitles = journey.map(function (p) { return p.title; });
  var res = [];
  var attempts = 0;
  var skipped = [];
  // Free-tier models rate-limit per minute, so a 9-angle journey must not fire
  // nine back-to-back requests. Pace them; set BLOG_ANGLE_DELAY_MS=0 to disable
  // on a paid key.
  var angleDelay = Number(process.env.BLOG_ANGLE_DELAY_MS == null ? 1200 : process.env.BLOG_ANGLE_DELAY_MS);
  // A dead AI tier must not leave the tenant with nothing: each angle can also
  // be composed from the offer's own fields (utils/angleFallback.js). Set
  // BLOG_FALLBACK_MODE=off to restore the loud failure when diagnosing.
  var allowFallback = String(process.env.BLOG_FALLBACK_MODE == null ? 'auto' : process.env.BLOG_FALLBACK_MODE).toLowerCase() !== 'off';
  // Latency budget: when the tier is throttled, every angle costs the full
  // provider walk (7 OpenRouter slugs x up to 1.5s of 429 backoff) before it can
  // be composed locally. Nine of those is a ~2 minute request in front of a
  // tenant who is watching a spinner. Two consecutive angles with nothing from
  // any provider is enough evidence that the tier is dry for this run: compose
  // the rest immediately. This is a per-run decision only — the next run tries
  // AI again. Set BLOG_AI_MAX_MISSES=0 to always walk every angle.
  var maxMisses = Number(process.env.BLOG_AI_MAX_MISSES == null ? 2 : process.env.BLOG_AI_MAX_MISSES);
  // A miss count cannot bound latency on its own: a provider that accepts the
  // connection and then stalls burns a whole attempt (BLOG_AI_TIMEOUT_MS) before
  // it counts as one miss. Live 2026-10-22 the journey wrote 1 of 9 pages in 6
  // minutes and the tenant's request was still open. So a wall-clock budget also
  // bounds the walk, and it bounds it *unconditionally*: the earlier rule only
  // applied it once an angle had missed, which sounds safe ("a healthy run is
  // never cut short") but is not. Live 2026-10-22 13:10 the tier answered one
  // angle out of nine, the other eight only after their full 45s walk, and
  // `misses` kept resetting on the one success — 166s on the wire with 8 pages
  // composed locally anyway. The budget has to be a ceiling, not a hint.

  var budgetMs = Number(process.env.BLOG_RUN_BUDGET_MS == null ? 90000 : process.env.BLOG_RUN_BUDGET_MS);
  // The run budget alone is not enough: it is only consulted between angles, and
  // one angle walks up to seven candidate models of the same key. Live
  // 2026-10-22 an angle cost 37s (5 models, one of them stalled 23s before the
  // 429), so a single angle could hold the request for minutes before the miss
  // counter even moved. Cap the angle, not just the attempt.
  var angleBudget = Number(process.env.BLOG_ANGLE_BUDGET_MS == null ? 45000 : process.env.BLOG_ANGLE_BUDGET_MS);
  var runStart = Date.now();
  var deadline = budgetMs > 0 ? runStart + budgetMs : 0;
  var misses = 0;
  var aiUsable = true;
  var fromTemplate = 0;
  lastAiError = null;
  for (var i = 0; i < journey.length; i++) {
    var post = journey[i];
    console.log('[GEN] - [' + post.angleName + '] ' + post.title);
    attempts++;
    var content = null;
    if (aiUsable && maxMisses > 0 && misses >= maxMisses) {
      aiUsable = false;
      console.warn('[GEN] AI returned nothing for ' + misses + ' angle(s) in a row — composing the rest from the offer data ' +
        '(BLOG_AI_MAX_MISSES=' + maxMisses + ', last error: ' + (lastAiError || 'none') + ')');
    } else if (aiUsable && budgetMs > 0 && Date.now() - runStart > budgetMs) {
      aiUsable = false;
      console.warn('[GEN] AI budget spent (' + Math.round((Date.now() - runStart) / 1000) + 's of ' +
        Math.round(budgetMs / 1000) + 's, BLOG_RUN_BUDGET_MS) — composing the remaining angles from the offer data');
    }
    // Tightest cap that applies to this angle: the per-angle slice, and the run
    // deadline, which is a hard ceiling for the whole request. Each AI call gets
    // its own slice, so a fast compose never squeezes out the review pass, but
    // no call may run past the run deadline however well the tier is behaving.
    var capFor = function () {
      var cs = [];
      if (angleBudget > 0) cs.push(Date.now() + angleBudget);
      if (budgetMs > 0) cs.push(deadline);
      return cs.length ? Math.min.apply(null, cs) : 0;
    };
    var angleDeadline = capFor();
    // The commission for this page, replacing the journey's one-line prompt.
    // `siblings` keeps nine pages from repeating each other's angle.
    var siblings = journeyTitles.filter(function (t) { return t !== post.title; });
    var prompt = buildArticlePrompt({ offer: o, post: post, voice: voice, siblings: siblings });
    if (aiUsable) {
      if (i > 0 && angleDelay > 0) await sleep(angleDelay);
      // The cap is recomputed per call and always includes the run deadline, so
      // no single AI call — first angle, duplicate retry or review — can push the
      // journey past BLOG_RUN_BUDGET_MS.
      content = await ai(prompt, angleDeadline);
      if (content) { content = clean(content); misses = 0; } else { misses++; }
    }
    var composed = false;
    if (!content) {
      if (!allowFallback) {
        skipped.push({ slug: post.slug, angle: post.angleName, error: lastAiError });
        if (isAiFailureFatal()) {
          console.error('[GEN] Aborting after [' + post.angleName + '] — every provider failed on auth/billing: ' + lastAiError);
          break;
        }
        console.log('[GEN] Failed: ' + post.slug + ' — continuing with next angle');
        continue;
      }
      content = composeAnglePost(o, post);
      composed = true;
      fromTemplate++;
      // Provider-wide failures will fail for every remaining angle too, so stop
      // paying the per-angle delay and the round trips.
      if (isAiFailureFatal()) aiUsable = false;
      console.warn('[GEN] AI unavailable for [' + post.angleName + '] (' + (aiUsable ? 'transient' : 'provider-wide') +
        ') — composed from the offer data');
    } else if (isDuplicate(content, existing)) {
      content = await ai(prompt + ' This must be completely different from the other pages in the series — different opening scene, different examples.', capFor());
      if (content) content = clean(content);
    }
    // The quality gate. Valid HTML can still be an outline, which is exactly what
    // the 283-page audit found. Score the draft and spend one call on a targeted
    // rewrite when it fails. Skipped when the tier is already known dry, when the
    // copy was composed locally (that copy is prose by construction) or when the
    // run budget cannot afford a second call for this page.
    var quality = analyzeArticle(content);
    var repairHeadroom = budgetMs <= 0 || Date.now() - runStart < budgetMs * 0.75;
    if (!composed && aiUsable && !lastAiError && !quality.ok && repairHeadroom) {
      var repaired = await ai(buildRepairPrompt({
        offer: o, post: post, voice: voice, draft: content, issues: qualityBrief(quality),
      }), capFor());
      if (repaired) {
        var candidate = clean(repaired);
        var candidateQuality = analyzeArticle(candidate);
        if (candidateQuality.score > quality.score) {
          console.log('[GEN] Repaired ' + post.slug + ': ' + describeQuality(quality) + ' → ' + describeQuality(candidateQuality));
          content = candidate;
          quality = candidateQuality;
        } else {
          console.warn('[GEN] Repair did not improve ' + post.slug + ' (' + describeQuality(candidateQuality) + ') — keeping the draft');
        }
      }
    }
    if (!composed) {
      console.log('[GEN] Quality ' + post.slug + ': ' + describeQuality(quality) + (quality.ok ? '' : ' — below target, published anyway'));
    }
    // The review pass is a second AI call per post, so it can double the cost of
    // an angle. Skip it when the writer is out of quota (lastAiError set), when
    // the text was composed locally, or when most of the run budget is spent —
    // spending the last of it polishing page 3 means pages 4-9 fall back to
    // composed copy. Same total time, more AI-written pages.
    var reviewHeadroom = budgetMs <= 0 || Date.now() - runStart < budgetMs * 0.6;
    if (rev && !composed && !lastAiError && reviewHeadroom) {
      content = await reviewContent(content, post.title, capFor(), { offer: o, post: post, voice: voice, analysis: quality });
      quality = analyzeArticle(content);
    }
    var thumb = null;
    if (img) thumb = await genImage(o.title + ' ' + post.angleName, post.slug);
    var postData = { title: post.title, slug: post.slug, content: content, thumb: thumb };
    fs.writeFileSync(path.join(BLOG, post.slug + '.html'), buildHTML(postData, o), 'utf8');
    await saveToDB(postData, o, post.angle);
    existing.push(content);
    res.push({
      title: post.title, slug: post.slug, angle: post.angleName,
      url: SITE + '/blog/' + post.slug + '.html', thumb: thumb, fallback: composed,
      // Surfaced so the tenant portal and the verifier can say *what* a page
      // scored instead of only "generated".
      quality: { score: quality.score, words: quality.words, ok: quality.ok, issues: quality.issues.map(function (x) { return x.code; }) },
    });
  }
  updateIndex();
  // mode tells the tenant (and the verifier) what actually happened: 'ai' when
  // every angle came from a model, 'template' when the AI tier was unavailable
  // and the copy was composed from the offer, 'mixed' when a run recovered.
  var mode = fromTemplate === 0 ? 'ai' : (fromTemplate >= res.length ? 'template' : 'mixed');
  console.log('[GEN] Done: ' + res.length + '/' + journey.length + ' posts in ' +
    Math.round((Date.now() - runStart) / 1000) + 's' +
    (budgetMs > 0 ? ' of ' + Math.round(budgetMs / 1000) + 's budget' : ' (no BLOG_RUN_BUDGET_MS)') +
    (fromTemplate ? ' (' + fromTemplate + ' composed from offer data — AI tier unavailable)' : '') +
    (skipped.length ? ' (' + skipped.length + ' angle(s) skipped)' : ''));
  if (!res.length) {
    // Every angle produced nothing (missing/invalid LLM key, model unavailable,
    // rate limit). Report failure instead of a false "success" so callers such
    // as /tenant/blogger/offers/:id/blog can surface a real error.
    console.warn('[GEN] No posts generated for ' + o.slug + ' (' + attempts + ' of ' + journey.length + ' angles attempted)');
    return {
      success: false,
      posts: [],
      attempted: attempts,
      skipped: skipped,
      mode: mode,
      error: 'No posts generated — the AI writer returned nothing (' + attempts + ' of ' +
        journey.length + ' angles attempted). Check GEMINI_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / HF_API_KEY and model credits, or unset BLOG_FALLBACK_MODE=off to compose posts from the offer data instead.' +
        (lastAiError ? ' Last AI error: ' + lastAiError : '')
    };
  }
  // Partial journeys are still a success, but callers must be able to show
  // *why* an angle was skipped (free-tier rate limits) and *what* was written
  // (voice + quality) instead of guessing.
  return { success: true, posts: res, attempted: attempts, skipped: skipped, mode: mode, fallback: fromTemplate, voice: voiceMeta(voice) };
}






// The review pass, with the outcome it actually had. A tenant pressing Review
// must not be told "polished" when every provider was dry and the page came back
// byte-for-byte unchanged — so the caller gets `ai:false` instead of a silent
// no-op. Generation still calls reviewContent() and only wants the copy.
async function reviewContentWithStatus(content, title, deadline, opts) {
  try {
    opts = opts || {};
    const before = analyzeArticle(content);
    // The old prompt ("Review and improve this blog post. Remove ALL asterisks…")
    // asked only for hygiene, so a polished page could still be a bullet-point
    // outline. The brief now carries the tenant's voice and the measured failures.
    const prompt = buildReviewPrompt({
      offer: opts.offer,
      post: opts.post || { title: title },
      voice: opts.voice,
      content: content,
      issues: before.ok ? '' : qualityBrief(before),
    });
    const improved = await ai(prompt, deadline);
    if (!improved || !String(improved).trim()) return { content, ai: false };
    // The review pass writes the page body verbatim (generation assigns its
    // result straight into post.content), so it gets the same document guard as
    // the first draft — otherwise "polish" could reintroduce the model's own
    // <style> and turn a readable page white again.
    const next = sanitizeArticleHTML(improved);
    // A polish that shortens the page into an outline is not an improvement, and
    // the tenant pressed Review to get a better page, not a different one.
    const after = analyzeArticle(next);
    if (after.score < before.score) {
      console.warn('[REVIEW] Rejected a polish that scored lower (' + describeQuality(before) + ' → ' + describeQuality(after) + ')');
      return { content, ai: false, rejected: true, before, after };
    }
    return { content: next, ai: true, before, after };
  } catch (e) { return { content, ai: false }; }
}

async function reviewContent(content, title, deadline, opts) {
  const result = await reviewContentWithStatus(content, title, deadline, opts);
  return result.content || content;
}

const OFFER_CTA = { job: 'Apply Now', product: 'Shop Now', service: 'Learn More', brand: 'Explore', affiliate: 'Get Deal', course: 'Enroll' };
const BLOG_STYLE = ':root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}'
  + '*{box-sizing:border-box;margin:0;padding:0}'
  + 'body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}'
  + '.c{max-width:800px;margin:0 auto;padding:0 24px}'
  + 'nav{padding:1rem 0}nav a{color:var(--accent);text-decoration:none}'
  + 'h1{font-size:2rem;margin:1rem 0}'
  + 'h2{font-size:1.4rem;color:var(--accent);margin:1.5rem 0 .75rem}'
  + 'h3{font-size:1.15rem;margin:1.25rem 0 .5rem}'
  + 'p,li{color:var(--muted)}'
  + 'ul,ol{padding-left:1.5rem;margin:.5rem 0}'
  + 'table{width:100%;border-collapse:collapse;margin:1rem 0}'
  + 'th,td{border:1px solid rgba(255,255,255,.18);padding:.5rem .75rem;text-align:left;color:var(--muted)}'
  + 'th{background:rgba(255,255,255,.06);color:var(--text)}'
  + 'img{max-width:100%;border-radius:8px;margin:1rem 0}';

export function buildHTML(post, job) {
  const id = job?.id;
  const cta = (job && job.cta_label) || OFFER_CTA[job && job.offer_type] || 'Apply Now';
  const availLine = (job && job.offer_type && job.offer_type !== 'job') ? 'This offer is available now.' : 'This opportunity is available now.';
  // The article body is the only model-authored HTML on the page, so it is the
  // only place a stray <style>/<html>/white background can arrive. Sanitising it
  // here — and not just in clean() — is what protects pages rebuilt from stored
  // html_content (restoreFromDB, reviewBlog, repairBlogHTML).
  const body = sanitizeArticleHTML(post.content);
  const title = escapeAttr(post.title || post.slug);
  const plain = String(body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const desc = escapeAttr(plain.substring(0, 160));
  const thumb = post.thumb ? escapeAttr(post.thumb) : '';
  const img = thumb ? '<img src="' + thumb + '" alt="' + title + '" style="width:100%;max-height:350px;object-fit:cover;border-radius:8px;margin:1rem 0">' : '';
  const rt = Math.max(1, Math.ceil(plain.split(' ').filter(Boolean).length / 200));
  // A rebuilt page must keep the date it was published, not the day of the
  // repair: restoreFromDB()/repair_blog_html.js pass the row's own timestamp.
  const pubDate = post.date ? new Date(post.date).toLocaleDateString() : new Date().toLocaleDateString();
  const VM = '<meta name="google-site-verification" content="nQc8r4A_tjZX4469pNlpTR5hf7bfjEazZtITnrrHZUU">';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' + VM + '<title>' + title + ' | AlphaDome</title><meta name="description" content="' + desc + '"><link rel="canonical" href="' + (process.env.SITE_URL || 'https://alphadome.onrender.com') + '/blog/' + post.slug + '.html"><style>' + BLOG_STYLE + '</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / <a href="/ai-jobs">AI Jobs</a> / <a href="/blog">Blog</a></nav><article><h1>' + title + '</h1><p style="color:var(--muted)">Published ' + pubDate + ' | ' + rt + ' min read</p>' + img + body + '</article><div style="text-align:center;padding:2rem;margin:2rem 0;background:rgba(255,255,255,.05);border-radius:12px"><h2>Ready to Start?</h2><p>' + availLine + '</p><a href="/ai-jobs/apply/' + id + '" style="display:inline-block;background:var(--accent);color:#000;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600">' + escapeAttr(cta) + '</a></div></div></body></html>';
}

async function saveToDB(post, job, category) {
  try {
    const row = {
      slug: post.slug, title: post.title, content: post.content,
      html_content: buildHTML(post, job), opportunity_id: job?.id,
      category: category, thumbnail_url: post.thumb,
      meta_description: post.content.replace(/<[^>]*>/g, "").substring(0, 160),
      status: "published"
    };
    // Ownership: a tenant must stay able to remove a post it paid for, even
    // after the source offer is deleted. tenant_id is nullable (phase-1 schema).
    if (job?.tenant_id) row.tenant_id = job.tenant_id;
    let { error } = await sb.from("blog_posts").upsert(row, { onConflict: "slug" });
    // The tenant (or an interrupted verification run) deleted the offer while
    // this journey was still walking its angles. Live 2026-10-22 every later
    // angle then died on blog_posts_opportunity_id_fkey: the page was written to
    // disk and reported to the tenant, but the row never landed, so the blog list
    // and the restore-on-boot both lost it. Keep the post and only drop the link
    // to the offer that no longer exists.
    if (error && row.opportunity_id && /opportunity_id/i.test(error.message)) {
      console.warn('[DB] Offer ' + row.opportunity_id + ' is gone — saving ' + post.slug + ' without it');
      delete row.opportunity_id;
      ({ error } = await sb.from("blog_posts").upsert(row, { onConflict: "slug" }));
    }
    if (error && row.tenant_id && /tenant_id/i.test(error.message)) {
      // Host predates the phase-1 multi-tenant migration — don't lose the post.
      delete row.tenant_id;
      ({ error } = await sb.from("blog_posts").upsert(row, { onConflict: "slug" }));
    }
    if (error) console.error("[DB] Save error:", error.message);
    else console.log("[DB] Saved: " + post.slug);
  } catch (e) { console.error("[DB] Error:", e.message); }
}

async function genContent(opp, type, existing) {
  const t = opp.title, s = opp.compensation_max || 75, sk = opp.skills?.join(", ") || "AI/ML";
  const prompts = {
    salary: "Write a comprehensive, valuable blog job seekers about \"" + t + "\" salary in " + new Date().getFullYear() + ". Hourly: $" + s + "/hr. Include: intro, salary breakdown (hourly/weekly/monthly/yearly), factors affecting pay, comparison table with similar roles, negotiation tips, industry trends, actionable advice. HTML with h2,h3,p,ul,li,table. NO markdown or asterisks." + FRAGMENT_ONLY,
    howto: "Write an in-depth guide about becoming a \"" + t + "\". Skills: " + sk + ". Include: why this career matters, day-to-day reality, required skills, step-by-step career path, common mistakes, salary expectations ($" + s + "/hr), portfolio building, interview prep, where to find jobs. HTML with h2,h3,p,ul,li. NO markdown." + FRAGMENT_ONLY,
    remote: "Write a guide about remote \"" + t + "\" jobs. Salary: $" + s + "/hr. Include: benefits and challenges, skills needed (" + sk + "), best platforms, how to stand out, work-life balance, success stories. HTML with h2,h3,p,ul,li. NO markdown." + FRAGMENT_ONLY,
    skills: "Write an expert guide about \"" + t + "\" skills. Technical: " + sk + ". Include: technical skills, soft skills, how to learn each skill, learning resources, skill roadmap, salary impact ($" + s + "/hr), certifications, future skills, action plan. HTML with h2,h3,p,ul,li. NO markdown." + FRAGMENT_ONLY
  };
  let content = await ai(prompts[type] || prompts.salary);
  if (!content) return null;
  content = clean(content);
  let attempts = 0;
  while (isDuplicate(content, existing) && attempts < 3) {
    content = await ai(prompts[type] + " Make this completely unique.");
    if (content) content = clean(content);
    attempts++;
  }
  return content;
}

// Rebuilds public/blog/index.html from the files on disk. Deleting a post must
// call this too, otherwise /blog keeps linking to the removed page.
export function updateIndex() {
  if (!fs.existsSync(BLOG)) return;
  const files = fs.readdirSync(BLOG).filter(function(x){return x.endsWith(".html") && x !== "index.html";});
  const posts = files.map(function(x){const s=x.replace(".html","");return {slug:s,title:s.replace(/-/g," ").replace(/\b\w/g,function(c){return c.toUpperCase();})};});
  const list = posts.map(function(p){return '<article style="margin:1rem 0;padding:1.5rem;background:rgba(255,255,255,.05);border-radius:12px"><h3 style="margin:0 0 .5rem"><a href="/blog/'+p.slug+'.html" style="color:#ff8a00;text-decoration:none">'+p.title+'</a></h3><a href="/blog/'+p.slug+'.html" style="color:#b8c7d6;font-size:.9rem">Read more</a></article>';}).join("");
  fs.writeFileSync(path.join(BLOG,"index.html"),'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>AI Jobs Blog | AlphaDome</title><meta name="description" content="AI jobs articles."><link rel="canonical" href="/blog/"><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0}nav a{color:var(--accent);text-decoration:none}h1{font-size:2rem;margin:1rem 0}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / Blog</nav><h1>AI Jobs Blog</h1><p style="color:var(--muted)">Expert career guides.</p>'+list+'<p style="color:var(--muted);margin-top:2rem">'+posts.length+' articles</p></div></body></html>',"utf8");
}

export async function generateAllBlogs(opts = {}) {
  try {
    const { data: opps, error } = await sb
      .from('opportunities')
      .select('id, title')
      .eq('status', 'published');

    if (error) {
      console.error('[GEN ALL] Error fetching opportunities:', error.message);
      return { error: error.message };
    }

    if (!opps || !opps.length) {
      console.log('[GEN ALL] No published opportunities found');
      return { success: true, posts: [], message: 'No published opportunities found' };
    }

    console.log(`[GEN ALL] Processing ${opps.length} published opportunities...`);
    const allPosts = [];
    for (const opp of opps) {
      try {
        const res = await generateBlogPostsForOpportunity(opp.id, opts);
        if (res && res.posts) {
          allPosts.push(...res.posts);
        }
      } catch (err) {
        console.error(`[GEN ALL] Error generating for opp ${opp.id}:`, err.message);
      }
    }

    updateIndex();
    return { success: true, posts: allPosts, total: allPosts.length };
  } catch (err) {
    console.error('[GEN ALL] Fatal error:', err.message);
    return { error: err.message };
  }
}

export async function reviewBlog(slug) {
  try {
    if (!slug) return { error: 'Slug is required' };
    const cleanSlug = slug.replace(/\.html$/, '');

    if (!fs.existsSync(BLOG)) fs.mkdirSync(BLOG, { recursive: true });
    const filePath = path.join(BLOG, `${cleanSlug}.html`);

    let htmlContent = '';
    let title = cleanSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    let oppId = null;
    let thumb = null;
    let category = 'general';

    // Check DB first
    const { data: dbPost } = await sb.from('blog_posts').select('*').eq('slug', cleanSlug).maybeSingle();
    if (dbPost) {
      title = dbPost.title || title;
      htmlContent = dbPost.html_content || '';
      oppId = dbPost.opportunity_id;
      thumb = dbPost.thumbnail_url;
      category = dbPost.category || 'general';
    }

    // Fall back to file if no DB content
    if (!htmlContent && fs.existsSync(filePath)) {
      htmlContent = fs.readFileSync(filePath, 'utf8');
    }

    if (!htmlContent && !dbPost?.content) {
      return { error: `Blog post ${cleanSlug} not found` };
    }

    const titleMatch = htmlContent.match(/<h1>(.*?)<\/h1>/);
    if (titleMatch) title = titleMatch[1];

    let rawContent = dbPost?.content;
    if (!rawContent && htmlContent) {
      const artMatch = htmlContent.match(/<article>([\s\S]*?)<\/article>/);
      rawContent = artMatch ? artMatch[1] : htmlContent;
    }

    rawContent = clean(rawContent);
    if (!rawContent || !String(rawContent).trim()) {
      return { error: 'No reviewable content found for ' + cleanSlug };
    }
    // The offer row, not just its id: buildHTML needs id/cta_label/offer_type to
    // link the page's CTA, saveToDB needs tenant_id to keep the page deletable by
    // the tenant that paid for it, and the polish pass needs the tenant's voice.
    // Passing the bare id (as this did) rebuilt the CTA as
    // /ai-jobs/apply/undefined on every reviewed page.
    let offer = null;
    if (oppId) {
      const { data } = await sb.from('opportunities').select('*').eq('id', oppId).maybeSingle();
      offer = data || null;
    }
    const voice = await loadTenantVoice(offer);
    // `post` carries the journey angle so the polish brief knows what this page
    // was commissioned to do. A page without an offer still gets the brand voice.
    const angle = String(dbPost?.category || '').trim();

    // Bounded like the generation walk: an on-demand review must answer inside a
    // browser-friendly window, so a dry tier falls back to "unchanged" instead of
    // holding the button for a provider walk of several minutes.
    const reviewBudget = Number(process.env.BLOG_REVIEW_AI_TIMEOUT_MS || 45000);
    const reviewed = await reviewContentWithStatus(
      rawContent, title, Date.now() + reviewBudget,
      { offer: offer, post: { title: title, angle: angle || 'awareness', stage: 1 }, voice: voice },
    );
    const cleanedImproved = clean(reviewed.content) || rawContent;

    const postData = {
      title,
      slug: cleanSlug,
      content: cleanedImproved,
      thumb: thumb || (htmlContent.match(/<img src="(\/images\/blog\/[^"]+)"/)?.[1] || null),
      // Keep the page's original publish date: a polish pass is not a re-publish.
      date: dbPost?.created_at || null,
    };

    const newHtml = buildHTML(postData, offer || (oppId ? { id: oppId } : null));

    fs.writeFileSync(filePath, newHtml, 'utf8');
    await saveToDB(postData, offer, category);
    updateIndex();

    console.log(`[REVIEW] Successfully reviewed: ${cleanSlug}` + (reviewed.ai ? '' : ' (AI tier unavailable — copy unchanged)'));
    return {
      success: true,
      slug: cleanSlug,
      title,
      ai: reviewed.ai,
      changed: cleanedImproved !== rawContent,
      // What the page scored before and after, so the portal can show a real
      // outcome instead of a bare "reviewed".
      quality: {
        before: reviewed.before || null,
        after: reviewed.after || analyzeArticle(cleanedImproved),
        rejected: !!reviewed.rejected,
      },
    };
  } catch (err) {
    console.error(`[REVIEW] Error reviewing ${slug}:`, err.message);
    return { error: err.message };
  }
}

export async function reviewAllBlogs() {
  try {
    if (!fs.existsSync(BLOG)) fs.mkdirSync(BLOG, { recursive: true });

    let slugs = [];
    const { data: posts } = await sb.from('blog_posts').select('slug').eq('status', 'published');
    if (posts && posts.length > 0) {
      slugs = posts.map(p => p.slug);
    } else {
      const files = fs.readdirSync(BLOG).filter(f => f.endsWith('.html') && f !== 'index.html');
      slugs = files.map(f => f.replace('.html', ''));
    }

    if (!slugs.length) {
      return { success: true, reviewed: 0, message: 'No blog posts to review' };
    }

    console.log(`[REVIEW ALL] Reviewing ${slugs.length} blog posts...`);
    let reviewed = 0;
    for (const slug of slugs) {
      try {
        const res = await reviewBlog(slug);
        if (res && res.success) reviewed++;
      } catch (e) {
        console.error(`[REVIEW ALL] Error for ${slug}:`, e.message);
      }
    }

    updateIndex();
    return { success: true, reviewed, total: slugs.length };
  } catch (err) {
    console.error('[REVIEW ALL] Error:', err.message);
    return { error: err.message };
  }
}

// ─── Share cards ──────────────────────────────────────────────────────────────
// One page, one card: the hook/summary/excerpt a tenant forwards on WhatsApp.
// Cached per slug + updated_at for half an hour, because opening the Share screen
// twice in a row must not buy the same AI answer twice. A review changes
// updated_at (the trigger bumps it), so the stale card is dropped automatically.
const SHARE_CACHE_TTL_MS = 30 * 60 * 1000;
const SHARE_CACHE_MAX = 200;
const shareCards = new Map();

export function clearShareCache() { shareCards.clear(); }

export async function getPostShareCard(slug, opts = {}) {
  const cleanSlug = String(slug || '').replace(/\.html$/, '').trim();
  if (!cleanSlug) return { error: 'Slug is required' };

  const { data: post, error } = await sb.from('blog_posts')
    .select('slug, title, content, html_content, category, meta_description, opportunity_id, tenant_id, updated_at')
    .eq('slug', cleanSlug).maybeSingle();
  if (error) return { error: error.message };
  if (!post) return { error: `Blog post ${cleanSlug} not found` };

  // Offer facts (type, price, location) keep the card honest on price and give
  // the hashtags something better than the page title's filler words.
  let offer = null;
  if (post.opportunity_id) {
    const { data } = await sb.from('opportunities')
      .select('id, title, offer_type, cta_label, compensation_max, compensation_currency, location_text')
      .eq('id', post.opportunity_id).maybeSingle();
    offer = data || null;
  }

  const wantAi = opts.ai !== false;
  const cacheKey = cleanSlug + '|' + (post.updated_at || '') + '|' + (wantAi ? 'ai' : 'plain');
  const hit = shareCards.get(cacheKey);
  if (hit && Date.now() - hit.at < SHARE_CACHE_TTL_MS) {
    return Object.assign({}, hit.card, { cached: true });
  }

  const source = {
    title: post.title,
    angle: post.category,
    // content is the article body; html_content is the whole page. Prefer the
    // body so the card never quotes the nav or the CTA block.
    content: post.content || post.html_content || post.meta_description || '',
    offer,
  };

  let card = null;
  if (wantAi) {
    const budget = Number(process.env.BLOG_SHARE_AI_TIMEOUT_MS || 15000);
    try {
      const raw = await ai(buildSharePrompt(source), Date.now() + budget);
      card = parseShareCard(raw);
      if (!card && raw) console.warn('[SHARE] unparseable card for ' + cleanSlug + ' — composing from the page');
    } catch (e) {
      console.warn('[SHARE] AI card failed for ' + cleanSlug + ':', e.message);
    }
  }
  if (!card) card = deriveShareCard(source);
  if (!card.hook) return { error: `Page ${cleanSlug} has no readable text to share` };

  const full = Object.assign({
    slug: post.slug,
    title: post.title,
    angle: post.category || null,
    updated_at: post.updated_at || null,
  }, card);

  shareCards.set(cacheKey, { at: Date.now(), card: full });
  if (shareCards.size > SHARE_CACHE_MAX) {
    const oldest = shareCards.keys().next().value;
    if (oldest) shareCards.delete(oldest);
  }
  return Object.assign({}, full, { cached: false });
}


