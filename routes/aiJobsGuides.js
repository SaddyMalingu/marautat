import { Router } from 'express';
import { FAQ_CONTENT, generateFAQSchema } from '../utils/aiJobsSEO.js';
const SITE_URL = process.env.SITE_URL || 'https://alphadome.onrender.com';
import { getActiveCategories } from '../utils/aiJobsService.js';

const router = Router();

const GUIDES = {
  'what-is-mercor': {
    title: 'What Is Mercor? Complete Guide to the AI Talent Platform',
    description: 'Learn about Mercor, the AI-powered talent platform connecting professionals with opportunities in software engineering, data science, finance, and more.',
    h2s: ['What is Mercor?', 'How Mercor Works', 'Types of Jobs Available', 'Earnings', 'How to Get Started', 'Referral Program'],
    faqs: ['what-is-mercor', 'how-does-mercor-work', 'mercor-earnings', 'mercor-referral-program']
  },
  'how-to-apply-mercor': {
    title: 'How to Apply for Mercor Jobs: Step-by-Step Guide',
    description: 'Complete guide on how to apply for jobs at Mercor. Learn the application process, requirements, and tips to get hired faster.',
    h2s: ['Create Your Profile', 'Complete Skills Assessments', 'Browse Opportunities', 'Submit Applications', 'Interview and Onboarding', 'Tips for Getting Hired'],
    faqs: ['how-to-apply-mercor', 'mercor-earnings']
  },
  'mercor-referral-program': {
    title: 'Mercor Referral Program: Earn 20% of Referred Earnings',
    description: 'Learn how to earn money with the Mercor referral program. Get 20% of eligible referral earnings with twice-weekly payouts.',
    h2s: ['Program Overview', 'How Much Can You Earn?', 'How Payouts Work', 'How to Start Referring', 'Referral Categories', 'Tips for Successful Referrals'],
    faqs: ['mercor-referral-program', 'mercor-earnings']
  },
  'remote-ai-jobs': {
    title: 'Remote AI Jobs: Complete Guide to Working in AI from Anywhere',
    description: 'Discover remote AI jobs available now. Learn about skills needed, companies hiring, and how to land a remote AI position in 2026.',
    h2s: ['Remote AI Jobs Overview', 'Types of Remote AI Jobs', 'Skills Needed', 'Where to Find Remote AI Jobs', 'How to Land a Remote AI Job', 'Salary Expectations'],
    faqs: ['remote-ai-jobs', 'ai-jobs-no-experience', 'best-ai-jobs-2026']
  }
};

router.get('/ai-jobs/guides/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const guide = GUIDES[slug];
    if (!guide) return res.status(404).send('Guide not found');
    
    const categories = await getActiveCategories();
    const faqs = guide.faqs.map(key => FAQ_CONTENT[key]).filter(Boolean);
    const faqSchema = generateFAQSchema(faqs);
    
    res.send(renderGuidePage(guide, faqs, faqSchema, categories, slug));
  } catch (err) {
    console.error('[AI Jobs Guides] Error:', err);
    res.status(500).send('Error loading guide: ' + err.message);
  }
});

function renderGuidePage(guide, faqs, faqSchema, categories, slug) {
  const faqHtml = faqs.map(f => `
    <div class="faq-item">
      <h3>${f.question}</h3>
      <p>${f.answer}</p>
    </div>
  `).join('');

  const categoriesHtml = categories.map(c => `
    <a href="/ai-jobs/mercor/${c.slug}" class="cat-link">${c.name}</a>
  `).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="google-site-verification" content="nQc8r4A_tjZX4469pNlpTR5hf7bfjEazZtITnrrHZUU"><title>${guide.title}</title><meta name="description" content="${guide.description}"><link rel="canonical" href="${SITE_URL}/ai-jobs/guides/${slug}"><script type="application/ld+json">${JSON.stringify(faqSchema)}</script><style>:root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6}*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}.c{max-width:800px;margin:0 auto;padding:0 24px}nav{padding:1rem 0;font-size:.9rem}nav a{color:var(--accent);text-decoration:none}h1{font-size:2.2rem;margin:1rem 0}h2{font-size:1.4rem;color:var(--accent);margin:1.5rem 0 .75rem}h3{font-size:1.1rem;margin:1rem 0 .5rem}p,li{color:var(--muted)}ul,ol{padding-left:1.5rem;margin:.5rem 0}.faq-item{background:rgba(255,255,255,.05);padding:1rem;border-radius:8px;margin:1rem 0}.cat-link{display:inline-block;background:rgba(255,138,0,.2);color:var(--accent);padding:.5rem 1rem;border-radius:20px;margin:.25rem;text-decoration:none}</style></head><body><div class="c"><nav><a href="/">AlphaDome</a> / <a href="/ai-jobs">AI Jobs</a> / <a href="/ai-jobs/guides">Guides</a></nav><h1>${guide.title}</h1><p>${guide.description}</p><h2>${guide.h2s[0]}</h2><p>${guide.description}</p><h2>${guide.h2s[1]}</h2><p>Mercor connects professionals with companies needing specialized skills. The platform handles matching, payments, and project management.</p><h2>${guide.h2s[2]}</h2><p>Opportunities available in: ${categories.map(c=>c.name).join(', ')}.</p><h2>Frequently Asked Questions</h2>${faqHtml}<h2>Browse by Category</h2><div>${categoriesHtml}</div></div></body></html>`;
}

export default router;
