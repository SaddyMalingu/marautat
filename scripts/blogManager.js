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



