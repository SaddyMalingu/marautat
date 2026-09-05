import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const sb = createClient(supabaseUrl, supabaseKey);
const SITE = process.env.SITE_URL || 'https://alphadome.onrender.com';
const BLOG = path.join(process.cwd(), 'public', 'blog');
const IMG = path.join(process.cwd(), 'public', 'images', 'blog');
const VM = '<meta name="google-site-verification" content="nQc8r4A_tjZX4469pNlpTR5hf7bfjEazZtITnrrHZUU">';

// Clean AI-generated content
function cleanContent(content) {
  if (!content) return content;
  return content
    .replace(/\*\*([^*]+)\*\*/g, '')
    .replace(/\*([^*]+)\*/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/_{2,}/g, '')
    .replace(/~~([^~]+)~~/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/<\/?strong>/g, '')
    .replace(/<\/?em>/g, '')
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/<li>\s*<\/li>/g, '')
    .trim();
}

// Generate content with HF
async function ai(prompt) {
  try {
    const k = process.env.HF_API_KEY || process.env.HF_API_KEY_WRITERS_FLOW;
    if (!k) { console.log('[AI] No API key'); return null; }
    const axios = (await import('axios')).default;
    const r = await axios.post('https://router.huggingface.co/v1/chat/completions', {
      model: 'meta-llama/Llama-3.1-8B-Instruct:novita',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2500,
      temperature: 0.7
    }, { headers: { Authorization: 'Bearer ' + k }, timeout: 120000 });
    return r.data?.choices?.[0]?.message?.content || null;
  } catch (e) { console.error('[AI] Error:', e.message); return null; }
}

// Generate image with Replicate
async function genImage(prompt, slug) {
  try {
    const t = process.env.REPLICATE_API_TOKEN;
    if (!t) { console.log('[IMG] No API key'); return null; }
    const { default: Replicate } = await import('replicate');
    const rep = new Replicate({ auth: t });
    const out = await rep.run('google/nano-banana-pro', { input: { prompt: 'Professional blog header image: ' + prompt + '. Modern, clean, tech-focused style. High quality, 16:9 aspect ratio. No text overlay.' } });
    if (!fs.existsSync(IMG)) fs.mkdirSync(IMG, { recursive: true });
    const axios = (await import('axios')).default;
    const res = await axios.get(out, { responseType: 'arraybuffer' });
    fs.writeFileSync(path.join(IMG, slug + '.png'), res.data);
    console.log('[IMG] Generated: ' + slug + '.png');
    return '/images/blog/' + slug + '.png';
  } catch (e) { console.error('[IMG] Error:', e.message); return null; }
}

// Review and improve content
async function reviewContent(content, title, opp) {
  const prompt = 'Review and improve this blog post. Remove all asterisks (**), markdown formatting, and AI patterns. Fix inconsistencies. Make it read like a professional human-written article. Ensure proper HTML structure. Content:\n\n' + content;
  const improved = await ai(prompt);
  return improved ? cleanContent(improved) : cleanContent(content);
}

