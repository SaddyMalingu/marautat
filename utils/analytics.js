import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Track page view
export async function trackPageView(pagePath, req) {
  try {
    const { error } = await supabase.from('analytics_page_views').insert({
      page_path: pagePath,
      referrer: req.get('Referrer') || req.headers.referer || 'direct',
      user_agent: req.get('User-Agent') || 'unknown',
      ip_hash: hashIp(req.ip || req.connection?.remoteAddress || 'unknown'),
      session_id: req.query.session_id || req.headers['x-session-id'] || null,
      created_at: new Date().toISOString()
    });
    if (error && error.code !== '42P01') console.error('[Analytics] Page view error:', error.message);
  } catch (e) {
    // Silently fail - analytics should never break the app
  }
}

// Track click (Mercor link click)
export async function trackClick(pagePath, clickType, req) {
  try {
    const { error } = await supabase.from('analytics_clicks').insert({
      page_path: pagePath,
      click_type: clickType,
      referrer: req.get('Referrer') || req.headers.referer || 'direct',
      user_agent: req.get('User-Agent') || 'unknown',
      ip_hash: hashIp(req.ip || req.connection?.remoteAddress || 'unknown'),
      session_id: req.query.session_id || req.headers['x-session-id'] || null,
      created_at: new Date().toISOString()
    });
    if (error && error.code !== '42P01') console.error('[Analytics] Click error:', error.message);
  } catch (e) {
    // Silently fail
  }
}

// Get analytics summary
export async function getAnalyticsSummary(days = 30) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - days);
    
    // Get page views
    const { data: views } = await supabase
      .from('analytics_page_views')
      .select('page_path')
      .gte('created_at', since.toISOString());
    
    // Get clicks
    const { data: clicks } = await supabase
      .from('analytics_clicks')
      .select('page_path, click_type')
      .gte('created_at', since.toISOString());
    
    // Aggregate by page
    const pageStats = {};
    if (views) {
      views.forEach(v => {
        if (!pageStats[v.page_path]) {
          pageStats[v.page_path] = { views: 0, clicks: 0, ctr: 0 };
        }
        pageStats[v.page_path].views++;
      });
    }
    if (clicks) {
      clicks.forEach(c => {
        if (!pageStats[c.page_path]) {
          pageStats[c.page_path] = { views: 0, clicks: 0, ctr: 0 };
        }
        pageStats[c.page_path].clicks++;
      });
    }
    
    // Calculate CTR
    Object.values(pageStats).forEach(stat => {
      stat.ctr = stat.views > 0 ? ((stat.clicks / stat.views) * 100).toFixed(1) : 0;
    });
    
    // Sort by views
    const sortedPages = Object.entries(pageStats)
      .map(([path, stats]) => ({ path, ...stats }))
      .sort((a, b) => b.views - a.views);
    
    return {
      total_views: views?.length || 0,
      total_clicks: clicks?.length || 0,
      overall_ctr: views?.length > 0 ? (((clicks?.length || 0) / views.length) * 100).toFixed(1) : 0,
      top_pages: sortedPages.slice(0, 20),
      period_days: days
    };
  } catch (e) {
    console.error('[Analytics] Summary error:', e.message);
    return { total_views: 0, total_clicks: 0, overall_ctr: 0, top_pages: [], period_days: days };
  }
}

// Simple IP hash for privacy
function hashIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).substring(0, 8);
}
