import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __f = fileURLToPath(import.meta.url);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SITE = process.env.SITE_URL || 'https://alphadome.onrender.com';
const BLOG = path.join(process.cwd(), 'public', 'blog');
const IMG = path.join(process.cwd(), 'public', 'images', 'blog');
const VM = '<meta name="google-site-verification" content="nQc8r4A_tjZX4469pNlpTR5hf7bfjEazZtITnrrHZUU">';

async function ai(prompt) {
  try {
    const k = process.env.HF_API_KEY || process.env.HF_API_KEY_WRITERS_FLOW;
    if (!k) return null;
    const axios = (await import('axios')).default;
    const r = await axios.post('https://router.huggingface.co/v1/chat/completions', {
      model: 'meta-llama/Llama-3.1-8B-Instruct:novita',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0.8
    }, { headers: { Authorization: 'Bearer ' + k }, timeout: 120000 });
    return r.data?.choices?.[0]?.message?.content || null;
  } catch (e) { console.error('[AI] Error:', e.message); return null; }
}

async function genImage(prompt, slug) {
  try {
    const t = process.env.REPLICATE_API_TOKEN;
    if (!t) return null;
    const { default: Replicate } = await import('replicate');
    const rep = new Replicate({ auth: t });
    const out = await rep.run('google/nanobanana', { input: { prompt: prompt } });
    if (!fs.existsSync(IMG)) fs.mkdirSync(IMG, { recursive: true });
    const axios = (await import('axios')).default;
    const res = await axios.get(out, { responseType: 'arraybuffer' });
    fs.writeFileSync(path.join(IMG, slug + '.png'), res.data);
    return '/images/blog/' + slug + '.png';
  } catch (e) { console.error('[Image] Error:', e.message); return null; }
}

function isDuplicate(content, existingBlogs) {
  const normalized = content.toLowerCase().replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  for (const blog of existingBlogs) {
    const blogNormalized = blog.toLowerCase().replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    // Check similarity - if more than 60% same words, consider duplicate
    const words1 = new Set(normalized.split(' '));
    const words2 = new Set(blogNormalized.split(' '));
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const similarity = intersection.size / Math.max(words1.size, words2.size);
    if (similarity > 0.6) return true;
  }
  return false;
}

async function generateUniqueContent(opp, type, existingBlogs) {
  const prompts = {
    salary: 'Write a comprehensive, engaging blog post about "' + opp.title + '" salary expectations in ' + new Date().getFullYear() + '. Include: 1) Catchy headline 2) Introduction hook with a question or surprising fact 3) Hourly rate ($' + (opp.compensation_max || 75) + '/hr), weekly/monthly/yearly projections 4) Factors affecting salary (experience, location, skills) 5) Comparison table with similar roles 6) Tips to increase earnings 7) Industry trends 8) Real-world examples 9) Conclusion with CTA to apply. Skills: ' + (opp.skills?.join(', ') || 'AI/ML') + '. Write in HTML format with h2/h3 headings, paragraphs, bullet points, and a data table. Make it unique and engaging.',
    howto: 'Write an inspiring, actionable blog post about becoming a "' + opp.title + '". Include: 1) Engaging headline 2) Why this career is in-demand 3) Day-to-day responsibilities 4) Required skills (' + (opp.skills?.join(', ') || 'technical skills') + ') 5) Step-by-step career path (beginner to expert) 6) Common mistakes to avoid 7) Salary expectations ($' + (opp.compensation_max || 75) + '/hr) 8) How to get hired on platforms like Mercor 9) Success stories 10) CTA. Write in HTML with proper headings, lists, and motivational tone.',
    remote: 'Write an engaging blog post about remote "' + opp.title + '" jobs. Include: 1) Catchy headline 2) Benefits of remote work 3) How to find remote opportunities 4) Skills needed (' + (opp.skills?.join(', ') || 'relevant skills') + ') 5) Salary expectations ($' + (opp.compensation_max || 75) + '/hr) 6) Best platforms for remote work 7) Tips for remote work success 8) Tools and technologies 9) Work-life balance 10) CTA. Write in HTML with subheadings, bullet points, and real-world scenarios.',
    skills: 'Write a detailed blog post about top skills for "' + opp.title + '" roles. Include: 1) Engaging headline 2) Technical skills (' + (opp.skills?.join(', ') || 'programming, AI') + ') 3) Soft skills employers value 4) How to develop each skill 5) Learning resources 6) How skills affect salary ($' + (opp.compensation_max || 75) + '/hr) 7) Industry trends 8) Career advice 9) CTA. Write in HTML with proper structure and actionable tips.'
  };
  
  let content = await ai(prompts[type] || prompts.salary);
  if (!content) return null;
  
  // Check for duplicates and regenerate if needed
  let attempts = 0;
  while (isDuplicate(content, existingBlogs) && attempts < 3) {
    content = await ai(prompts[type] + ' Make this completely unique and different from typical blog posts.');
    attempts++;
  }
  return content;
}

