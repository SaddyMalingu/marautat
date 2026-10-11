/**
 * AI Jobs Routes - Part 1: Routes & Controllers
 * 
 * Handles all /ai-jobs/* endpoints for the opportunity discovery subsystem.
 */

import { Router } from 'express';
import {
  getActiveSources,
  getSourceBySlug,
  getActiveCategories,
  getCategoriesForSource,
  getCategoryBySlug,
  getOpportunities,
  getOpportunityBySlug,
  trackEvent
} from '../utils/aiJobsService.js';
import {
  resolveReferralUrl,
  isValidReferralUrl,
  DEFAULT_REFERRAL_URLS
} from '../utils/aiJobsConfig.js';
import {
  renderAiJobsLanding,
  renderMercorLanding,
  renderSourceLanding,
  renderCategoryPage
} from '../utils/aiJobsViews.js';
import { renderOpportunityPage } from '../utils/aiJobsViewsOpp.js';

const router = Router();

// Helper: Extract tracking info from request
function getTrackingInfo(req) {
  return {
    sessionId: req.query.session_id || req.headers['x-session-id'] || null,
    anonymousId: req.query.anonymous_id || req.headers['x-anonymous-id'] || null,
    referrer: req.get('Referrer') || req.query.referrer || null,
    utmSource: req.query.utm_source || null,
    utmMedium: req.query.utm_medium || null,
    utmCampaign: req.query.utm_campaign || null
  };
}

// GET /ai-jobs - Main AI Jobs landing page
router.get('/', async (req, res) => {
  try {
    const categories = await getActiveCategories();
    const sources = await getActiveSources();
    await trackEvent({ eventType: 'page_view', ...getTrackingInfo(req), metadata: { page: 'ai-jobs-landing' } });
    res.send(renderAiJobsLanding(categories, sources));
  } catch (err) {
    console.error('[AI Jobs] Error rendering landing page:', err);
    res.status(500).send('Error loading AI Jobs page');
  }
});

// GET /ai-jobs/mercor - Mercor opportunities landing page
router.get('/mercor', async (req, res) => {
  try {
    const sources = await getActiveSources();
    const mercor = sources.find(s => s.slug === 'mercor');
    const categories = await getActiveCategories();
    await trackEvent({ eventType: 'page_view', ...getTrackingInfo(req), metadata: { page: 'mercor-landing' } });
    res.send(renderMercorLanding(categories, mercor));
  } catch (err) {
    console.error('[AI Jobs] Error rendering Mercor page:', err);
    res.status(500).send('Error loading Mercor page');
  }
});

// GET /ai-jobs/mercor/:categorySlug - Category page
router.get('/mercor/:categorySlug', async (req, res) => {
  try {
    const { categorySlug } = req.params;
    const category = await getCategoryBySlug(categorySlug);
    if (!category) return res.status(404).send('Category not found');
    const opportunities = await getOpportunities({ categoryId: category.id, limit: 50 });
    await trackEvent({ categoryId: category.id, eventType: 'category_view', ...getTrackingInfo(req), metadata: { category: categorySlug } });
    res.send(renderCategoryPage(category, opportunities));
  } catch (err) {
    console.error('[AI Jobs] Error rendering category page:', err);
    res.status(500).send('Error loading category page');
  }
});

// GET /ai-jobs/mercor/opportunity/:slug - Individual opportunity page
router.get('/mercor/opportunity/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const opportunity = await getOpportunityBySlug(slug);
    if (!opportunity) return res.status(404).send('Opportunity not found');
    const referralUrl = resolveReferralUrl(opportunity, opportunity.category, DEFAULT_REFERRAL_URLS.general);
    await trackEvent({ opportunityId: opportunity.id, categoryId: opportunity.category_id, eventType: 'opportunity_view', ...getTrackingInfo(req), metadata: { opportunity: slug } });
    res.send(renderOpportunityPage(opportunity, referralUrl));
  } catch (err) {
    console.error('[AI Jobs] Error rendering opportunity page:', err);
    res.status(500).send('Error loading opportunity page');
  }
});

// ============================================================================
// MULTI-PLATFORM SOURCE ROUTES (additive — legacy /mercor routes above intact)
// Any opportunity source (respondent.io, etc.) is served under /ai-jobs/s/:slug
// ============================================================================

// GET /ai-jobs/s/:sourceSlug - generic source landing (e.g. respondent.io)
router.get('/s/:sourceSlug', async (req, res) => {
  try {
    const { sourceSlug } = req.params;
    const source = await getSourceBySlug(sourceSlug);
    if (!source) return res.status(404).send('Source not found');
    const categories = await getCategoriesForSource(source.id);
    await trackEvent({ eventType: 'page_view', ...getTrackingInfo(req), metadata: { page: 'source-landing', source: sourceSlug } });
    res.send(renderSourceLanding(source, categories));
  } catch (err) {
    console.error('[AI Jobs] Error rendering source page:', err);
    res.status(500).send('Error loading source page');
  }
});

