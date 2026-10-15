const SITE_URL = process.env.SITE_URL || 'https://alphadome.onrender.com';
import { offerMeta } from './aiJobsService.js';

function renderOfferPage(opportunity, opts = {}) {
  const sourceName = opts.sourceName || 'Mercor';
  const basePath = opts.basePath || '/ai-jobs/mercor';
  const canonicalBase = opts.canonicalBase || '/ai-jobs/mercor/opportunity';
  const meta = offerMeta(opportunity);
  const isJob = meta.type === 'job';
  const comp = opportunity.compensation_max
    ? (isJob ? `$${opportunity.compensation_max}${opportunity.compensation_type==='hourly'?'/hr':''}` : `${opportunity.compensation_currency||'USD'} ${opportunity.compensation_max}`)
    : (isJob ? 'Not specified' : (meta.priceLabel ? 'Contact for pricing' : '—'));
  const skills = (opportunity.skills||[]).map(s=>`<span class="tag">${s}</span>`).join('');
  const catSlug = opportunity.category?.slug || '';
  const catName = opportunity.category?.name || 'Category';
  const schemaTypeMap = { product: 'Product', service: 'Service', course: 'Course', affiliate: 'Product', brand: 'Organization' };
  const schema = isJob ? {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": opportunity.title,
    "description": opportunity.description || "",
    "datePosted": opportunity.published_at || opportunity.created_at,
    "jobLocation": {"@type": "Place", "address": opportunity.location_text || "Remote"},
    "baseSalary": {"@type": "MonetaryAmount", "currency": "USD", "value": {"@type": "QuantitativeValue", "value": opportunity.compensation_max || 0, "unitText": "HOUR"}},
    "hiringOrganization": {"@type": "Organization", "name": sourceName}
  } : {
    "@context": "https://schema.org",
    "@type": schemaTypeMap[meta.type] || "Product",
    "name": opportunity.title,
    "description": opportunity.description || "",
    "brand": {"@type": "Brand", "name": sourceName}
  };
  const applyHeading = isJob ? 'How to Apply' : (meta.type === 'product' ? 'How to Order' : 'How to Get Started');
  const applyText = isJob
    ? `Click below to apply through ${sourceName}. You will be redirected to complete your application.`
    : `Click below to ${meta.cta.toLowerCase()} via ${sourceName}. You will be redirected to complete your request.`;
  const applyBtn = isJob ? `Apply Through ${sourceName}` : `${meta.cta}${sourceName ? ' via ' + sourceName : ''}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="google-site-verification" content="nQc8r4A_tjZX4469pNlpTR5hf7bfjEazZtITnrrHZUU"><title>${opportunity.title} | AlphaDome</title><meta name="description" content="${(opportunity.description||'').substring(0,160)}"><link rel="canonical" href="${SITE_URL}${canonicalBase}/${opportunity.slug}"><meta property="og:title" content="${opportunity.title} | AlphaDome"><meta property="og:description" content="${(opportunity.description||'').substring(0,160)}"><meta property="og:type" content="article"><script type="application/ld+json">${JSON.stringify(schema)}</script><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;font-size:.9rem}nav a{color:var(--accent);text-decoration:none}nav .sep{color:var(--muted)}h1{font-size:2rem;margin-bottom:1rem}.meta{display:flex;flex-wrap:wrap;gap:1rem;color:var(--muted);margin-bottom:1rem}.comp{color:var(--accent);font-weight:600;font-size:1.2rem}.skills{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem}.tag{background:rgba(255,138,0,.2);color:var(--accent);padding:.25rem .75rem;border-radius:20px;font-size:.85rem}.section{padding:1.5rem 0;border-bottom:1px solid rgba(255,255,255,.05)}.section h2{font-size:1.2rem;margin-bottom:.75rem;color:var(--accent)}.apply{text-align:center;padding:2rem 0}.btn{display:inline-block;background:var(--accent);color:#000;padding:1rem 2rem;border-radius:8px;text-decoration:none;font-weight:600}.disc{text-align:center;padding:2rem;color:var(--muted);font-size:.85rem;border-top:1px solid rgba(255,255,255,.1);margin-top:2rem}.related{margin-top:2rem;padding:1rem;background:rgba(255,255,255,.05);border-radius:8px}.related h3{margin-bottom:.5rem;color:var(--accent)}.related a{display:block;color:var(--text);text-decoration:none;padding:.25rem 0}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> <span class="sep">/</span> <a href="/ai-jobs">AI Jobs</a> <span class="sep">/</span> <a href="${basePath}">${sourceName}</a> <span class="sep">/</span> <a href="${basePath}/${catSlug}">${catName}</a></nav><h1>${opportunity.title}</h1><div class="meta"><span class="comp">${comp}</span> <span>📍 ${opportunity.location_text||'Remote'}</span> <span>⏱ ${opportunity.employment_type||'Contract'}</span></div>${skills?`<div class="skills">${skills}</div>`:''}</div><div class="c"><div class="section"><h2>About This Opportunity</h2><p>${opportunity.description||'No description available.'}</p></div><div class="section"><h2>${applyHeading}</h2><p>${applyText}</p></div><div class="apply"><a href="/ai-jobs/apply/${opportunity.id}" class="btn">${applyBtn}</a></div><div class="related"><h3>Related Resources</h3><a href="/ai-jobs/guides/how-to-apply-mercor">How to Apply for Mercor Jobs</a><a href="/ai-jobs/guides/what-is-mercor">What is Mercor?</a><a href="/ai-jobs/guides/mercor-referral-program">Mercor Referral Program</a><a href="/ai-jobs/guides/remote-ai-jobs">Remote AI Jobs Guide</a></div><div class="disc"><p>AlphaDome is independent of ${sourceName}. This is a referral link.</p></div></div></body></html>`;
}

export { renderOfferPage, renderOfferPage as renderOpportunityPage };
