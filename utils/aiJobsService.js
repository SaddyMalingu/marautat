/**
 * AI Jobs Service
 * 
 * Handles database operations for the AI Jobs subsystem.
 * All operations are additive and do not affect existing tables.
 */

import { createClient } from '@supabase/supabase-js';

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
    then(onFulfilled, onRejected) {
      return Promise.resolve(fallbackResult).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return Promise.resolve(fallbackResult).catch(onRejected);
    },
    finally(onFinally) {
      return Promise.resolve(fallbackResult).finally(onFinally);
    },
  };

  return builder;
}

// Initialize Supabase client
// IMPORTANT: Use service role key to bypass RLS for server-side operations
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const hasSupabaseConfig = Boolean(supabaseUrl && supabaseKey);

if (!hasSupabaseConfig) {
  console.warn('[AI Jobs] Missing Supabase credentials. Running in local-safe fallback mode.');
}

const supabase = hasSupabaseConfig ? createClient(supabaseUrl, supabaseKey) : createFallbackSupabase();

/**
 * Get all active opportunity sources.
 */
async function getActiveSources() {
  const { data, error } = await supabase
    .from('opportunity_sources')
    .select('*')
    .eq('is_active', true)
    .order('name');
  
  if (error) {
    console.error('[AI Jobs] Error fetching sources:', error.message);
    return [];
  }
  
  return data || [];
}

/**
 * Get all active categories.
 */
async function getActiveCategories() {
  const { data, error } = await supabase
    .from('opportunity_categories')
    .select('*')
    .eq('is_active', true)
    .order('display_order');
  
  if (error) {
    console.error('[AI Jobs] Error fetching categories:', error.message);
    return [];
  }
  
  return data || [];
}

/**
 * Get a single category by slug.
 */
async function getCategoryBySlug(slug) {
  const { data, error } = await supabase
    .from('opportunity_categories')
    .select('*')
    .eq('slug', slug)
    .eq('is_active', true)
    .single();
  
  if (error) {
    console.error('[AI Jobs] Error fetching category:', error.message);
    return null;
  }
  
  return data;
}

/**
 * Get published opportunities with optional filters.
 */
async function getOpportunities({ 
  categoryId = null, 
  sourceId = null, 
  limit = 50, 
  offset = 0 
} = {}) {
  let query = supabase
    .from('opportunities')
    .select(`
      *,
      category:opportunity_categories(*),
      source:opportunity_sources(*)
    `)
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .range(offset, offset + limit - 1);
  
  if (categoryId) {
    query = query.eq('category_id', categoryId);
  }
  
  if (sourceId) {
    query = query.eq('source_id', sourceId);
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.error('[AI Jobs] Error fetching opportunities:', error.message);
    return [];
  }
  
  return data || [];
}

/**
 * Get a single opportunity by slug.
 */
async function getOpportunityBySlug(slug) {
  const { data, error } = await supabase
    .from('opportunities')
    .select(`
      *,
      category:opportunity_categories(*),
      source:opportunity_sources(*)
    `)
    .eq('slug', slug)
    .eq('status', 'published')
    .single();
  
  if (error) {
    console.error('[AI Jobs] Error fetching opportunity:', error.message);
    return null;
  }
  
  return data;
}

/**
 * Track an analytics event.
 */
async function trackEvent({ 
  opportunityId = null, 
  categoryId = null, 
  eventType, 
  sessionId = null,
  anonymousId = null,
  referrer = null,
  utmSource = null,
  utmMedium = null,
  utmCampaign = null,
  metadata = {}
}) {
  const { error } = await supabase
    .from('opportunity_events')
    .insert({
      opportunity_id: opportunityId,
      category_id: categoryId,
      event_type: eventType,
      session_id: sessionId,
      anonymous_id: anonymousId,
      referrer,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      metadata
    });
  
  if (error) {
    console.error('[AI Jobs] Error tracking event:', error.message);
    return false;
  }
  
  return true;
}

/**
 * Get analytics summary for admin dashboard.
 */
async function getAnalyticsSummary({ days = 30 } = {}) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  
  const { data, error } = await supabase
    .from('opportunity_events')
    .select('event_type, created_at')
    .gte('created_at', since.toISOString());
  
  if (error) {
    console.error('[AI Jobs] Error fetching analytics:', error.message);
    return null;
  }
  
  // Aggregate events by type
  const summary = {
    total_events: data.length,
    page_views: 0,
    category_views: 0,
    opportunity_views: 0,
    apply_clicks: 0,
    referral_clicks: 0,
    period_days: days
  };
  
  for (const event of data) {
    switch (event.event_type) {
      case 'page_view':
        summary.page_views++;
        break;
      case 'category_view':
        summary.category_views++;
        break;
      case 'opportunity_view':
        summary.opportunity_views++;
        break;
      case 'apply_click':
        summary.apply_clicks++;
        break;
      case 'referral_click':
        summary.referral_clicks++;
        break;
    }
  }
  
  return summary;
}

