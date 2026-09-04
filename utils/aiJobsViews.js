const SITE_URL = process.env.SITE_URL || 'https://alphadome.com';
const STYLE = `<style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}.c{max-width:1200px;margin:0 auto;padding:0 24px}header{padding:2rem 0;text-align:center}h1{font-size:2.5rem;margin-bottom:1rem}.sub{color:var(--muted);margin-bottom:2rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.5rem;padding:2rem 0}.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:1.5rem;text-decoration:none;color:var(--text)}.card:hover{border-color:var(--accent)}.card h3{margin-bottom:.5rem}.card p{color:var(--muted);font-size:.9rem}.disc{text-align:center;padding:2rem;color:var(--muted);font-size:.85rem;border-top:1px solid rgba(255,255,255,.1);margin-top:2rem}nav{padding:1rem 0}nav a{color:var(--accent);text-decoration:none}</style>`;

function renderAiJobsLanding(categories, sources) {
  const cats = categories.map(cat => `<a href="/ai-jobs/mercor/${cat.slug}" class="card"><h3>${cat.name}</h3><p>${cat.description||''}</p></a>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>AI Jobs | AlphaDome</title><meta name="description" content="Discover AI, machine learning, and remote opportunities."><link rel="canonical" href="${SITE_URL}/ai-jobs">${STYLE}</head><body><div class="c"><nav><a href="/">← AlphaDome</a></nav><header><h1>AI Jobs & Remote Opportunities</h1><p class="sub">Discover opportunities in AI, machine learning, data science, and more.</p></header><div class="grid"><a href="/ai-jobs/mercor" class="card"><h3>Mercor Opportunities</h3><p>Browse all categories</p></a>${cats}</div><div class="disc"><p>AlphaDome is independent. Some links are referral links.</p></div></div></body></html>`;
}

function renderMercorLanding(categories) {
  const cats = categories.map(cat => `<a href="/ai-jobs/mercor/${cat.slug}" class="card"><h3>${cat.name}</h3><p>${cat.description||''}</p></a>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Mercor Jobs | AlphaDome</title><meta name="description" content="Explore Mercor opportunities across all categories."><link rel="canonical" href="${SITE_URL}/ai-jobs/mercor">${STYLE}</head><body><div class="c"><nav><a href="/ai-jobs">← AI Jobs</a></nav><header><h1>Mercor Opportunities</h1><p class="sub">Browse opportunities by category</p></header><div class="grid">${cats}</div><div class="disc"><p>AlphaDome is independent of Mercor. Some links are referral links.</p></div></div></body></html>`;
}

function renderCategoryPage(category, opportunities) {
  const opps = opportunities.length > 0 
    ? opportunities.map(o => `<a href="/ai-jobs/mercor/opportunity/${o.slug}" class="card"><h3>${o.title}</h3><p>${o.compensation_max?'$'+o.compensation_max+'/hr':''} ${o.location_text||'Remote'}</p></a>`).join('')
    : '<p style="text-align:center;padding:3rem;color:var(--muted)">No current opportunities. Check back soon!</p>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${category.seo_title||category.name+' | AlphaDome'}</title><meta name="description" content="${category.seo_description||category.description||''}"><link rel="canonical" href="${SITE_URL}/ai-jobs/mercor/${category.slug}">${STYLE}</head><body><div class="c"><nav><a href="/ai-jobs/mercor">← Mercor</a></nav><header><h1>${category.name} Opportunities</h1><p class="sub">${category.description||''}</p></header><div class="grid">${opps}</div><div class="disc"><p>AlphaDome is independent of Mercor.</p></div></div></body></html>`;
}

export { renderAiJobsLanding, renderMercorLanding, renderCategoryPage };
