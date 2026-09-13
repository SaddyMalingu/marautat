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

async function ai(prompt) {
  try {
    const k = process.env.HF_API_KEY || process.env.HF_API_KEY_WRITERS_FLOW;
    if (!k) { console.log('[AI] No key'); return null; }
    const axios = (await import('axios')).default;
    const r = await axios.post('https://router.huggingface.co/v1/chat/completions', {
      model: 'meta-llama/Llama-3.1-8B-Instruct:novita',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0.7
    }, { headers: { Authorization: 'Bearer ' + k }, timeout: 120000 });
    return r.data?.choices?.[0]?.message?.content || null;
  } catch (e) { console.error('[AI] Error:', e.message); return null; }
}

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
  for (var i = 0; i < journey.length; i++) {
    var post = journey[i];
    console.log('[GEN] - [' + post.angleName + '] ' + post.title);
    var content = await ai(post.prompt);
    if (!content) { console.log('[GEN] Failed: ' + post.slug); continue; }
    content = clean(content);
    if (isDuplicate(content, existing)) {
      content = await ai(post.prompt + ' Make this completely unique.');
      if (content) content = clean(content);
    }
    if (rev) content = await reviewContent(content, post.title);
    var thumb = null;
    if (img) thumb = await genImage(o.title + ' ' + post.angleName, post.slug);
    var postData = { title: post.title, slug: post.slug, content: content, thumb: thumb };
    fs.writeFileSync(path.join(BLOG, post.slug + '.html'), buildHTML(postData, oppId), 'utf8');
    await saveToDB(postData, oppId, post.angle);
    existing.push(content);
    res.push({ title: post.title, slug: post.slug, angle: post.angleName, url: SITE + '/blog/' + post.slug + '.html', thumb: thumb });
  }
  updateIndex();
  console.log('[GEN] Done: ' + res.length + ' posts');
  return { success: true, posts: res };
}






async function reviewContent(content, title) {
  try {
    const k = process.env.HF_API_KEY || process.env.HF_API_KEY_WRITERS_FLOW;
    if (!k) return content;
    const axios = (await import('axios')).default;
    const prompt = `Review and improve this blog post. Remove ALL asterisks, markdown formatting, and AI patterns. Fix inconsistencies. Make it read like a professional human-written educational article. Ensure proper HTML structure with h2, h3, p, ul, li tags. Content:\n\n` + content;
    const r = await axios.post('https://router.huggingface.co/v1/chat/completions', {
      model: 'meta-llama/Llama-3.1-8B-Instruct:novita',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2500,
      temperature: 0.7
    }, { headers: { Authorization: `Bearer ${k}` }, timeout: 90000 });
    const improved = r.data?.choices?.[0]?.message?.content;
    return improved || content;
  } catch (e) { return content; }
}

function buildHTML(post, id) {
  const img = post.thumb ? '<img src="' + post.thumb + '" alt="' + post.title + '" style="width:100%;max-height:350px;object-fit:cover;border-radius:8px;margin:1rem 0">' : '';
  const rt = Math.ceil(post.content.replace(/<[^>]*>/g, '').split(' ').length / 200);
  const VM = '<meta name="google-site-verification" content="nQc8r4A_tjZX4469pNlpTR5hf7bfjEazZtITnrrHZUU">';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' + VM + '<title>' + post.title + ' | AlphaDome</title><meta name="description" content="' + post.content.replace(/<[^>]*>/g,'').substring(0,160) + '"><link rel="canonical" href="' + (process.env.SITE_URL || 'https://alphadome.onrender.com') + '/blog/' + post.slug + '.html"><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0}nav a{color:var(--accent);text-decoration:none}h1{font-size:2rem;margin:1rem 0}h2{font-size:1.4rem;color:var(--accent);margin:1.5rem 0 .75rem}p,li{color:var(--muted)}ul{padding-left:1.5rem;margin:.5rem 0}img{max-width:100%;border-radius:8px;margin:1rem 0}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / <a href="/ai-jobs">AI Jobs</a> / <a href="/blog">Blog</a></nav><article><h1>' + post.title + '</h1><p style="color:var(--muted)">Published ' + new Date().toLocaleDateString() + ' | ' + rt + ' min read</p>' + img + post.content + '</article><div style="text-align:center;padding:2rem;margin:2rem 0;background:rgba(255,255,255,.05);border-radius:12px"><h2>Ready to Start?</h2><p>This opportunity is available on Mercor.</p><a href="/ai-jobs/apply/' + id + '" style="display:inline-block;background:var(--accent);color:#000;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600">Apply Through Mercor</a></div></div></body></html>';
}

async function saveToDB(post, id, category) {
  try {
    const { error } = await sb.from("blog_posts").upsert({
      slug: post.slug, title: post.title, content: post.content,
      html_content: buildHTML(post, id), opportunity_id: id,
      category: category, thumbnail_url: post.thumb,
      meta_description: post.content.replace(/<[^>]*>/g, "").substring(0, 160),
      status: "published"
    }, { onConflict: "slug" });
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
