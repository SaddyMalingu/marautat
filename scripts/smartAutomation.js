import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getContentJourney } from '../utils/contentJourney.js';
const __f = fileURLToPath(import.meta.url);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SITE = process.env.SITE_URL || 'https://alphadome.onrender.com';
const BLOG = path.join(process.cwd(), 'public', 'blog');

async function ai(prompt) {
  try {
    const k = process.env.HF_API_KEY || process.env.HF_API_KEY_WRITERS_FLOW;
    if (!k) return null;
    const axios = (await import('axios')).default;
    const r = await axios.post('https://router.huggingface.co/v1/chat/completions', {
      model: 'meta-llama/Llama-3.1-8B-Instruct:novita',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2500,
      temperature: 0.7
    }, { headers: { Authorization: 'Bearer ' + k }, timeout: 90000 });
    return r.data?.choices?.[0]?.message?.content || null;
  } catch (e) { return null; }
}

function clean(c) {
  if (!c) return c;
  return c.replace(/\*\*([^*]+)\*\*/g, '').replace(/\*([^*]+)\*/g, '').replace(/#{1,6}\s/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function buildHTML(post, id) {
  const img = post.thumb ? '<img src="' + post.thumb + '" alt="' + post.title + '" style="width:100%;max-height:350px;object-fit:cover;border-radius:8px;margin:1rem 0">' : '';
  const rt = Math.ceil(post.content.replace(/<[^>]*>/g, '').split(' ').length / 200);
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>' + post.title + ' | AlphaDome</title><meta name="description" content="' + post.content.replace(/<[^>]*>/g,'').substring(0,160) + '"><link rel="canonical" href="' + SITE + '/blog/' + post.slug + '.html"><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0}nav a{color:var(--accent);text-decoration:none}h1{font-size:2rem;margin:1rem 0}h2{font-size:1.4rem;color:var(--accent);margin:1.5rem 0 .75rem}p,li{color:var(--muted)}ul{padding-left:1.5rem;margin:.5rem 0}img{max-width:100%;border-radius:8px;margin:1rem 0}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / <a href="/ai-jobs">AI Jobs</a> / <a href="/blog">Blog</a></nav><article><h1>' + post.title + '</h1><p style="color:var(--muted)">Published ' + new Date().toLocaleDateString() + ' | ' + rt + ' min read</p>' + img + post.content + '</article><div style="text-align:center;padding:2rem;margin:2rem 0;background:rgba(255,255,255,.05);border-radius:12px"><h2>Ready to Start?</h2><p>This opportunity is available on Mercor.</p><a href="/ai-jobs/apply/' + id + '" style="display:inline-block;background:var(--accent);color:#000;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600">Apply Now</a></div></div></body></html>';
}

export async function runSmartAutomation(opts = {}) {
  const maxPostsPerRun = opts.max_posts_per_run || 10;
  console.log('[SMART] Starting intelligent automation...');
  const { data: jobs } = await sb.from('opportunities').select('id, title, slug').eq('status', 'published').order('created_at', { ascending: false });
  if (!jobs || !jobs.length) { console.log('[SMART] No published jobs'); return { generated: 0 }; }
  const { data: existingPosts } = await sb.from('blog_posts').select('opportunity_id, slug').eq('status', 'published');
  const postsByJob = {};
  if (existingPosts) { existingPosts.forEach(p => { if (!postsByJob[p.opportunity_id]) postsByJob[p.opportunity_id] = new Set(); postsByJob[p.opportunity_id].add(p.slug); }); }
  const jobsNeedingContent = jobs.map(job => {
    const existingSlugs = postsByJob[job.id] || new Set();
    const journey = getContentJourney(job);
    const missingPosts = journey.filter(p => !existingSlugs.has(p.slug));
    return { ...job, existing_count: existingSlugs.size, missing_count: missingPosts.length, missing_posts: missingPosts };
  }).filter(j => j.missing_count > 0).sort((a, b) => b.missing_count - a.missing_count);
  console.log('[SMART] ' + jobsNeedingContent.length + ' jobs need content');
  let totalGenerated = 0;
  const results = [];
  for (const job of jobsNeedingContent) {
    if (totalGenerated >= maxPostsPerRun) break;
    const toGenerate = Math.min(job.missing_posts.length, maxPostsPerRun - totalGenerated, 2);
    console.log('[SMART] ' + job.title + ': generating ' + toGenerate + '/' + job.missing_count);
    let generated = 0;
    for (let i = 0; i < toGenerate; i++) {
      const post = job.missing_posts[i];
      try {
        const content = await ai(post.prompt);
        if (!content) continue;
        const cleaned = clean(content);
        const html = buildHTML({ title: post.title, slug: post.slug, content: cleaned, thumb: null }, job.id);
        if (!fs.existsSync(BLOG)) fs.mkdirSync(BLOG, { recursive: true });
        fs.writeFileSync(path.join(BLOG, post.slug + '.html'), html, 'utf8');
        await sb.from('blog_posts').upsert({ slug: post.slug, title: post.title, content: cleaned, html_content: html, opportunity_id: job.id, category: post.angle, status: 'published' }, { onConflict: 'slug' });
        generated++;
        totalGenerated++;
      } catch (e) { console.error('[SMART] Error: ' + e.message); }
    }
    results.push({ job: job.title, generated });
  }
  console.log('[SMART] Complete: ' + totalGenerated + ' posts generated');
  return { generated: totalGenerated, jobs_processed: results.length, details: results };
}

if (import.meta.url === 'file://' + process.argv[1]) { runSmartAutomation().then(r => console.log(JSON.stringify(r))).catch(console.error); }
