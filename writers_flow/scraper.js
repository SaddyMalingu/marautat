/**
 * Writer's Flow — Lead Scraper
 * Discovers leads from search engines based on keywords.
 * Providers (in order of preference, configured via env vars):
 *   1. Google Custom Search API (GOOGLE_CSE_KEY + GOOGLE_CSE_CX)
 *   2. SerpAPI (SERPAPI_KEY)
 *   3. Bing Web Search API (BING_SEARCH_KEY)
 *   4. Test mode mock (for development)
 */

import axios from 'axios';

const EMAIL_REGEX = /[\w.+%-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_REGEX = /(?:\+?\d{1,3}[\s-])?(?:\(?\d{2,4}\)?[\s.-]){2,4}\d{3,6}/g;

// ──────────────────────────────────────────────
// Search Providers
// ──────────────────────────────────────────────

async function searchGoogle(query, numResults = 10) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) throw new Error('GOOGLE_CSE_KEY and GOOGLE_CSE_CX are required for Google search');
  const url = 'https://www.googleapis.com/customsearch/v1';
  const { data } = await axios.get(url, {
    params: { key, cx, q: query, num: Math.min(numResults, 10) },
    timeout: 12000,
  });
  return (data.items || []).map(item => ({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
    displayUrl: item.displayLink || '',
  }));
}

async function searchSerp(query, numResults = 10) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY required for SerpAPI search');
  const { data } = await axios.get('https://serpapi.com/search.json', {
    params: { api_key: key, q: query, engine: 'google', num: numResults },
    timeout: 15000,
  });
  return (data.organic_results || []).map(r => ({
    title: r.title || '',
    url: r.link || '',
    snippet: r.snippet || '',
    displayUrl: r.displayed_link || '',
  }));
}

async function searchBing(query, numResults = 10) {
  const key = process.env.BING_SEARCH_KEY;
  if (!key) throw new Error('BING_SEARCH_KEY required for Bing search');
  const { data } = await axios.get('https://api.bing.microsoft.com/v7.0/search', {
    headers: { 'Ocp-Apim-Subscription-Key': key },
    params: { q: query, count: numResults, mkt: 'en-US' },
    timeout: 12000,
  });
  return (data.webPages?.value || []).map(r => ({
    title: r.name || '',
    url: r.url || '',
    snippet: r.snippet || '',
    displayUrl: r.displayUrl || '',
  }));
}

async function runSearch(query, numResults = 10) {
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) {
    return searchGoogle(query, numResults);
  } else if (process.env.SERPAPI_KEY) {
    return searchSerp(query, numResults);
  } else if (process.env.BING_SEARCH_KEY) {
    return searchBing(query, numResults);
  } else {
    throw new Error(
      'No search API configured. Set one of: GOOGLE_CSE_KEY+GOOGLE_CSE_CX, SERPAPI_KEY, or BING_SEARCH_KEY'
    );
  }
}

// ──────────────────────────────────────────────
// Contact extraction from a webpage
// ──────────────────────────────────────────────

async function extractContactsFromPage(url) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlphadomeBot/1.0)' },
      maxRedirects: 3,
    });
    const emails = [...new Set((html.match(EMAIL_REGEX) || [])
      .filter(e => !e.includes('example.com') && !e.includes('noreply')))];
    const phones = [...new Set((html.match(PHONE_REGEX) || []).slice(0, 3))];
    return { emails, phones };
  } catch {
    return { emails: [], phones: [] };
  }
}

async function tryFetchContactPage(baseUrl) {
  const contactPaths = ['/contact', '/contact-us', '/about', '/about-us', '/team'];
  for (const path of contactPaths) {
    try {
      const url = new URL(path, baseUrl).toString();
      const result = await extractContactsFromPage(url);
      if (result.emails.length > 0) return result;
    } catch { /* skip */ }
  }
  return { emails: [], phones: [] };
}

// ──────────────────────────────────────────────
// Build search queries from keywords + industries
// ──────────────────────────────────────────────

function buildQueries(keywords = [], industries = [], outreachTypes = ['pitch']) {
  const queries = [];
  const typeHints = {
    pitch: 'contact email site',
    proposal: 'RFP proposal contact email',
    partnership: 'partnership collaboration contact',
    employment: 'hiring careers contact email',
  };
  const baseKeywords = keywords.slice(0, 3).join(' ');
  for (const industry of (industries.length ? industries : [''])) {
    for (const type of outreachTypes) {
      const hint = typeHints[type] || 'contact email';
      const parts = [baseKeywords, industry, hint].filter(Boolean);
      queries.push(parts.join(' '));
    }
  }
  // Deduplicate
  return [...new Set(queries)].slice(0, 6);
}

// ──────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────

/**
 * @param {object} options
 * @param {string[]} options.keywords
 * @param {string[]} [options.industries]
 * @param {string[]} [options.outreachTypes]
 * @param {number}   [options.targetCount]
 * @param {boolean}  [options.testMode]
 * @returns {Promise<Array>} array of raw lead objects
 */
export default async function scrapeLeads({
  keywords = [],
  industries = [],
  outreachTypes = ['pitch'],
  targetCount = 20,
  testMode = false,
} = {}) {
  if (testMode || process.env.NODE_ENV === 'test') {
    return [
      {
        title: 'Acme Corp — Contact Us',
        url: 'https://acme-example.com/contact',
        snippet: 'Reach us at info@acme-example.com or +1-555-0100. We help SMBs grow.',
        email: 'info@acme-example.com',
        phone: '+1-555-0100',
        sourceQuery: 'test mode',
        industry: industries[0] || 'technology',
        outreachType: outreachTypes[0] || 'pitch',
      },
    ];
  }

  const queries = buildQueries(keywords, industries, outreachTypes);
  const seen = new Set();
  const leads = [];

  for (const query of queries) {
    if (leads.length >= targetCount) break;
    let results = [];
    try {
      results = await runSearch(query, 10);
    } catch (err) {
      console.error(`[Scraper] Search failed for "${query}": ${err.message}`);
      continue;
    }

    for (const r of results) {
      if (leads.length >= targetCount) break;
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);

      // Try quick email extract from snippet first
      const snippetEmails = (r.snippet.match(EMAIL_REGEX) || []).filter(
        e => !e.includes('example.com') && !e.includes('noreply')
      );

      let email = snippetEmails[0] || null;
      let phone = null;

      // If no email in snippet, try fetching the page
      if (!email) {
        const contacts = await tryFetchContactPage(r.url);
        email = contacts.emails[0] || null;
        phone = contacts.phones[0] || null;
      }

      leads.push({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        email,
        phone,
        sourceQuery: query,
        industry: industries[0] || null,
        outreachType: outreachTypes[0] || 'pitch',
      });
    }
  }

  return leads;
}
