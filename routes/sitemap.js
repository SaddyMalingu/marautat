/**
 * Sitemap Generator
 * 
 * Dynamically generates sitemap.xml for SEO.
 * Includes AI Jobs pages, categories, and published opportunities.
 */

import { Router } from 'express';
import { getActiveCategories, getOpportunities } from '../utils/aiJobsService.js';

const router = Router();
const SITE_URL = process.env.SITE_URL || 'https://alphadome.com';

router.get('/sitemap.xml', async (req, res) => {
  try {
    const categories = await getActiveCategories();
    const opportunities = await getOpportunities({ limit: 1000 });
    
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
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
    
    // Add category pages
    for (const cat of categories) {
      xml += `
  <url>
    <loc>${SITE_URL}/ai-jobs/mercor/${cat.slug}</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`;
    }
    
    // Add opportunity pages
    for (const opp of opportunities) {
      xml += `
  <url>
    <loc>${SITE_URL}/ai-jobs/mercor/opportunity/${opp.slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
    <lastmod>${opp.updated_at || opp.created_at}</lastmod>
  </url>`;
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
