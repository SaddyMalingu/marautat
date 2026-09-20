import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

// Resilient client: never crashes on import if credentials are missing
const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : {
      from: () => ({
        select: () => ({ gte: () => Promise.resolve({ data: [] }) }),
        insert: () => Promise.resolve({ error: null })
      })
    };

// Get location from IP (free, non-blocking, no API key needed)
async function getLocation(ip) {
  try {
    if (!ip || ip === 'unknown' || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('::ffff:127.') || ip.startsWith('::ffff:10.') || ip.startsWith('::ffff:192.168.')) {
      return { country: 'local', region: 'local', city: 'local' };
    }
    const res = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`, { timeout: 3000 });
    if (res.data?.status === 'success') {
      return {
        country: res.data.country || 'unknown',
        region: res.data.regionName || 'unknown',
        city: res.data.city || 'unknown'
      };
    }
  } catch (e) {
    // Non-blocking
  }
  return { country: 'unknown', region: 'unknown', city: 'unknown' };
}

// Resolve the real client IP. Production runs behind a proxy (Render), so
// req.ip is the proxy address unless trust proxy is enabled; prefer the
// forwarded headers so hashing and geolocation reflect the actual visitor.
function getClientIp(req) {
  try {
    const xff = req?.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
    const realIp = req?.headers?.['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
    return req?.ip || req?.connection?.remoteAddress || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

// Track page view
export async function trackPageView(pagePath, req) {
  try {
    const ip = getClientIp(req);
    const location = await getLocation(ip);
    const referrer = (typeof req?.get === 'function' ? req.get('Referrer') : null) || req?.headers?.referer || 'direct';
    const userAgent = (typeof req?.get === 'function' ? req.get('User-Agent') : null) || req?.headers?.['user-agent'] || 'unknown';
    const sessionId = req?.query?.session_id || req?.headers?.['x-session-id'] || null;

    const payload = {
      page_path: pagePath,
      referrer,
      user_agent: userAgent,
      ip_hash: hashIp(ip),
      country: location.country,
      region: location.region,
      city: location.city,
      session_id: sessionId,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from('analytics_page_views').insert(payload);
    if (error) {
      // 42703 = column does not exist yet; gracefully strip location fields and retry
      if (error.code === '42703') {
        delete payload.country;
        delete payload.region;
        delete payload.city;
        await supabase.from('analytics_page_views').insert(payload);
      } else if (error.code !== '42P01') {
        console.error('[Analytics] Page view error:', error.code, error.message);
      }
    }
  } catch (e) {
    // Analytics should never throw or break app flow
  }
}

// Track click (Mercor affiliate link clicks, etc.)
export async function trackClick(pagePath, clickType, req) {
  try {
    const ip = getClientIp(req);
    const location = await getLocation(ip);
    const referrer = (typeof req?.get === 'function' ? req.get('Referrer') : null) || req?.headers?.referer || 'direct';
    const userAgent = (typeof req?.get === 'function' ? req.get('User-Agent') : null) || req?.headers?.['user-agent'] || 'unknown';
    const sessionId = req?.query?.session_id || req?.headers?.['x-session-id'] || null;

    const payload = {
      page_path: pagePath,
      click_type: clickType || 'mercor_link',
      referrer,
      user_agent: userAgent,
      ip_hash: hashIp(ip),
      country: location.country,
      region: location.region,
      city: location.city,
      session_id: sessionId,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from('analytics_clicks').insert(payload);
    if (error) {
      if (error.code === '42703') {
        delete payload.country;
        delete payload.region;
        delete payload.city;
        await supabase.from('analytics_clicks').insert(payload);
      } else if (error.code !== '42P01') {
        console.error('[Analytics] Click error:', error.code, error.message);
      }
    }
  } catch (e) {
    // Analytics should never break user interaction
  }
}

// Get analytics summary
export async function getAnalyticsSummary(days = 30) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - days);

    // Get page views with location (graceful fallback if location columns do not exist yet)
    let viewsRes = await supabase
      .from('analytics_page_views')
      .select('page_path, country, region, city')
      .gte('created_at', since.toISOString());

    if (viewsRes.error && viewsRes.error.code === '42703') {
      viewsRes = await supabase
        .from('analytics_page_views')
        .select('page_path')
        .gte('created_at', since.toISOString());
    }
    const views = viewsRes.data || [];

    // Get clicks
    const clicksRes = await supabase
      .from('analytics_clicks')
      .select('page_path, click_type')
      .gte('created_at', since.toISOString());
    const clicks = clicksRes.data || [];

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

    // Calculate CTR per page
    Object.values(pageStats).forEach(stat => {
      stat.ctr = stat.views > 0 ? ((stat.clicks / stat.views) * 100).toFixed(1) : '0.0';
    });

    // Sort by views
    const sortedPages = Object.entries(pageStats)
      .map(([path, stats]) => ({ path, ...stats }))
      .sort((a, b) => b.views - a.views);

    // Aggregate by country
    const countryStats = {};
    if (views) {
      views.forEach(v => {
        const country = v.country || 'unknown';
        countryStats[country] = (countryStats[country] || 0) + 1;
      });
    }

    // Sort countries by views
    const sortedCountries = Object.entries(countryStats)
      .map(([country, vCount]) => ({ country, views: vCount }))
      .sort((a, b) => b.views - a.views);

    const totalViews = views?.length || 0;
    const totalClicks = clicks?.length || 0;

    return {
      total_views: totalViews,
      total_clicks: totalClicks,
      overall_ctr: totalViews > 0 ? (((totalClicks) / totalViews) * 100).toFixed(1) : '0.0',
      top_pages: sortedPages.slice(0, 20),
      top_countries: sortedCountries.slice(0, 10),
      period_days: days
    };
  } catch (e) {
    console.error('[Analytics] Summary error:', e.message);
    return { total_views: 0, total_clicks: 0, overall_ctr: '0.0', top_pages: [], top_countries: [], period_days: days };
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
