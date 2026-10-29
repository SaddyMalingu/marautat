const SITE_URL = process.env.SITE_URL || 'https://alphadome.com';
import { offerMeta } from './aiJobsService.js';
const STYLE = `<style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}.c{max-width:1200px;margin:0 auto;padding:0 24px}header{padding:2rem 0;text-align:center}h1{font-size:2.5rem;margin-bottom:1rem}.sub{color:var(--muted);margin-bottom:2rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.5rem;padding:2rem 0}.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:1.5rem;text-decoration:none;color:var(--text)}.card:hover{border-color:var(--accent)}.card h3{margin-bottom:.5rem}.card p{color:var(--muted);font-size:.9rem}.disc{text-align:center;padding:2rem;color:var(--muted);font-size:.85rem;border-top:1px solid rgba(255,255,255,.1);margin-top:2rem}nav{padding:1rem 0}nav a{color:var(--accent);text-decoration:none}</style>`;

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderAiJobsLanding(categories, sources, tenants) {
  const cats = categories.map(cat => `<a href="/ai-jobs/mercor/${cat.slug}" class="card"><h3>${cat.name}</h3><p>${cat.description||''}</p></a>`).join('');
  // The businesses running on Alphadome. Each one links to its own hub
  // (/ai-jobs/t/<slug>) — before this section existed, nothing on the site
  // pointed at a hub, so a crawler could only find one if it was shared.
  const hubs = (tenants || []).length
    ? `<header style="padding:2rem 0 .5rem"><h2 style="font-size:1.5rem">Businesses on Alphadome</h2><p class="sub" style="margin-bottom:0">Their offers, written up and kept current.</p></header><div class="grid" style="padding-top:1rem">${tenants.map(t => `<a href="/ai-jobs/t/${encodeURIComponent(t.slug)}" class="card"><h3>${esc(t.name || t.slug)}</h3><p>See what ${esc(t.name || t.slug)} has on offer</p></a>`).join('')}</div>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>AI Jobs | AlphaDome</title><meta name="description" content="Discover AI, machine learning, and remote opportunities."><link rel="canonical" href="${SITE_URL}/ai-jobs">${STYLE}</head><body><div class="c"><nav><a href="/">← AlphaDome</a></nav><header><h1>AI Jobs & Remote Opportunities</h1><p class="sub">Discover opportunities in AI, machine learning, data science, and more.</p></header><div class="grid"><a href="/ai-jobs/mercor" class="card"><h3>Mercor Opportunities</h3><p>Browse all categories</p></a>${cats}</div>${hubs}<div class="disc"><p>AlphaDome is independent. Some links are referral links.</p></div></div></body></html>`;
}

function renderMercorLanding(categories) {
  const cats = categories.map(cat => `<a href="/ai-jobs/mercor/${cat.slug}" class="card"><h3>${cat.name}</h3><p>${cat.description||''}</p></a>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Mercor Jobs | AlphaDome</title><meta name="description" content="Explore Mercor opportunities across all categories."><link rel="canonical" href="${SITE_URL}/ai-jobs/mercor">${STYLE}</head><body><div class="c"><nav><a href="/ai-jobs">← AI Jobs</a></nav><header><h1>Mercor Opportunities</h1><p class="sub">Browse opportunities by category</p></header><div class="grid">${cats}</div><div class="disc"><p>AlphaDome is independent of Mercor. Some links are referral links.</p></div></div></body></html>`;
}

function renderCategoryPage(category, opportunities, opts = {}) {
  const basePath = opts.basePath || '/ai-jobs/mercor';
  const sourceName = opts.sourceName || 'Mercor';
  const opps = opportunities.length > 0 
    ? opportunities.map(o => `<a href="${basePath}/opportunity/${o.slug}" class="card"><h3>${o.title}</h3><p>${o.compensation_max?'$'+o.compensation_max+'/hr':''} ${o.location_text||'Remote'}</p></a>`).join('')
    : '<p style="text-align:center;padding:3rem;color:var(--muted)">No current opportunities. Check back soon!</p>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${category.seo_title||category.name+' | AlphaDome'}</title><meta name="description" content="${category.seo_description||category.description||''}"><link rel="canonical" href="${SITE_URL}${basePath}/${category.slug}">${STYLE}</head><body><div class="c"><nav><a href="${basePath}">← ${sourceName}</a></nav><header><h1>${category.name} Opportunities</h1><p class="sub">${category.description||''}</p></header><div class="grid">${opps}</div><div class="disc"><p>AlphaDome is independent of ${sourceName}.</p></div></div></body></html>`;
}

// Generic source landing page (multi-platform). Used for any source under
// /ai-jobs/s/:sourceSlug (e.g. respondent.io). Mercor keeps its legacy route.
function renderSourceLanding(source, categories) {
  const slug = source?.slug || 'source';
  const name = source?.name || slug;
  const basePath = `/ai-jobs/s/${slug}`;
  const cats = categories.length > 0
    ? categories.map(cat => `<a href="${basePath}/${cat.slug}" class="card"><h3>${cat.name}</h3><p>${cat.description||''}</p></a>`).join('')
    : '<p style="text-align:center;padding:3rem;color:var(--muted)">No current opportunities. Check back soon!</p>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${name} Opportunities | AlphaDome</title><meta name="description" content="Explore ${name} opportunities across all categories."><link rel="canonical" href="${SITE_URL}${basePath}">${STYLE}</head><body><div class="c"><nav><a href="/ai-jobs">← AI Jobs</a></nav><header><h1>${name} Opportunities</h1><p class="sub">Browse opportunities by category</p></header><div class="grid">${cats}</div><div class="disc"><p>AlphaDome is independent of ${name}. Some links are referral links.</p></div></div></body></html>`;
}

// Tenant hub / tenant category — lists a tenant's offers (any type) with type
// badges. Individual offers link to /ai-jobs/t/:tenantSlug/o/:offerSlug.
function renderTenantOffers(tenant, offers, opts = {}) {
  const base = `/ai-jobs/t/${tenant.slug}`;
  const name = tenant.name || tenant.slug;
  const title = opts.title || `${name} — Offers`;
  const sub = opts.sub || `Explore offers from ${name}.`;
  const cards = offers.length > 0
    ? offers.map(o => {
        const meta = offerMeta(o);
        const price = o.compensation_max ? `$${o.compensation_max}${o.compensation_type==='hourly'?'/hr':''}` : '';
        const loc = o.location_text ? ` · ${o.location_text}` : '';
        return `<a href="${base}/o/${o.slug}" class="card"><h3><span class="badge">${meta.label}</span> ${o.title}</h3><p>${price}${loc}</p></a>`;
      }).join('')
    : '<p style="text-align:center;padding:3rem;color:var(--muted)">No offers yet. Check back soon!</p>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${title} | AlphaDome</title><meta name="description" content="${sub}"><link rel="canonical" href="${SITE_URL}${base}">${STYLE}<style>.badge{display:inline-block;background:var(--accent);color:#000;font-size:.65rem;font-weight:700;padding:.1rem .5rem;border-radius:10px;margin-right:.4rem;vertical-align:middle;text-transform:uppercase}</style></head><body><div class="c"><nav><a href="/ai-jobs">← AI Jobs</a></nav><header><h1>${title}</h1><p class="sub">${sub}</p></header><div class="grid">${cards}</div><div class="disc"><p>Powered by AlphaDome.</p></div></div></body></html>`;
}

export { renderAiJobsLanding, renderMercorLanding, renderSourceLanding, renderCategoryPage, renderTenantOffers };
