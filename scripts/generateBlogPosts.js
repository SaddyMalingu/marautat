import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SITE_URL = process.env.SITE_URL || 'https://alphadome.onrender.com';
const BLOG_DIR = path.join(process.cwd(), 'public', 'blog');

const TEMPLATES = {
  salary: { t: o=>`${o.title} Salary ${new Date().getFullYear()}`, s: o=>`${o.slug}-salary`, k: o=>[`${o.title} salary`], c: o=>{const h=o.compensation_max||75;return`<h2>${o.title} Salary</h2><p>$${h}/hr | $${h*20}/wk | $${h*80}/mo</p><h2>Factors</h2><ul><li>Skills: ${o.skills?.slice(0,3).join(', ')}</li></ul>`;}},
  howTo: { t: o=>`How to Become ${o.title}`, s: o=>`how-to-${o.slug}`, k: o=>[`how to become ${o.title}`], c: o=>`<h2>How to Become ${o.title}</h2><p>${o.description||''}</p><ul>${(o.skills||[]).map(s=>`<li>${s}</li>`).join('')}</ul>`},
  remote: { t: o=>`Remote ${o.title} Jobs`, s: o=>`remote-${o.slug}-jobs`, k: o=>[`remote ${o.title}`], c: o=>`<h2>Remote ${o.title}</h2><p>Earn $${o.compensation_max||75}/hr remotely.</p><ul><li>Flexibility</li><li>Global clients</li></ul>`},
  skills: { t: o=>`${o.title} Skills ${new Date().getFullYear()}`, s: o=>`${o.slug}-skills`, k: o=>[`${o.title} skills`], c: o=>`<h2>${o.title} Skills</h2><ul>${(o.skills||[]).map(s=>`<li><strong>${s}</strong></li>`).join('')}</ul>`}
};

async function generateBlogPosts() {
  console.log('[Blog Gen] Starting...');
  const { data: opps, error } = await supabase.from('opportunities').select('*, category:opportunity_categories(name)').eq('status', 'published');
  if (error) { console.error('Error:', error); return; }
  if (!opps?.length) { console.log('No published opportunities'); return; }
  console.log(`Found ${opps.length} opportunities`);
  if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });
  const posts = [];
  for (const opp of opps) {
    for (const tpl of Object.values(TEMPLATES)) {
      const post = { title: tpl.t(opp), slug: tpl.s(opp), keywords: tpl.k(opp), content: tpl.c(opp), oppId: opp.id };
      fs.writeFileSync(path.join(BLOG_DIR, `${post.slug}.html`), genHTML(post, opp), 'utf8');
      posts.push({ title: post.title, slug: post.slug });
      console.log(`Generated: ${post.slug}.html`);
    }
  }
  genIndex(posts);
  console.log(`Done! ${posts.length} posts.`);
}

function genHTML(p, o) {
  const schema = {"@context":"https://schema.org","@type":"BlogPosting","headline":p.title,"datePublished":new Date().toISOString(),"author":{"@type":"Organization","name":"AlphaDome"},"keywords":p.keywords.join(',')};
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${p.title} | AlphaDome</title><meta name="description" content="${p.content.replace(/<[^>]*>/g,'').substring(0,160)}"><meta name="keywords" content="${p.keywords.join(', ')}"><link rel="canonical" href="${SITE_URL}/blog/${p.slug}.html"><meta property="og:title" content="${p.title}"><script type="application/ld+json">${JSON.stringify(schema)}</script><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0;font-size:.9rem}nav a{color:var(--accent);text-decoration:none}h1{font-size:2rem;margin:1rem 0}h2{font-size:1.3rem;color:var(--accent);margin:1.5rem 0 .75rem}p,li{color:var(--muted)}ul{padding-left:1.5rem;margin:.5rem 0}.apply{text-align:center;padding:2rem;margin:2rem 0;background:rgba(255,255,255,.05);border-radius:12px}.btn{display:inline-block;background:var(--accent);color:#000;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / <a href="/ai-jobs">AI Jobs</a></nav><h1>${p.title}</h1><p style="color:var(--muted)">${new Date().toLocaleDateString()}</p>${p.content}<div class="apply"><h2>Ready to Apply?</h2><a href="/ai-jobs/apply/${o.id}" class="btn">Apply Now</a></div></div></body></html>`;
}

function genIndex(posts) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>AI Jobs Blog | AlphaDome</title><meta name="description" content="AI jobs articles."><link rel="canonical" href="${SITE_URL}/blog/"><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0}nav a{color:var(--accent);text-decoration:none}h1{font-size:2rem;margin:1rem 0}article{margin:1rem 0;padding:1rem;background:rgba(255,255,255,.05);border-radius:8px}article a{color:var(--accent);text-decoration:none}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / Blog</nav><h1>AI Jobs Blog</h1>${posts.map(p=>`<article><h3><a href="/blog/${p.slug}.html">${p.title}</a></h3></article>`).join('')}</div></body></html>`;
  fs.writeFileSync(path.join(BLOG_DIR, 'index.html'), html, 'utf8');
}

generateBlogPosts().catch(console.error);