async function reviewContent(content, title, opp) {
  const reviewPrompt = 'Review and improve this blog post. Make it more engaging, add compelling storytelling, improve readability, add specific examples and data, strengthen the call-to-action. Ensure it has: 1) Strong headline 2) Engaging introduction 3) Clear structure with subheadings 4) Bullet points and lists 5) Data/statistics 6) Real-world examples 7) Compelling CTA. Content:\n\n' + content;
  const improved = await ai(reviewPrompt);
  return improved || content;
}

function buildHTML(post, id) {
  var sc = { '@context': 'https://schema.org', '@type': 'BlogPosting', 'headline': post.title, 'datePublished': new Date().toISOString(), 'author': { '@type': 'Organization', 'name': 'AlphaDome' }, 'image': post.thumb };
  var img = post.thumb ? '<img src="' + post.thumb + '" alt="' + post.title + '" style="width:100%;max-height:400px;object-fit:cover;border-radius:8px;margin:1rem 0">' : '';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' + VM + '<title>' + post.title + ' | AlphaDome</title><meta name="description" content="' + post.content.replace(/<[^>]*>/g, '').substring(0, 160) + '"><link rel="canonical" href="' + SITE + '/blog/' + post.slug + '.html"><meta property="og:title" content="' + post.title + '"><meta property="og:image" content="' + (post.thumb || '') + '"><meta property="og:type" content="article"><script type="application/ld+json">' + JSON.stringify(sc) + '</script><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0;font-size:.9rem}nav a{color:var(--accent);text-decoration:none}h1{font-size:2.2rem;margin:1rem 0;line-height:1.2}h2{font-size:1.4rem;color:var(--accent);margin:1.5rem 0 .75rem}h3{font-size:1.1rem;margin:1rem 0 .5rem}p,li{color:var(--muted)}ul,ol{padding-left:1.5rem;margin:.5rem 0}img{max-width:100%;border-radius:8px;margin:1rem 0}.apply{text-align:center;padding:2rem;margin:2rem 0;background:rgba(255,255,255,.05);border-radius:12px}.btn{display:inline-block;background:var(--accent);color:#000;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600}table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{padding:.75rem;text-align:left;border-bottom:1px solid rgba(255,255,255,.1)}th{color:var(--accent)}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / <a href="/ai-jobs">AI Jobs</a> / <a href="/blog">Blog</a></nav><article><h1>' + post.title + '</h1><p style="color:var(--muted);font-size:.9rem">Published ' + new Date().toLocaleDateString() + ' | Reading time: ' + Math.ceil(post.content.replace(/<[^>]*>/g, '').split(' ').length / 200) + ' min</p>' + img + post.content + '</article><div class="apply"><h2>Ready to Start Your Career?</h2><p>This opportunity is available now on Mercor. Apply through AlphaDome to support our referral program.</p><a href="/ai-jobs/apply/' + id + '" class="btn">Apply Through Mercor</a></div></div></body></html>';
}

function updateIndex() {
  if (!fs.existsSync(BLOG)) return;
  var files = fs.readdirSync(BLOG).filter(function(x){return x.endsWith('.html') && x !== 'index.html';});
  var posts = files.map(function(x){var s=x.replace('.html','');return {slug:s,title:s.replace(/-/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();})};});
  var list = posts.map(function(p){return '<article style="margin:1rem 0;padding:1.5rem;background:rgba(255,255,255,.05);border-radius:12px"><h3 style="margin:0 0 .5rem"><a href="/blog/'+p.slug+'.html" style="color:var(--accent);text-decoration:none">'+p.title+'</a></h3><a href="/blog/'+p.slug+'.html" style="color:var(--muted);font-size:.9rem">Read more →</a></article>';}).join('');
  fs.writeFileSync(path.join(BLOG,'index.html'),'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>AI Jobs Blog | AlphaDome</title><meta name="description" content="AI jobs articles, salaries, skills, and career guides."><link rel="canonical" href="'+SITE+'/blog/"><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0}nav a{color:var(--accent);text-decoration:none}h1{font-size:2rem;margin:1rem 0}article:hover{background:rgba(255,255,255,.08)!important}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / Blog</nav><h1>AI Jobs Blog</h1><p style="color:var(--muted)">Articles about AI jobs, salaries, skills, and career guides.</p>'+list+'<p style="color:var(--muted);margin-top:2rem">Total: '+posts.length+' articles</p></div></body></html>','utf8');
}