function generateFallbackContent(opp, type) {
  const title = opp.title || 'AI Specialist';
  const salary = opp.compensation_max || 75;
  const skillsList = opp.skills && opp.skills.length > 0 ? opp.skills.join(', ') : 'AI/ML, Python, Prompt Engineering, Evaluation';
  const year = new Date().getFullYear();

  if (type === 'salary') {
    const weekly = salary * 40;
    const monthly = salary * 160;
    const yearly = salary * 2000;
    return `
      <p>As the demand for elite AI and technical talent accelerates in ${year}, the compensation landscape for a <strong>${title}</strong> has become one of the most attractive in the remote knowledge economy. Whether you are transitioning into this discipline or evaluating market opportunities, understanding your commercial valuation is essential.</p>
      <h2>Market Compensation Overview</h2>
      <p>The current benchmark for a <strong>${title}</strong> on leading AI talent platforms reaches up to <strong>$${salary} per hour</strong>. Based on standard working arrangements, here is how this compensation scales:</p>
      <table>
        <thead>
          <tr><th>Timeframe</th><th>Estimated Gross Earnings</th><th>Annualized Context</th></tr>
        </thead>
        <tbody>
          <tr><td>Hourly Rate</td><td>$${salary}/hr</td><td>Base billable rate</td></tr>
          <tr><td>Part-Time (20 hrs/wk)</td><td>$${weekly / 2}/wk</td><td>~$${yearly / 2}/year</td></tr>
          <tr><td>Full-Time (40 hrs/wk)</td><td>$${weekly}/wk</td><td>~$${yearly}/year</td></tr>
          <tr><td>Monthly Projected</td><td>$${monthly}/month</td><td>Consistent billable allocation</td></tr>
        </tbody>
      </table>
      <h2>Key Factors Driving Higher Rates</h2>
      <p>Contractors and professionals commanding top-of-bracket rates typically differentiate themselves in three specific areas:</p>
      <ul>
        <li><strong>Tooling and Stack Mastery:</strong> Exceptional hands-on capability with ${skillsList}.</li>
        <li><strong>Verification and Autonomous Execution:</strong> Delivering reliable, audit-ready deliverables with minimal supervision.</li>
        <li><strong>Domain Synthesis:</strong> Combining technical acuity with practical business understanding to solve high-stakes challenges.</li>
      </ul>
      <h2>Maximizing Your Contracting Potential</h2>
      <p>To capture the upper bound of this salary band, focus on building verifiable proof of work, maintaining transparent communication, and completing platform vetting early. Pre-vetted candidates on modern networks are frequently matched with high-priority assignments ahead of public postings.</p>
    `;
  }

  if (type === 'howto') {
    return `
      <p>The role of a <strong>${title}</strong> represents a pivotal junction in the modern AI ecosystem. Organizations building next-generation workflows require specialized professionals who can navigate complex technical domains with precision and speed.</p>
      <h2>What Does a ${title} Do?</h2>
      <p>In this capacity, you are tasked with architecting solutions, validating intelligent models, and applying rigorous domain standards to production pipelines. Daily responsibilities often center around ${skillsList}, collaborating with distributed engineering teams, and solving non-trivial problems in real time.</p>
      <h2>Core Roadmap to Qualification</h2>
      <ol>
        <li><strong>Master the Foundations:</strong> Solidify your command of core competencies, particularly ${skillsList}.</li>
        <li><strong>Build a Portfolio of Applied Work:</strong> Create tangible repositories, benchmarks, or case studies demonstrating real-world problem solving.</li>
        <li><strong>Complete Platform Assessments:</strong> Undergo thorough technical evaluations on discovery platforms like Mercor to verify your domain depth.</li>
        <li><strong>Maintain Fast Turnarounds:</strong> Build a reputation for clean execution, dependable velocity, and accurate self-direction.</li>
      </ol>
      <h2>Earning Potential and Opportunities</h2>
      <p>With market rates reaching up to <strong>$${salary}/hr</strong>, this career path offers top-tier compensation combined with the autonomy of remote work. Explore active openings and submit your credentials to secure direct matching.</p>
    `;
  }

  if (type === 'remote') {
    return `
      <p>Remote opportunities for a <strong>${title}</strong> have seen exponential growth over the past year. Organizations worldwide are bypassing geographic borders to source top-tier domain experts capable of delivering high-impact outcomes from anywhere.</p>
      <h2>The Shift Toward Global Remote AI Talent</h2>
      <p>Modern remote arrangements for roles like ${title} provide unprecedented flexibility alongside competitive global compensation. Qualified specialists can earn up to <strong>$${salary}/hr</strong>, working on cutting-edge systems without relocation constraints.</p>
      <h2>Essential Skills for Remote Success</h2>
      <ul>
        <li><strong>Asynchronous Communication:</strong> Clear documentation, concise status updates, and structured deliverables.</li>
        <li><strong>Technical Autonomy:</strong> Deep capability in ${skillsList} without continuous handholding.</li>
        <li><strong>Self-Directed Quality Assurance:</strong> Delivering production-ready work that passes review on first submission.</li>
      </ul>
      <h2>How to Secure High-Paying Remote Roles</h2>
      <p>Rather than submitting hundreds of cold applications on traditional job boards, forward-thinking specialists leverage specialized discovery networks. Platforms like Mercor directly match qualified candidates with clients based on verified skill assessments.</p>
    `;
  }

  return `
    <p>Success as a <strong>${title}</strong> hinges on a carefully curated blend of specialized technical depth and operational discipline. As AI frameworks evolve, the specific capabilities required to excel in this field continue to rise.</p>
    <h2>Essential Technical Competencies</h2>
    <p>Top-earning specialists in this discipline demonstrate mastery across key tools and disciplines, notably <strong>${skillsList}</strong>. Critical proficiencies include:</p>
    <ul>
      <li><strong>Architecture & Logic:</strong> Systematic breakdown of technical constraints and rapid prototyping.</li>
      <li><strong>Domain Precision:</strong> Deep understanding of evaluation criteria, benchmark reliability, and optimization patterns.</li>
      <li><strong>Integration & Tooling:</strong> Seamless incorporation into modern development stacks, APIs, and automated test harnesses.</li>
    </ul>
    <h2>Soft Skills That Command Higher Rates</h2>
    <p>While technical prowess opens doors, communication and dependability dictate rate growth. Roles paying up to <strong>$${salary}/hr</strong> require proactive risk identification, structured status tracking, and flawless asynchronous collaboration.</p>
    <h2>Continuous Skill Acceleration</h2>
    <p>The most effective strategy for maintaining high hourly rates is continuous hands-on experimentation. Regularly evaluate new frameworks, engage with live technical benchmarks, and maintain an active candidate profile on talent networks.</p>
  `;
}