// GET /ai-jobs/s/:sourceSlug/opportunity/:slug - opportunity scoped to a source
router.get('/s/:sourceSlug/opportunity/:slug', async (req, res) => {
  try {
    const { sourceSlug, slug } = req.params;
    const source = await getSourceBySlug(sourceSlug);
    if (!source) return res.status(404).send('Source not found');
    const opportunity = await getOpportunityBySlug(slug);
    if (!opportunity) return res.status(404).send('Opportunity not found');
    const referralUrl = resolveReferralUrl(opportunity, opportunity.category, DEFAULT_REFERRAL_URLS.general);
    await trackEvent({ opportunityId: opportunity.id, categoryId: opportunity.category_id, eventType: 'opportunity_view', ...getTrackingInfo(req), metadata: { opportunity: slug, source: sourceSlug } });
    res.send(renderOpportunityPage(opportunity, referralUrl, {
      sourceName: source.name,
      basePath: `/ai-jobs/s/${sourceSlug}`,
      canonicalBase: `/ai-jobs/s/${sourceSlug}/opportunity`
    }));
  } catch (err) {
    console.error('[AI Jobs] Error rendering source opportunity page:', err);
    res.status(500).send('Error loading opportunity page');
  }
});

// GET /ai-jobs/s/:sourceSlug/:categorySlug - category scoped to a source
router.get('/s/:sourceSlug/:categorySlug', async (req, res) => {
  try {
    const { sourceSlug, categorySlug } = req.params;
    const source = await getSourceBySlug(sourceSlug);
    if (!source) return res.status(404).send('Source not found');
    const category = await getCategoryBySlug(categorySlug);
    if (!category) return res.status(404).send('Category not found');
    const opportunities = await getOpportunities({ categoryId: category.id, sourceId: source.id, limit: 50 });
    await trackEvent({ categoryId: category.id, eventType: 'category_view', ...getTrackingInfo(req), metadata: { category: categorySlug, source: sourceSlug } });
    res.send(renderCategoryPage(category, opportunities, {
      basePath: `/ai-jobs/s/${sourceSlug}`,
      sourceName: source.name
    }));
  } catch (err) {
    console.error('[AI Jobs] Error rendering source category page:', err);
    res.status(500).send('Error loading category page');
  }
});

// GET /ai-jobs/apply/:id - Track apply click and redirect
router.get('/apply/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { createClient } = await import('@supabase/supabase-js');

    function createFallbackSupabase() {
      const fallbackResult = { data: [], error: null };
      const builder = {
        from() { return builder; },
        select() { return builder; },
        insert() { return builder; },
        update() { return builder; },
        upsert() { return builder; },
        delete() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        gt() { return builder; },
        gte() { return builder; },
        lt() { return builder; },
        lte() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        range() { return builder; },
        maybeSingle() { return Promise.resolve(fallbackResult); },
        single() { return Promise.resolve(fallbackResult); },
        in() { return builder; },
        contains() { return builder; },
        filter() { return builder; },
        or() { return builder; },
        not() { return builder; },
        ilike() { return builder; },
        like() { return builder; },
        is() { return builder; },
        isNot() { return builder; },
        then(onFulfilled, onRejected) { return Promise.resolve(fallbackResult).then(onFulfilled, onRejected); },
        catch(onRejected) { return Promise.resolve(fallbackResult).catch(onRejected); },
        finally(onFinally) { return Promise.resolve(fallbackResult).finally(onFinally); },
      };
      return builder;
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    const hasSupabaseConfig = Boolean(supabaseUrl && supabaseKey);
    const supabase = hasSupabaseConfig
      ? createClient(supabaseUrl, supabaseKey)
      : createFallbackSupabase();
    const { data: opportunity, error } = await supabase
      .from('opportunities')
      .select('*, category:opportunity_categories(*)')
      .eq('id', id)
      .eq('status', 'published')
      .single();
    if (error || !opportunity) return res.status(404).json({ error: 'Opportunity not found' });
    const referralUrl = resolveReferralUrl(opportunity, opportunity.category, DEFAULT_REFERRAL_URLS.general);
    if (!isValidReferralUrl(referralUrl)) return res.status(400).json({ error: 'Invalid referral URL' });
    await trackEvent({ opportunityId: opportunity.id, categoryId: opportunity.category_id, eventType: 'apply_click', ...getTrackingInfo(req), metadata: { opportunity: opportunity.slug } });
    res.redirect(302, referralUrl);
  } catch (err) {
    console.error('[AI Jobs] Error processing apply click:', err);
    res.status(500).json({ error: 'Error processing request' });
  }
});

// POST /api/events - Track events (for client-side tracking)
router.post('/api/events', async (req, res) => {
  try {
    const { eventType, opportunityId, categoryId, metadata = {} } = req.body;
    const validEventTypes = ['page_view', 'category_view', 'opportunity_view', 'apply_click', 'referral_click', 'external_click'];
    if (!validEventTypes.includes(eventType)) return res.status(400).json({ error: 'Invalid event type' });
    await trackEvent({ eventType, opportunityId, categoryId, ...getTrackingInfo(req), metadata });
    res.json({ success: true });
  } catch (err) {
    console.error('[AI Jobs] Error tracking event:', err);
    res.status(500).json({ error: 'Error tracking event' });
  }
});

export default router;
