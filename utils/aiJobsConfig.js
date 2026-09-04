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

// Allowed redirect domains (security: prevent open redirects)
const ALLOWED_REDIRECT_DOMAINS = [
  't.mercor.com',
  'mercor.com',
  'www.mercor.com'
];

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
 * @returns {boolean} True if the URL is safe
 */
function isValidReferralUrl(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  
  try {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_DOMAINS.includes(parsed.hostname);
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
  resolveReferralUrl,
  isValidReferralUrl,
  getCategoryReferralUrl
};