// Generate unique content
async function generateContent(opp, type) {
  const title = opp.title;
  const salary = opp.compensation_max || 75;
  const skills = opp.skills?.join(', ') || 'AI/ML, programming';
  
  const prompts = {
    salary: 'Write a professional blog post about "' + title + '" salary in ' + new Date().getFullYear() + '. Hourly rate: $' + salary + '/hr. Include: introduction, salary breakdown (hourly/weekly/monthly/yearly), factors affecting pay, comparison table with similar roles, tips to increase earnings, conclusion. NO asterisks or markdown. HTML format only.',
    howto: 'Write a professional blog post about becoming a "' + title + '". Skills: ' + skills + '. Include: introduction, what the role involves, required skills, career path steps, salary expectations ($' + salary + '/hr), how to get hired, conclusion. NO asterisks or markdown. HTML format only.',
    remote: 'Write a professional blog post about remote "' + title + '" jobs. Salary: $' + salary + '/hr. Include: benefits of remote work, how to find opportunities, skills needed, tips for success, conclusion. NO asterisks or markdown. HTML format only.',
    skills: 'Write a professional blog post about top skills for "' + title + '". Technical skills: ' + skills + '. Include: technical skills, soft skills, how to develop them, salary impact ($' + salary + '/hr), conclusion. NO asterisks or markdown. HTML format only.'
  };
  
  const content = await ai(prompts[type] || prompts.salary);
  if (content) return cleanContent(content);
  return generateFallbackContent(opp, type);
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
  var list = posts.map(function(p){return '<article style="margin:1rem 0;padding:1.5rem;background:rgba(255,255,255,.05);border-radius:12px"><h3 style="margin:0 0 .5rem"><a href="/blog/'+p.slug+'.html" style="color:var(--accent);text-decoration:none">'+p.title+'</a></h3><a href="/blog/'+p.slug+'.html" style="color:var(--muted);font-size:.9rem">Read more</a></article>';}).join('');
  fs.writeFileSync(path.join(BLOG,'index.html'),'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>AI Jobs Blog | AlphaDome</title><meta name="description" content="AI jobs articles, salaries, skills, and career guides."><link rel="canonical" href="'+SITE+'/blog/"><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0}nav a{color:var(--accent);text-decoration:none}h1{font-size:2rem;margin:1rem 0}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / Blog</nav><h1>AI Jobs Blog</h1><p style="color:var(--muted)">Articles about AI jobs, salaries, skills, and career guides.</p>'+list+'<p style="color:var(--muted);margin-top:2rem">Total: '+posts.length+' articles</p></div></body></html>','utf8');
}

