/**
 * AI Jobs Routes - Part 1: Routes & Controllers
 * 
 * Handles all /ai-jobs/* endpoints for the opportunity discovery subsystem.
 */

import { Router } from 'express';
import {
  getActiveSources,
  getSourceBySlug,
  getSiteTenantBySlug,
  getActiveSiteTenants,
  getActiveCategories,
  getCategoriesForSource,
  getOffersByTenant,
  offerMeta,
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
  renderCategoryPage,
  renderTenantOffers
} from '../utils/aiJobsViews.js';
import { renderOfferPage } from '../utils/aiJobsViewsOpp.js';
import { trackPageView, trackClick, pagePathFromReferrer } from '../utils/analytics.js';

const router = Router();

// Phase 3 feature flag — tenant routing is OFF until explicitly enabled.
const MULTITENANT = String(process.env.AI_JOBS_MULTITENANT || '').toLowerCase() === 'true';

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

// Helper: record a hub page in the same page-view table the blog pages use.
//
// Hub visits were recorded only in opportunity_events, which the tenant portal
// does not read — so the page a tenant actually promotes showed zero traffic in
// their own Analytics section. This puts the hub in analytics_page_views under
// its real path (/ai-jobs/t/<slug> and anything beneath it), which is what
// /tenant/writers-flow/analytics matches on. Non-blocking: tracking can never
// affect the response.
function trackHubView(req) {
  try {
    const p = String(req.originalUrl || req.url || '').split('?')[0].replace(/\.html$/, '');
    if (p) trackPageView(p, req);
  } catch (e) {}
}