export async function generateBlogPostsForOpportunity(oppId, opts) {
  opts = opts || {};
  var rev = opts.review !== false;
  var img = opts.images !== false;
  var d = await sb.from('opportunities').select('*').eq('id', oppId).single();
  var o = d.data;
  if (!o) return { error: 'Not found' };
  if (!fs.existsSync(BLOG)) fs.mkdirSync(BLOG, { recursive: true });
  
  // Get existing blog content for duplicate check
  var existingBlogs = [];
  if (fs.existsSync(BLOG)) {
    var files = fs.readdirSync(BLOG).filter(function(x){return x.endsWith('.html') && x !== 'index.html';});
    existingBlogs = files.map(function(f){return fs.readFileSync(path.join(BLOG, f), 'utf8');});
  }
  
  var angles = [
    { t: o.title + ' Salary ' + new Date().getFullYear(), s: o.slug + '-salary', type: 'salary' },
    { t: 'How to Become ' + o.title, s: 'how-to-' + o.slug, type: 'howto' },
    { t: 'Remote ' + o.title + ' Jobs', s: 'remote-' + o.slug + '-jobs', type: 'remote' },
    { t: o.title + ' Skills ' + new Date().getFullYear(), s: o.slug + '-skills', type: 'skills' }
  ];
  
  var res = [];
  for (var i = 0; i < angles.length; i++) {
    var a = angles[i];
    var title = a.t, slug = a.s;
    var content = await generateUniqueContent(o, a.type, existingBlogs);
    if (!content) continue;
    if (rev) content = await reviewContent(content, title, o);
    var thumb = null;
    if (img) thumb = await genImage(o.title + ' professional workspace modern technology', slug);
    fs.writeFileSync(path.join(BLOG, slug + '.html'), buildHTML({ title: title, slug: slug, content: content, thumb: thumb }, oppId), 'utf8');
    existingBlogs.push(content);
    res.push({ title: title, slug: slug, url: SITE + '/blog/' + slug + '.html', thumb: thumb });
  }
  updateIndex();
  return { success: true, posts: res };
}

export async function reviewAllBlogs() {
  if (!fs.existsSync(BLOG)) return { error: 'No blogs' };
  var f = fs.readdirSync(BLOG).filter(function(x){return x.endsWith('.html') && x !== 'index.html';});
  var res = [];
  for (var i = 0; i < f.length; i++) {
    var file = f[i];
    var slug = file.replace('.html','');
    var c = fs.readFileSync(path.join(BLOG, file), 'utf8');
    var t = (c.match(/<h1>(.*?)<\/h1>/) || [])[1] || slug;
    var improved = await reviewContent(c, t, { title: slug, compensation_max: 75, skills: ['AI'] });
    if (improved && improved !== c) { fs.writeFileSync(path.join(BLOG, file), improved, 'utf8'); res.push(slug); }
  }
  return { success: true, reviewed: res.length, posts: res };
}

export async function generateAllBlogs(opts) {
  var d = await sb.from('opportunities').select('id').eq('status', 'published');
  var ops = d.data;
  if (!ops || !ops.length) return { error: 'None' };
  var all = [];
  for (var i = 0; i < ops.length; i++) { var r = await generateBlogPostsForOpportunity(ops[i].id, opts); if (r.posts) all = all.concat(r.posts); }
  return { success: true, total: all.length, posts: all };
}

if (import.meta.url === 'file://' + process.argv[1]) { var id = process.argv[2], act = process.argv[3]; (act === 'review' ? reviewAllBlogs() : id ? generateBlogPostsForOpportunity(id) : generateAllBlogs()).then(function(r){console.log(JSON.stringify(r));}); }