export async function generateBlogPostsForOpportunity(oppId, opts) {
  opts = opts || {};
  var rev = opts.review !== false;
  var img = opts.images !== false;
  var d = await sb.from('opportunities').select('*').eq('id', oppId).single();
  var o = d.data;
  if (!o) return { error: 'Not found' };
  if (!fs.existsSync(BLOG)) fs.mkdirSync(BLOG, { recursive: true });
  console.log('[GEN] Generating blogs for: ' + o.title);
  
  var angles = [
    { t: o.title + ' Salary ' + new Date().getFullYear(), s: o.slug + '-salary', type: 'salary' },
    { t: 'How to Become ' + o.title, s: 'how-to-' + o.slug, type: 'howto' },
    { t: 'Remote ' + o.title + ' Jobs', s: 'remote-' + o.slug + '-jobs', type: 'remote' },
    { t: o.title + ' Skills ' + new Date().getFullYear(), s: o.slug + '-skills', type: 'skills' }
  ];
  
  var res = [];
  for (var i = 0; i < angles.length; i++) {
    var a = angles[i];
    console.log('[GEN] - ' + a.type + ': ' + a.s);
    var content = await generateContent(o, a.type);
    if (!content) { console.log('[GEN] Failed: ' + a.s); continue; }
    if (rev) content = await reviewContent(content, a.t, o);
    var thumb = null;
    if (img) thumb = await genImage(o.title + ' professional workspace', a.s);
    fs.writeFileSync(path.join(BLOG, a.s + '.html'), buildHTML({ title: a.t, slug: a.s, content: content, thumb: thumb }, oppId), 'utf8');
    res.push({ title: a.t, slug: a.s, url: SITE + '/blog/' + a.s + '.html', thumb: thumb });
  }
  updateIndex();
  console.log('[GEN] Complete: ' + res.length + ' posts');
  return { success: true, posts: res };
}

export async function reviewBlog(slug) {
  var file = path.join(BLOG, slug + '.html');
  if (!fs.existsSync(file)) return { error: 'Not found' };
  var content = fs.readFileSync(file, 'utf8');
  var titleMatch = content.match(/<h1>(.*?)<\/h1>/);
  var title = titleMatch ? titleMatch[1] : slug;
  var oppIdMatch = content.match(/\/ai-jobs\/apply\/([a-zA-Z0-9_-]+)/);
  var oppId = oppIdMatch ? oppIdMatch[1] : '';
  var imgMatch = content.match(/<img src="(\/images\/blog\/[^"]+)"/);
  var thumb = imgMatch ? imgMatch[1] : null;

  var articleMatch = content.match(/<article>([\s\S]*?)<\/article>/);
  var body = articleMatch ? articleMatch[1] : content;
  body = body.replace(/<h1>.*?<\/h1>/, '').replace(/<p style="color:var\(--muted\)[^>]*>.*?<\/p>/, '').replace(/<img[^>]*>/, '');

  var reviewed = await reviewContent(body, title, { title: slug, compensation_max: 75, skills: ['AI'] });
  if (reviewed) {
    fs.writeFileSync(file, buildHTML({ title: title, slug: slug, content: reviewed, thumb: thumb }, oppId), 'utf8');
  }
  return { success: true, slug: slug };
}

export async function reviewAllBlogs() {
  if (!fs.existsSync(BLOG)) return { error: 'No blogs' };
  var f = fs.readdirSync(BLOG).filter(function(x){return x.endsWith('.html') && x !== 'index.html';});
  var res = [];
  for (var i = 0; i < f.length; i++) {
    var slug = f[i].replace('.html','');
    await reviewBlog(slug);
    res.push(slug);
  }
  return { success: true, reviewed: res.length, posts: res };
}

export async function generateAllBlogs(opts) {
  var d = await sb.from('opportunities').select('id').eq('status', 'published');
  var ops = d.data;
  if (!ops || !ops.length) return { error: 'None' };
  var all = [];
  for (var i = 0; i < ops.length; i++) {
    var r = await generateBlogPostsForOpportunity(ops[i].id, opts);
    if (r && r.posts) all = all.concat(r.posts);
  }
  return { success: true, total: all.length, posts: all };
}

export const generateAllBlogPosts = generateAllBlogs;

if (import.meta.url === 'file://' + process.argv[1]) {
  var id = process.argv[2], act = process.argv[3], slug = process.argv[4];
  (act === 'review' ? (slug ? reviewBlog(slug) : reviewAllBlogs()) : id ? generateBlogPostsForOpportunity(id) : generateAllBlogs()).then(function(r){console.log(JSON.stringify(r));});
}