// GET /ai-jobs - Main AI Jobs landing page
router.get('/', async (req, res) => {
  try {
    const categories = await getActiveCategories();
    const sources = await getActiveSources();
    // Tenant hubs, when the flag is on: the site's own landing page should be a
    // way in to the businesses it hosts, not a dead end that only lists Mercor.
    const tenants = MULTITENANT ? await getActiveSiteTenants() : [];
    await trackEvent({ eventType: 'page_view', ...getTrackingInfo(req), metadata: { page: 'ai-jobs-landing' } });
    res.send(renderAiJobsLanding(categories, sources, tenants));
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
    res.send(renderOfferPage(opportunity, { sourceName: 'Mercor', basePath: '/ai-jobs/mercor', canonicalBase: '/ai-jobs/mercor/opportunity' }));
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
    res.send(renderOfferPage(opportunity, {
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

// What a reader sees when a CTA has nowhere to go.
//
// /ai-jobs/apply/<id> used to answer `404 {"error":"No destination configured
// for this offer"}` — raw JSON for a person who had just pressed a button on an
// article they read to the end. A live page hit it on 2026-10-29 at 19:57:20.
// The offer being unconfigured is the owner's to-do, not the reader's problem,
// so the click is counted and the reader is given a way back.
export function offerUnavailablePage(title, backHref) {
  const name = String(title || 'This offer').slice(0, 120);
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const back = backHref && /^\/(?!\/)/.test(backHref) ? backHref : '/ai-jobs';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">' +
    '<meta name="robots" content="noindex">' +
    '<title>' + esc(name) + ' | AlphaDome</title>' +
    '<style>body{font-family:system-ui,sans-serif;background:#081421;color:#f3f7fa;line-height:1.6;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}' +
    '.c{max-width:520px}h1{font-size:1.4rem;margin:0 0 .75rem}p{color:#b8c7d6;margin:0 0 1rem}' +
    'a{color:#ff8a00}</style></head><body><div class="c">' +
    '<h1>Applications for this one are not open yet</h1>' +
    '<p><strong>' + esc(name) + '</strong> has no application link configured, so there is nothing ' +
    'to send you to. The business has been shown this in its portal.</p>' +
    '<p><a href="' + esc(back) + '">&larr; Back to what you were reading</a> &nbsp;·&nbsp; ' +
    '<a href="/ai-jobs">Browse other opportunities</a></p>' +
    '</div></body></html>';
}

// GET /go/:id and GET /ai-jobs/apply/:id — count the click, then send the reader on.
//
// One handler, two paths, because they are the same act and a second copy of this
// logic would drift. /go/:id is the link every blog CTA now carries: short, and
// neutral about whether the offer is a job, a product or a course.
// /ai-jobs/apply/:id keeps working for the 434 pages already published and for
// anything anyone has bookmarked.
//
// The destination is resolved here and redirected to **unchanged** — no wrapper
// URL, no added query string — so affiliate attribution is byte-identical to what
// it was when the page linked to the provider directly. The one difference: the
// click is recorded before the reader leaves, in the table the tenant portal reads.
//
// `humanFacing` matters for exactly one branch. A missing offer answers JSON on
// /ai-jobs/apply/:id because API clients depend on that contract, but a person who
// pressed a button at the end of a blog page must not be handed `{"error":…}`.
export async function handleOfferClick(req, res, options = {}) {
  const fallbackPath = options.fallbackPath || '/ai-jobs/apply';
  const humanFacing = options.humanFacing === true;
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
    if (error || !opportunity) {
      // An offer that has gone still tells us somebody wanted it.
      const missingFrom = pagePathFromReferrer(req, fallbackPath);
      trackClick(missingFrom, 'apply_missing', req).catch(() => {});
      if (humanFacing) {
        // A person pressed a button, not an API client.
        const back = missingFrom && missingFrom.indexOf('/blog/') === 0 ? missingFrom : '/ai-jobs';
        return res.status(200).type('html').send(offerUnavailablePage('This opportunity', back));
      }
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    // Offer-aware destination: jobs/affiliate use referral_url (allowlist-enforced);
    // products/services/brands use an admin-set destination_url (http/https only).
    const meta = offerMeta(opportunity);
    const dest = meta.destination;
    const sourcePath = pagePathFromReferrer(req, fallbackPath);

    // No destination, or one we will not redirect to. Either way the reader gets
    // a page with a way back instead of `{"error":…}`, and the click is recorded
    // so the owner can see demand for an offer they have not finished setting up.
    // Counted before the branch, because this is the most valuable click to see.
    let usable = false;
    if (dest) {
      try {
        const u = new URL(dest);
        const wellFormed = u.protocol === 'http:' || u.protocol === 'https:';
        const trusted = Boolean(opportunity.destination_url) || isValidReferralUrl(dest);
        usable = wellFormed && trusted;
      } catch {
        usable = false;
      }
    }

    if (!usable) {
      trackClick(sourcePath, dest ? 'apply_bad_destination' : 'apply_no_destination', req).catch(() => {});
      await trackEvent({ opportunityId: opportunity.id, categoryId: opportunity.category_id, eventType: 'apply_click', ...getTrackingInfo(req), metadata: { opportunity: opportunity.slug, offer_type: meta.type, unavailable: true } });
      const back = sourcePath && sourcePath !== '/ai-jobs/apply' ? sourcePath : '/ai-jobs';
      res.status(200).type('html').send(offerUnavailablePage(opportunity.title || opportunity.slug, back));
      return undefined;
    }

    await trackEvent({ opportunityId: opportunity.id, categoryId: opportunity.category_id, eventType: 'apply_click', ...getTrackingInfo(req), metadata: { opportunity: opportunity.slug, offer_type: meta.type } });
    // A click on the page that sent them here, in the table the tenant portal
    // reads. Without this the CTA converts and nobody can prove it: the offer
    // gets an apply_click, the page that earned it gets nothing. The fallback
    // path is deliberately not a tenant page, so an unattributable click counts
    // for the platform without being credited to someone else's writing.
    trackClick(sourcePath, 'apply', req).catch(() => {});
    res.redirect(302, dest);
  } catch (err) {
    console.error('[AI Jobs] Error processing offer click:', err);
    // A person on a blog page gets a page back; an API client keeps the JSON.
    if (humanFacing) {
      res.status(200).type('html').send(offerUnavailablePage('This opportunity', '/ai-jobs'));
      return;
    }
    res.status(500).json({ error: 'Error processing request' });
  }
}

// The original path. Unchanged contract, so anything already pointing here keeps
// working — including the 434 published pages written before /go existed.
router.get('/apply/:id', (req, res) => handleOfferClick(req, res, { fallbackPath: '/ai-jobs/apply' }));

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

// ============================================================================
// PHASE 3 — MULTI-TENANT TRAFFIC ENGINE (flag-gated: AI_JOBS_MULTITENANT=true)
// Each site_tenant gets an SEO hub driving traffic to ANY offer type.
//   /ai-jobs/t/:tenantSlug            -> tenant hub (all offers)
//   /ai-jobs/t/:tenantSlug/o/:slug    -> individual offer
//   /ai-jobs/t/:tenantSlug/:catSlug   -> tenant category
// When the flag is OFF these return 404, so live behavior is unchanged.
// ============================================================================
if (MULTITENANT) {
  router.get('/t/:tenantSlug', async (req, res) => {
    try {
      const { tenantSlug } = req.params;
      const tenant = await getSiteTenantBySlug(tenantSlug);
      if (!tenant) return res.status(404).send('Site not found');
      const offers = await getOffersByTenant(tenant.id, { limit: 100 });
      await trackEvent({ eventType: 'page_view', ...getTrackingInfo(req), metadata: { page: 'tenant-hub', tenant: tenantSlug } });
      trackHubView(req);
      res.send(renderTenantOffers(tenant, offers));
    } catch (err) {
      console.error('[AI Jobs] Error rendering tenant hub:', err);
      res.status(500).send('Error loading site');
    }
  });

  router.get('/t/:tenantSlug/o/:slug', async (req, res) => {
    try {
      const { tenantSlug, slug } = req.params;
      const tenant = await getSiteTenantBySlug(tenantSlug);
      if (!tenant) return res.status(404).send('Site not found');
      const opportunity = await getOpportunityBySlug(slug);
      if (!opportunity) return res.status(404).send('Offer not found');
      await trackEvent({ opportunityId: opportunity.id, categoryId: opportunity.category_id, eventType: 'opportunity_view', ...getTrackingInfo(req), metadata: { opportunity: slug, tenant: tenantSlug } });
      trackHubView(req);
      res.send(renderOfferPage(opportunity, {
        sourceName: opportunity.source?.name || tenant.name,
        basePath: `/ai-jobs/t/${tenantSlug}`,
        canonicalBase: `/ai-jobs/t/${tenantSlug}/o`
      }));
    } catch (err) {
      console.error('[AI Jobs] Error rendering tenant offer:', err);
      res.status(500).send('Error loading offer');
    }
  });

  router.get('/t/:tenantSlug/:categorySlug', async (req, res) => {
    try {
      const { tenantSlug, categorySlug } = req.params;
      const tenant = await getSiteTenantBySlug(tenantSlug);
      if (!tenant) return res.status(404).send('Site not found');
      const category = await getCategoryBySlug(categorySlug);
      if (!category) return res.status(404).send('Category not found');
      const offers = await getOffersByTenant(tenant.id, { categoryId: category.id, limit: 100 });
      await trackEvent({ categoryId: category.id, eventType: 'category_view', ...getTrackingInfo(req), metadata: { category: categorySlug, tenant: tenantSlug } });
      trackHubView(req);
      res.send(renderTenantOffers(tenant, offers, { title: `${tenant.name} — ${category.name}`, sub: category.description || `${category.name} offers from ${tenant.name}.` }));
    } catch (err) {
      console.error('[AI Jobs] Error rendering tenant category:', err);
      res.status(500).send('Error loading category');
    }
  });
}

export default router;
