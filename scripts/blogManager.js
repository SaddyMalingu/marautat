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
const STYLE = '<style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0;font-size:.9rem}nav a{color:var(--accent);text-decoration:none}h1{font-size:2rem;margin:1rem 0}h2{font-size:1.3rem;color:var(--accent);margin:1.5rem 0 .75rem}p,li{color:var(--muted)}ul,ol{padding-left:1.5rem;margin:.5rem 0}img{max-width:100%;border-radius:8px;margin:1rem 0}.apply{text-align:center;padding:2rem;margin:2rem 0;background:rgba(255,255,255,.05);border-radius:12px}.btn{display:inline-block;background:var(--accent);color:#000;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600}</style>';

export async function ai(p) {
  try {
    const k = process.env.HF_API_KEY || process.env.HF_API_KEY_WRITERS_FLOW;
    if (!k) return null;
    const axios = (await import("axios")).default;
    const r = await axios.post("https://router.huggingface.co/v1/chat/completions", {
      model: "meta-llama/Llama-3.1-8B-Instruct:novita",
      messages: [{ role: "user", content: p }],
      max_tokens: 2000,
      temperature: 0.7
    }, { headers: { Authorization: "Bearer " + k }, timeout: 90000 });
    return r.data?.choices?.[0]?.message?.content || null;
  } catch (e) { return null; }
}

export async function genImage(p, s) {
  try {
    const t = process.env.REPLICATE_API_TOKEN;
    if (!t) return null;
    const { default: Replicate } = await import("replicate");
    const rep = new Replicate({ auth: t });
    const out = await rep.run("google/nano-banana-pro", { input: { prompt: "Professional blog header: " + p + ". Modern, clean, tech. 16:9." } });
    if (!fs.existsSync(IMG)) fs.mkdirSync(IMG, { recursive: true });
    const axios = (await import("axios")).default;
    const res = await axios.get(out, { responseType: "arraybuffer" });
    fs.writeFileSync(path.join(IMG, s + ".png"), res.data);
    return "/images/blog/" + s + ".png";
  } catch (e) { return null; }
}

export async function review(c, t, o) {
  var r = await ai("Review and improve this blog post for \"" + t + "\". Make it more engaging, add SEO subheadings, improve readability, add bullet points, compelling CTA. Job: " + o.title + ", Salary: $" + (o.compensation_max || 75) + "/hr, Skills: " + (o.skills?.join(",") || "AI") + ". Return ONLY improved HTML:\n\n" + c);
  return r || c;
}

var ANGLES = [
  { t: function(o){return o.title + " Salary " + new Date().getFullYear();}, s: function(o){return o.slug + "-salary";}, type: "salary" },
  { t: function(o){return "How to Become " + o.title;}, s: function(o){return "how-to-" + o.slug;}, type: "howto" },
  { t: function(o){return "Remote " + o.title + " Jobs";}, s: function(o){return "remote-" + o.slug + "-jobs";}, type: "remote" },
  { t: function(o){return o.title + " Skills " + new Date().getFullYear();}, s: function(o){return o.slug + "-skills";}, type: "skills" }
];

function prompt(o, type) {
  var p = {
    salary: "Write SEO blog: \"" + o.title + "\" salary. $" + (o.compensation_max || 75) + "/hr. Weekly/monthly/yearly. Skills: " + (o.skills?.join(",") || "AI") + ". HTML, subheadings, bullet points, CTA.",
    howto: "Write: becoming \"" + o.title + "\". Skills: " + (o.skills?.join(",") || "tech") + ". Career path, steps, salary $" + (o.compensation_max || 75) + "/hr. HTML, motivational, CTA.",
    remote: "Write: remote \"" + o.title + "\" jobs. $" + (o.compensation_max || 75) + "/hr. Benefits, how to get hired. HTML, CTA.",
    skills: "Write: \"" + o.title + "\" skills. Tech: " + (o.skills?.join(",") || "AI") + ". Soft skills, salary impact. HTML."
  };
  return p[type] || p.salary;
}

function fallback(o) { return "<h2>" + o.title + "</h2><p>$" + (o.compensation_max || 75) + "/hr</p><ul>" + (o.skills || []).map(function(s){return "<li>" + s + "</li>";}).join("") + "</ul>"; }

