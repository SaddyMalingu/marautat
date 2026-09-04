/**
 * AI Jobs Service
 * 
 * Handles database operations for the AI Jobs subsystem.
 * All operations are additive and do not affect existing tables.
 */

import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
// IMPORTANT: Use service role key to bypass RLS for server-side operations
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[AI Jobs] Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey);

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

export {
  getActiveSources,
  getActiveCategories,
  getCategoryBySlug,
  getOpportunities,
  getOpportunityBySlug,
  trackEvent,
  getAnalyticsSummary
};
