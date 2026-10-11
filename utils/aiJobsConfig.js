/**
 * AI Jobs & Mercor Referral Configuration
 * 
 * Centralized configuration for the AI Jobs subsystem.
 * Referral URLs are stored here as defaults but can be overridden
 * by database values.
 */

// Default referral URLs (used as fallback if database is unavailable)
const DEFAULT_REFERRAL_URLS = {
  general: 'https://t.mercor.com/tqwsF',
  categories: {
    'medicine': 'https://t.mercor.com/H0hIC',
    'law': 'https://t.mercor.com/qmTg8',
    'software-engineering': 'https://t.mercor.com/20MWE',
    'data-analysis': 'https://t.mercor.com/jmluX',
    'finance': 'https://t.mercor.com/vHKIv',
    'business-operations': 'https://t.mercor.com/LxKC0',
    'life-physical-social-sciences': 'https://t.mercor.com/rWlds',
    'other-engineering': 'https://t.mercor.com/axpK4',
    'arts-design': 'https://t.mercor.com/uH1OY',
    'language-audio': 'https://t.mercor.com/g6As3',
    'humanities': 'https://t.mercor.com/OcRv3'
  }
};

// Base allowed redirect domains (security: prevent open redirects).
// Multi-platform: Mercor today, plus room for additional providers
// (e.g. respondent.io). Tenant-specific domains are layered in at runtime
// (Phase 3) from site_tenants.allowed_redirect_domains.
const BASE_REDIRECT_DOMAINS = [
  't.mercor.com',
  'mercor.com',
  'www.mercor.com',
  'respondent.io',
  'www.respondent.io',
  'app.respondent.io'
];

// Extra domains can be injected via env without a code change:
//   AI_JOBS_EXTRA_REDIRECT_DOMAINS="example.com,refer.example.org"
function getExtraRedirectDomains() {
  return String(process.env.AI_JOBS_EXTRA_REDIRECT_DOMAINS || '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
}

// Effective allowlist = base + env extras (+ optional per-tenant domains).
function getAllowedRedirectDomains(extraDomains = []) {
  const set = new Set(BASE_REDIRECT_DOMAINS);
  for (const d of getExtraRedirectDomains()) set.add(d);
  for (const d of (Array.isArray(extraDomains) ? extraDomains : [])) {
    const clean = String(d || '').trim().toLowerCase();
    if (clean) set.add(clean);
  }
  return set;
}

// Backward-compatible export (static base list).
const ALLOWED_REDIRECT_DOMAINS = BASE_REDIRECT_DOMAINS;

/**
 * Resolve the referral URL for an opportunity.
 * Precedence: job-specific URL > category URL > general URL
 * 
 * @param {Object} opportunity - The opportunity object
 * @param {Object} category - The category object (optional)
 * @param {string} generalUrl - The general fallback URL
 * @returns {string} The resolved referral URL
 */
function resolveReferralUrl(opportunity, category = null, generalUrl = DEFAULT_REFERRAL_URLS.general) {
  // 1. Job-specific referral URL takes highest precedence
  if (opportunity?.referral_url) {
    return opportunity.referral_url;
  }
  
  // 2. Category referral URL
  if (category?.referral_url) {
    return category.referral_url;
  }
  
  // 3. General referral URL
  return generalUrl;
}

/**
 * Validate that a referral URL is safe to redirect to.
 * Prevents open redirect vulnerabilities.
 * 
 * @param {string} url - The URL to validate
 * @param {string[]} [extraDomains] - optional per-tenant allowed hostnames
 * @returns {boolean} True if the URL is safe
 */
function isValidReferralUrl(url, extraDomains = []) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  
  try {
    const parsed = new URL(url);
    return getAllowedRedirectDomains(extraDomains).has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Get category referral URL by slug.
 * 
 * @param {string} slug - The category slug
 * @returns {string|null} The referral URL or null
 */
function getCategoryReferralUrl(slug) {
  return DEFAULT_REFERRAL_URLS.categories[slug] || null;
}

export {
  DEFAULT_REFERRAL_URLS,
  ALLOWED_REDIRECT_DOMAINS,
  getAllowedRedirectDomains,
  resolveReferralUrl,
  isValidReferralUrl,
  getCategoryReferralUrl
};