function blogHTML(p, id) {
  var sc = { "@context": "https://schema.org", "@type": "BlogPosting", "headline": p.title, "datePublished": new Date().toISOString(), "author": { "@type": "Organization", "name": "AlphaDome" }, "image": p.thumb };
  var img = p.thumb ? "<img src=\"" + p.thumb + "\" alt=\"" + p.title + "\" style=\"width:100%;max-height:400px;object-fit:cover\">" : "";
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\">" + VM + "<title>" + p.title + " | AlphaDome</title><meta name=\"description\" content=\"" + p.c.replace(/<[^>]*>/g, "").substring(0,160) + "\"><link rel=\"canonical\" href=\"" + SITE + "/blog/" + p.s + ".html\"><meta property=\"og:title\" content=\"" + p.title + "\"><meta property=\"og:image\" content=\"" + (p.thumb || "") + "\"><meta property=\"og:type\" content=\"article\"><script type=\"application/ld+json\">" + JSON.stringify(sc) + "</script>" + STYLE + "</head><body><div class=\"c\"><nav><a href=\"/\">AlphaDome</a> / <a href=\"/ai-jobs\">AI Jobs</a> / <a href=\"/blog\">Blog</a></nav><h1>" + p.title + "</h1><p style=\"color:var(--muted)\">" + new Date().toLocaleDateString() + "</p>" + img + p.c + "<div class=\"apply\"><h2>Ready to Apply?</h2><a href=\"/ai-jobs/apply/" + id + "\" class=\"btn\">Apply Through Mercor</a></div></div></body></html>";
}

function updateIndex() {
  if (!fs.existsSync(BLOG)) return;
  var files = fs.readdirSync(BLOG).filter(function(x){return x.endsWith(".html") && x !== "index.html";});
  var list = files.map(function(x){var s = x.replace(".html","");return "<article style=\"margin:1rem 0;padding:1rem;background:rgba(255,255,255,.05);border-radius:8px\"><h3><a href=\"/blog/" + s + ".html\" style=\"color:var(--accent);text-decoration:none\">" + s.replace(/-/g," ").replace(/\b\w/g,function(c){return c.toUpperCase();}) + "</a></h3></article>";}).join("");
  fs.writeFileSync(path.join(BLOG, "index.html"), "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><title>AI Jobs Blog | AlphaDome</title><link rel=\"canonical\" href=\"" + SITE + "/blog/\">" + STYLE + "</head><body><div class=\"c\"><nav><a href=\"/\">AlphaDome</a> / Blog</nav><h1>AI Jobs Blog</h1>" + list + "</div></body></html>", "utf8");
}

export async function generateBlogPostsForOpportunity(oppId, opts) {
  opts = opts || {};
  var rev = opts.review !== false;
  var img = opts.images !== false;
  var d = await sb.from("opportunities").select("*").eq("id", oppId).single();
  var o = d.data;
  if (!o) return { error: "Not found" };
  if (!fs.existsSync(BLOG)) fs.mkdirSync(BLOG, { recursive: true });
  var res = [];
  for (var i = 0; i < ANGLES.length; i++) {
    var a = ANGLES[i];
    var title = a.t(o), slug = a.s(o);
    var content = await ai(prompt(o, a.type));
    if (!content) content = fallback(o);
    if (rev) content = await review(content, title, o);
    var thumb = null;
    if (img) thumb = await genImage(o.title + " professional work", slug);
    fs.writeFileSync(path.join(BLOG, slug + ".html"), blogHTML({ title: title, s: slug, c: content, thumb: thumb }, oppId), "utf8");
    res.push({ title: title, slug: slug, url: SITE + "/blog/" + slug + ".html", thumb: thumb });
  }
  updateIndex();
  return { success: true, posts: res };
}

export async function reviewAllBlogs() {
  if (!fs.existsSync(BLOG)) return { error: "No blogs" };
  var f = fs.readdirSync(BLOG).filter(function(x){return x.endsWith(".html") && x !== "index.html";});
  var res = [];
  for (var i = 0; i < f.length; i++) {
    var file = f[i];
    var slug = file.replace(".html","");
    var c = fs.readFileSync(path.join(BLOG, file), "utf8");
    var t = (c.match(/<h1>(.*?)<\/h1>/) || [])[1] || slug;
    var improved = await review(c, t, { title: slug, compensation_max: 75, skills: ["AI"] });
    if (improved && improved !== c) { fs.writeFileSync(path.join(BLOG, file), improved, "utf8"); res.push(slug); }
  }
  return { success: true, reviewed: res.length, posts: res };
}

export async function generateAllBlogPosts(opts) {
  var d = await sb.from("opportunities").select("id").eq("status", "published");
  var ops = d.data;
  if (!ops || !ops.length) return { error: "None" };
  var all = [];
  for (var i = 0; i < ops.length; i++) {
    var r = await generateBlogPostsForOpportunity(ops[i].id, opts);
    if (r.posts) all = all.concat(r.posts);
  }
  return { success: true, total: all.length, posts: all };
}

if (import.meta.url === "file://" + process.argv[1]) {
  var id = process.argv[2], act = process.argv[3];
  (act === "review" ? reviewAllBlogs() : id ? generateBlogPostsForOpportunity(id) : generateAllBlogPosts()).then(function(r){console.log(JSON.stringify(r));});
}
