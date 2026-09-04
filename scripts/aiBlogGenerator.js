import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SITE = process.env.SITE_URL || 'https://alphadome.onrender.com';
const BLOG = path.join(process.cwd(), 'public', 'blog');
const VM = '<meta name="google-site-verification" content="nQc8r4A_tjZX4469pNlpTR5hf7bfjEazZtITnrrHZUU">';
const STYLE = '<style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0;font-size:.9rem}nav a{color:var(--accent);text-decoration:none}h1{font-size:2rem;margin:1rem 0}h2{font-size:1.3rem;color:var(--accent);margin:1.5rem 0 .75rem}p,li{color:var(--muted)}ul{padding-left:1.5rem;margin:.5rem 0}.apply{text-align:center;padding:2rem;margin:2rem 0;background:rgba(255,255,255,.05);border-radius:12px}.btn{display:inline-block;background:var(--accent);color:#000;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600}</style>';

async function ai(prompt) {
  try {
    const k = process.env.HF_API_KEY || process.env.HF_API_KEY_WRITERS_FLOW;
    if (!k) return null;
    const axios = (await import('axios')).default;
    const r = await axios.post('https://router.huggingface.co/v1/chat/completions', { model: 'meta-llama/Llama-3.1-8B-Instruct:novita', messages: [{ role: 'user', content: prompt }], max_tokens: 1500, temperature: 0.8 }, { headers: { Authorization: `Bearer ${k}` }, timeout: 60000 });
    return r.data?.choices?.[0]?.message?.content || null;
  } catch (e) { return null; }
}

const ANGLES = [
  { t: o=>`${o.title} Salary ${new Date().getFullYear()}`, s: o=>`${o.slug}-salary`, p: o=>`Write blog: "${o.title}" salary. $${o.compensation_max||75}/hr. Weekly/monthly/yearly. Skills: ${o.skills?.join(',')||'AI'}. HTML, conversational, CTA.` },
  { t: o=>`How to Become ${o.title}`, s: o=>`how-to-${o.slug}`, p: o=>`Write: becoming "${o.title}". ${o.description||''}. Skills: ${o.skills?.join(',')||'tech'}. Career path, steps. HTML, motivational.` },
  { t: o=>`Remote ${o.title} Jobs`, s: o=>`remote-${o.slug}-jobs`, p: o=>`Write: remote "${o.title}" jobs. $${o.compensation_max||75}/hr. Benefits, how to get hired. HTML, CTA.` },
  { t: o=>`${o.title} Skills ${new Date().getFullYear()}`, s: o=>`${o.slug}-skills`, p: o=>`Write: "${o.title}" skills. Tech: ${o.skills?.join(',')||'AI'}. Soft skills, salary impact. HTML.` }
];

function fallback(o) { return `<h2>${o.title}</h2><p>$${o.compensation_max||75}/hr</p><ul>${(o.skills||[]).map(s=>`<li>${s}</li>`).join('')}</ul>`; }

function html(p, id) {
  const sc = { "@context": "https://schema.org", "@type": "BlogPosting", "headline": p.title, "datePublished": new Date().toISOString(), "author": { "@type": "Organization", "name": "AlphaDome" } };
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">${VM}<title>${p.title} | AlphaDome</title><meta name="description" content="${p.c.replace(/<[^>]*>/g,'').substring(0,160)}"><link rel="canonical" href="${SITE}/blog/${p.s}.html"><meta property="og:title" content="${p.title}"><script type="application/ld+json">${JSON.stringify(sc)}</script>${STYLE}</head><body><div class="c"><nav><a href="/">AlphaDome</a> / <a href="/ai-jobs">AI Jobs</a> / <a href="/blog">Blog</a></nav><h1>${p.title}</h1><p style="color:var(--muted)">${new Date().toLocaleDateString()}</p>${p.c}<div class="apply"><h2>Ready to Apply?</h2><a href="/ai-jobs/apply/${id}" class="btn">Apply Through Mercor</a></div></div></body></html>`;
}

function idx() {
  if (!fs.existsSync(BLOG)) return;
  const fs2 = fs.readdirSync(BLOG).filter(f => f.endsWith('.html') && f !== 'index.html');
  const list = fs2.map(f => { const s = f.replace('.html',''); return `<article style="margin:1rem 0;padding:1rem;background:rgba(255,255,255,.05);border-radius:8px"><h3><a href="/blog/${s}.html" style="color:var(--accent);text-decoration:none">${s.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</a></h3></article>`; }).join('');
  fs.writeFileSync(path.join(BLOG, 'index.html'), `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>AI Jobs Blog | AlphaDome</title><link rel="canonical" href="${SITE}/blog/">${STYLE}</head><body><div class="c"><nav><a href="/">AlphaDome</a> / Blog</nav><h1>AI Jobs Blog</h1>${list}</div></body></html>`, 'utf8');
}

export async function generateBlogPostsForOpportunity(oppId) {
  const { data: o } = await supabase.from('opportunities').select('*').eq('id', oppId).single();
  if (!o) return { error: 'Not found' };
  if (!fs.existsSync(BLOG)) fs.mkdirSync(BLOG, { recursive: true });
  const res = [];
  for (const a of ANGLES) {
    const title = a.t(o), slug = a.s(o);
    let content = await ai(a.p(o));
    if (!content) content = fallback(o);
    fs.writeFileSync(path.join(BLOG, `${slug}.html`), html({ title, s: slug, c: content }, oppId), 'utf8');
    res.push({ title, slug, url: `${SITE}/blog/${slug}.html` });
  }
  idx();
  return { success: true, posts: res };
}

export async function generateAllBlogPosts() {
  const { data: ops } = await supabase.from('opportunities').select('id').eq('status', 'published');
  if (!ops?.length) return { error: 'None' };
  const all = [];
  for (const { id } of ops) { const r = await generateBlogPostsForOpportunity(id); if (r.posts) all.push(...r.posts); }
  return { success: true, total: all.length, posts: all };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (process.argv[2] ? generateBlogPostsForOpportunity(process.argv[2]) : generateAllBlogPosts()).then(r => console.log(JSON.stringify(r)));
}
