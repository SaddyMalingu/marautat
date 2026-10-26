/**
 * Sitemap Generator
 * 
 * Dynamically generates sitemap.xml for SEO.
 * Includes AI Jobs pages, categories, and published opportunities.
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { getActiveSources, getActiveCategories, getCategoriesForSource, getOpportunities } from '../utils/aiJobsService.js';

const router = Router();
const SITE_URL = process.env.SITE_URL || 'https://alphadome.onrender.com';

router.get('/sitemap.xml', async (req, res) => {
  try {
    const sources = await getActiveSources();
    const mercor = sources.find(s => s.slug === 'mercor') || null;

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_URL}/discovery</loc>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${SITE_URL}/portfolio.html</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${SITE_URL}/blog</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${SITE_URL}/privacy-policy.html</loc>
    <changefreq>yearly</changefreq>
    <priority>0.2</priority>
  </url>
  <url>
    <loc>${SITE_URL}/ai-jobs</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${SITE_URL}/ai-jobs/mercor</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>`;

    // Published tenant/Writer's Flow pages. They are written to public/blog at
    // runtime, so the sitemap reads the directory the same way /blog does — a
    // page that exists on disk is the definition of "published" here.
    try {
      const blogDir = path.join(process.cwd(), 'public', 'blog');
      if (fs.existsSync(blogDir)) {
        const slugs = fs.readdirSync(blogDir)
          .filter((f) => f.endsWith('.html') && f !== 'index.html')
          .map((f) => f.replace(/\.html$/i, ''))
          .slice(0, 2000);
        for (const slug of slugs) {
          const stat = fs.statSync(path.join(blogDir, slug + '.html'));
          xml += `
  <url>
    <loc>${SITE_URL}/blog/${slug}.html</loc>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
    <lastmod>${stat.mtime.toISOString().slice(0, 10)}</lastmod>
  </url>`;
        }
      }
    } catch (e) {
      console.warn('[Sitemap] blog pages unavailable:', e.message);
    }

    // --- Mercor (legacy paths, unchanged) ---
    const mercorCategories = mercor ? await getCategoriesForSource(mercor.id) : await getActiveCategories();
    for (const cat of mercorCategories) {
      xml += `
  <url>
    <loc>${SITE_URL}/ai-jobs/mercor/${cat.slug}</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`;
    }
    const mercorOpps = await getOpportunities({ limit: 1000, sourceId: mercor?.id });
    for (const opp of mercorOpps) {
      xml += `
  <url>
    <loc>${SITE_URL}/ai-jobs/mercor/opportunity/${opp.slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
    <lastmod>${opp.updated_at || opp.created_at}</lastmod>
  </url>`;
    }

    // --- Additional sources under /ai-jobs/s/:sourceSlug ---
    for (const src of sources) {
      if (src.slug === 'mercor') continue;
      xml += `
  <url>
    <loc>${SITE_URL}/ai-jobs/s/${src.slug}</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`;
      const cats = await getCategoriesForSource(src.id);
      for (const cat of cats) {
        xml += `
  <url>
    <loc>${SITE_URL}/ai-jobs/s/${src.slug}/${cat.slug}</loc>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>`;
      }
      const opps = await getOpportunities({ limit: 1000, sourceId: src.id });
      for (const opp of opps) {
        xml += `
  <url>
    <loc>${SITE_URL}/ai-jobs/s/${src.slug}/opportunity/${opp.slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
    <lastmod>${opp.updated_at || opp.created_at}</lastmod>
  </url>`;
      }
    }

    xml += `
</urlset>`;

    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    console.error('[Sitemap] Error generating sitemap:', err);
    res.status(500).send('Error generating sitemap');
  }
});

export default router;

