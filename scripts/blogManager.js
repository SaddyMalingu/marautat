import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getContentJourney, getAllAngles } from '../utils/contentJourney.js';
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
    for (const post of data) {
      if (post.html_content) {
        fs.writeFileSync(path.join(BLOG, post.slug + '.html'), post.html_content, 'utf8');
      }
    }
    console.log('[DB] Restored ' + data.length + ' posts');
    return data.length;
  } catch (e) { console.error('[DB] Restore error:', e.message); return 0; }
}

function clean(c) {
  if (!c) return c;
  return c
    .replace(/\*\*([^*]+)\*\*/g, '')
    .replace(/\*([^*]+)\*/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/_{2,}/g, '')
    .replace(/~~([^~]+)~~/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Last failure reason from the AI provider, surfaced to callers so a tenant or
// operator can see *why* generation produced nothing without reading host logs.
let lastAiError = null;

// Provider fallback order: OpenRouter → Gemini (free tier) → OpenAI → HuggingFace.
// Any single key being present is enough to generate; set OPENROUTER_MODEL /
// GEMINI_MODEL / OPENAI_MODEL / HF_MODEL to pin a specific model.
// OpenRouter free-tier slugs are retired without notice — the 2026-10-22 outage
// was llama-3.1-8b-instruct:free answering 404 "This model is unavailable for
// free". Generation therefore falls through this list (see ai()) instead of
// dying with whichever slug expires. Pin OPENROUTER_MODEL to freeze one.
export const OPENROUTER_FREE_MODELS = [
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m3.1-flash:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'poolside/laguna-s-2.1:free',
];

const AI_PROVIDERS = [
  {
    name: 'openrouter',
    // OPENROUTER_KEY is the name the rest of the platform (server.js, kernel)
    // uses for the same credential — accept both so one key serves everything.
    key: () => process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY,
    url: () => (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1') + '/chat/completions',
    models: () => (process.env.OPENROUTER_MODEL ? [process.env.OPENROUTER_MODEL] : OPENROUTER_FREE_MODELS.slice()),
    headers: (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }),
  },
  {
    // Google AI Studio: free tier, no credit card, OpenAI-compatible endpoint.
    // This is the zero-spend recovery path when a paid account runs dry (the
    // 2026-10-22 HF 402 incident). GEMINI_MODEL pins a stable flash model
    // (e.g. gemini-3.8-flash); the default alias survives model shutdowns.
    name: 'gemini',
    key: () => process.env.GEMINI_API_KEY,
    url: () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai') + '/chat/completions',
    model: () => process.env.GEMINI_MODEL || 'gemini-flash-latest',
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
    key: () => process.env.HF_API_KEY || process.env.HF_API_KEY_WRITERS_FLOW,
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

// Exposed so verification scripts (scripts/test_ai_providers.mjs) can drive the
// fallback chain against a local stub instead of the real providers.
export function getLastAiError() { return lastAiError; }
export function isAiFailureFatal() { return lastAiFatal; }

async function ai(prompt) {
  const axios = (await import('axios')).default;
  const failures = [];
  for (const p of AI_PROVIDERS) {
    const key = p.key();
    if (!key) continue;
    const models = typeof p.models === 'function' ? p.models() : [p.model()];
    let failure = null;
    for (let mi = 0; mi < models.length; mi++) {
      try {
        const r = await axios.post(p.url(), {
          model: models[mi],
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 3000,
          temperature: 0.7,
        }, { headers: p.headers(key), timeout: 120000 });
        const content = r.data?.choices?.[0]?.message?.content || null;
        if (!content) {
          failure = { name: p.name, status: 200, text: 'empty content (' + models[mi] + ')', kind: 'transient' };
          break;
        }
        if (failures.length || mi > 0) {
          console.log('[AI] ' + p.name + ' served with ' + models[mi] +
            (failures.length ? ' after ' + failures.length + ' failed provider(s)' : ''));
        }
        lastAiError = null;
        lastAiFatal = false;
        return content;
      } catch (e) {
        const status = e.response?.status;
        const raw = e.response?.data;
        const body = raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw)) : '';
        const text = (body || e.message || '').slice(0, 240);
        failure = { name: p.name, status: status || 0, text, kind: classifyFailure(status, text) };
        // A retired free slug answers 404 ("This model is unavailable for
        // free"). Try the next candidate before giving up on the provider.
        if (status === 404 && mi < models.length - 1) {
          console.warn('[AI] ' + p.name + ' model ' + models[mi] + ' is gone — trying ' + models[mi + 1]);
          failure = null;
          continue;
        }
        break;
      }
    }
    if (failure) failures.push(failure);
  }
  // Only hopeless when every provider we could try said auth/billing. A single
  // dead provider next to a healthy one must never stop the journey.
  lastAiFatal = failures.length === 0 || failures.every(function (f) { return f.kind === 'fatal'; });
  lastAiError = failures.length
    ? failures.map(function (f) { return (f.name + ' ' + (f.status || '') + ' ' + f.text).trim().slice(0, 240); }).join(' | ')
    : 'no AI provider key configured (OPENROUTER_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / HF_API_KEY)';
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

export async function generateBlogPostsForOpportunity(oppId, opts) {
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
  var res = [];
  var attempts = 0;
  var skipped = [];
  lastAiError = null;
  for (var i = 0; i < journey.length; i++) {
    var post = journey[i];
    console.log('[GEN] - [' + post.angleName + '] ' + post.title);
    attempts++;
    var content = await ai(post.prompt);
    if (!content) {
      skipped.push({ slug: post.slug, angle: post.angleName, error: lastAiError });
      if (isAiFailureFatal()) {
        console.error('[GEN] Aborting after [' + post.angleName + '] — every provider failed on auth/billing: ' + lastAiError);
        break;
      }
      console.log('[GEN] Failed: ' + post.slug + ' — continuing with next angle');
      continue;
    }
    content = clean(content);
    if (isDuplicate(content, existing)) {
      content = await ai(post.prompt + ' Make this completely unique.');
      if (content) content = clean(content);
    }
    if (rev) content = await reviewContent(content, post.title);
    var thumb = null;
    if (img) thumb = await genImage(o.title + ' ' + post.angleName, post.slug);
    var postData = { title: post.title, slug: post.slug, content: content, thumb: thumb };
    fs.writeFileSync(path.join(BLOG, post.slug + '.html'), buildHTML(postData, o), 'utf8');
    await saveToDB(postData, o, post.angle);
    existing.push(content);
    res.push({ title: post.title, slug: post.slug, angle: post.angleName, url: SITE + '/blog/' + post.slug + '.html', thumb: thumb });
  }
  updateIndex();
  console.log('[GEN] Done: ' + res.length + '/' + journey.length + ' posts' + (skipped.length ? ' (' + skipped.length + ' angle(s) skipped)' : ''));
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
      error: 'No posts generated — the AI writer returned nothing (' + attempts + ' of ' +
        journey.length + ' angles attempted). Check GEMINI_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / HF_API_KEY and model credits.' +
        (lastAiError ? ' Last AI error: ' + lastAiError : '')
    };
  }
  // Partial journeys are still a success, but callers must be able to show
  // *why* an angle was skipped (free-tier rate limits) instead of guessing.
  return { success: true, posts: res, attempted: attempts, skipped: skipped };
}






async function reviewContent(content, title) {
  try {
    const prompt = `Review and improve this blog post. Remove ALL asterisks, markdown formatting, and AI patterns. Fix inconsistencies. Make it read like a professional human-written educational article. Ensure proper HTML structure with h2, h3, p, ul, li tags. Content:\n\n` + content;
    const improved = await ai(prompt);
    return improved || content;
  } catch (e) { return content; }
}

const OFFER_CTA = { job: 'Apply Now', product: 'Shop Now', service: 'Learn More', brand: 'Explore', affiliate: 'Get Deal', course: 'Enroll' };
function buildHTML(post, job) {
  const id = job?.id;
  const cta = (job && job.cta_label) || OFFER_CTA[job && job.offer_type] || 'Apply Now';
  const availLine = (job && job.offer_type && job.offer_type !== 'job') ? 'This offer is available now.' : 'This opportunity is available now.';
  const img = post.thumb ? '<img src="' + post.thumb + '" alt="' + post.title + '" style="width:100%;max-height:350px;object-fit:cover;border-radius:8px;margin:1rem 0">' : '';
  const rt = Math.ceil(post.content.replace(/<[^>]*>/g, '').split(' ').length / 200);
  const VM = '<meta name="google-site-verification" content="nQc8r4A_tjZX4469pNlpTR5hf7bfjEazZtITnrrHZUU">';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' + VM + '<title>' + post.title + ' | AlphaDome</title><meta name="description" content="' + post.content.replace(/<[^>]*>/g,'').substring(0,160) + '"><link rel="canonical" href="' + (process.env.SITE_URL || 'https://alphadome.onrender.com') + '/blog/' + post.slug + '.html"><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0}nav a{color:var(--accent);text-decoration:none}h1{font-size:2rem;margin:1rem 0}h2{font-size:1.4rem;color:var(--accent);margin:1.5rem 0 .75rem}p,li{color:var(--muted)}ul{padding-left:1.5rem;margin:.5rem 0}img{max-width:100%;border-radius:8px;margin:1rem 0}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / <a href="/ai-jobs">AI Jobs</a> / <a href="/blog">Blog</a></nav><article><h1>' + post.title + '</h1><p style="color:var(--muted)">Published ' + new Date().toLocaleDateString() + ' | ' + rt + ' min read</p>' + img + post.content + '</article><div style="text-align:center;padding:2rem;margin:2rem 0;background:rgba(255,255,255,.05);border-radius:12px"><h2>Ready to Start?</h2><p>' + availLine + '</p><a href="/ai-jobs/apply/' + id + '" style="display:inline-block;background:var(--accent);color:#000;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600">' + cta + '</a></div></div></body></html>';
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
    salary: "Write a comprehensive, valuable blog job seekers about \"" + t + "\" salary in " + new Date().getFullYear() + ". Hourly: $" + s + "/hr. Include: intro, salary breakdown (hourly/weekly/monthly/yearly), factors affecting pay, comparison table with similar roles, negotiation tips, industry trends, actionable advice. HTML with h2,h3,p,ul,li,table. NO markdown or asterisks.",
    howto: "Write an in-depth guide about becoming a \"" + t + "\". Skills: " + sk + ". Include: why this career matters, day-to-day reality, required skills, step-by-step career path, common mistakes, salary expectations ($" + s + "/hr), portfolio building, interview prep, where to find jobs. HTML with h2,h3,p,ul,li. NO markdown.",
    remote: "Write a guide about remote \"" + t + "\" jobs. Salary: $" + s + "/hr. Include: benefits and challenges, skills needed (" + sk + "), best platforms, how to stand out, work-life balance, success stories. HTML with h2,h3,p,ul,li. NO markdown.",
    skills: "Write an expert guide about \"" + t + "\" skills. Technical: " + sk + ". Include: technical skills, soft skills, how to learn each skill, learning resources, skill roadmap, salary impact ($" + s + "/hr), certifications, future skills, action plan. HTML with h2,h3,p,ul,li. NO markdown."
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

function updateIndex() {
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
    const improved = await reviewContent(rawContent, title);
    const cleanedImproved = clean(improved) || rawContent;

    const postData = {
      title,
      slug: cleanSlug,
      content: cleanedImproved,
      thumb: thumb || (htmlContent.match(/<img src="(\/images\/blog\/[^"]+)"/)?.[1] || null)
    };

    const newHtml = buildHTML(postData, oppId);

    fs.writeFileSync(filePath, newHtml, 'utf8');
    await saveToDB(postData, oppId, category);
    updateIndex();

    console.log(`[REVIEW] Successfully reviewed: ${cleanSlug}`);
    return { success: true, slug: cleanSlug, title };
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