/**
 * Get a single active opportunity source by slug (e.g. 'mercor', 'respondent').
 */
async function getSourceBySlug(slug) {
  if (!slug) return null;
  const { data, error } = await supabase
    .from('opportunity_sources')
    .select('*')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    console.error('[AI Jobs] Error fetching source by slug:', error.message);
    return null;
  }
  return data || null;
}

/**
 * Get active categories that have at least one published opportunity for a
 * given source. Keeps a source landing page from showing unrelated categories
 * (e.g. Mercor categories on a respondent.io page).
 */
async function getCategoriesForSource(sourceId) {
  if (!sourceId) return [];
  const { data: opps, error: oppErr } = await supabase
    .from('opportunities')
    .select('category_id')
    .eq('source_id', sourceId)
    .eq('status', 'published')
    .limit(1000);

  if (oppErr) {
    console.error('[AI Jobs] Error fetching source opportunities:', oppErr.message);
    return [];
  }
  const catIds = [...new Set((opps || []).map(o => o.category_id).filter(Boolean))];
  if (!catIds.length) return [];

  const { data: cats, error: catErr } = await supabase
    .from('opportunity_categories')
    .select('*')
    .in('id', catIds)
    .eq('is_active', true)
    .order('display_order');

  if (catErr) {
    console.error('[AI Jobs] Error fetching categories for source:', catErr.message);
    return [];
  }
  return data_sorted(cats || []);
}

// Preserve display_order without relying on DB ordering guarantees.
function data_sorted(rows) {
  return rows.slice().sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
}

/**
 * Get a single active site tenant by slug (e.g. 'default', 'health').
 */
async function getSiteTenantBySlug(slug) {
  if (!slug) return null;
  const { data, error } = await supabase
    .from('site_tenants')
    .select('*')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    console.error('[AI Jobs] Error fetching site tenant:', error.message);
    return null;
  }
  return data || null;
}

/**
 * Get every active site tenant. Used where the whole list matters rather than
 * one slug: the sitemap and the /ai-jobs landing page both have to advertise
 * every tenant hub, and neither had any way to see them.
 */
async function getActiveSiteTenants({ limit = 200 } = {}) {
  const { data, error } = await supabase
    .from('site_tenants')
    .select('id, slug, name')
    .eq('is_active', true)
    .order('name')
    .limit(limit);
  if (error) {
    // A deployment without the phase-3 table simply has no hubs to advertise.
    console.error('[AI Jobs] Error fetching site tenants:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Get published offers for a tenant, optionally filtered by offer_type and/or
 * category. This is the general "any offer" query (jobs, products, services,
 * brands, affiliate, courses).
 */
async function getOffersByTenant(tenantId, { offerType = null, categoryId = null, limit = 50 } = {}) {
  if (!tenantId) return [];
  let query = supabase
    .from('opportunities')
    .select('*, category:opportunity_categories(*)')
    .eq('tenant_id', tenantId)
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(limit);
  if (offerType) query = query.eq('offer_type', offerType);
  if (categoryId) query = query.eq('category_id', categoryId);
  const { data, error } = await query;
  if (error) {
    console.error('[AI Jobs] Error fetching tenant offers:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Offer-type metadata — the single source of truth for how an offer is labeled
 * and what its call-to-action says. Jobs keep their legacy wording; other
 * types get product/service/brand/affiliate-appropriate CTAs.
 */
const OFFER_TYPES = {
  job:      { label: 'Job',      cta: 'Apply',     priceLabel: 'Compensation' },
  product:  { label: 'Product',  cta: 'Shop Now',  priceLabel: 'Price' },
  service:  { label: 'Service',  cta: 'Learn More',priceLabel: 'From' },
  brand:    { label: 'Brand',    cta: 'Explore',   priceLabel: '' },
  affiliate:{ label: 'Offer',    cta: 'Get Deal',  priceLabel: '' },
  course:   { label: 'Course',   cta: 'Enroll',    priceLabel: 'Price' },
};

function offerMeta(offer) {
  const type = (offer && offer.offer_type) || 'job';
  const base = OFFER_TYPES[type] || OFFER_TYPES.job;
  const destination = (offer && (offer.destination_url || offer.referral_url || offer.application_url)) || null;
  return {
    type,
    label: base.label,
    cta: (offer && offer.cta_label) || base.cta,
    priceLabel: base.priceLabel,
    destination,
  };
}

export {
  getActiveSources,
  getSourceBySlug,
  getSiteTenantBySlug,
  getActiveSiteTenants,
  getActiveCategories,
  getCategoriesForSource,
  getOffersByTenant,
  offerMeta,
  OFFER_TYPES,
  getCategoryBySlug,
  getOpportunities,
  getOpportunityBySlug,
  trackEvent,
  getAnalyticsSummary
};
