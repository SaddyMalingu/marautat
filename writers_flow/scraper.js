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
import * as cheerio from 'cheerio';

const EMAIL_REGEX = /[\w.+%-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_REGEX = /(?:\+?\d{1,3}[\s-])?(?:\(?\d{2,4}\)?[\s.-]){2,4}\d{3,6}/g;

// ──────────────────────────────────────────────
// Search Providers
// ──────────────────────────────────────────────

async function searchGoogle(query, numResults = 10) {
  console.log(`[Scraper] [Google] Searching: "${query}" (numResults=${numResults})`);
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) throw new Error('GOOGLE_CSE_KEY and GOOGLE_CSE_CX are required for Google search');
  const url = 'https://www.googleapis.com/customsearch/v1';
  const start = Date.now();
  try {
    const { data, status } = await axios.get(url, {
      params: { key, cx, q: query, num: Math.min(numResults, 10) },
      timeout: 12000,
    });
    const items = (data.items || []).map(item => ({
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || '',
      displayUrl: item.displayLink || '',
    }));
    console.log(`[Scraper] [Google] Results: ${items.length} (status=${status}, time=${Date.now()-start}ms)`);
    items.forEach((i, idx) => console.log(`[Scraper] [Google] [${idx}] ${i.title} | ${i.url}`));
    return items;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(`[Scraper] [Google] ERROR: ${err.message} (status=${status}, time=${Date.now()-start}ms)`);
    if (body) console.error(`[Scraper] [Google] ERROR BODY: ${JSON.stringify(body).slice(0,500)}`);
    throw err;
  }
}

async function searchSerp(query, numResults = 10) {
  console.log(`[Scraper] [SerpAPI] Searching: "${query}" (numResults=${numResults})`);
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY required for SerpAPI search');
  const start = Date.now();
  try {
    const { data, status } = await axios.get('https://serpapi.com/search.json', {
      params: { api_key: key, q: query, engine: 'google', num: numResults },
      timeout: 15000,
    });
    const items = (data.organic_results || []).map(r => ({
      title: r.title || '',
      url: r.link || '',
      snippet: r.snippet || '',
      displayUrl: r.displayed_link || '',
    }));
    console.log(`[Scraper] [SerpAPI] Results: ${items.length} (status=${status}, time=${Date.now()-start}ms)`);
    items.forEach((i, idx) => console.log(`[Scraper] [SerpAPI] [${idx}] ${i.title} | ${i.url}`));
    return items;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(`[Scraper] [SerpAPI] ERROR: ${err.message} (status=${status}, time=${Date.now()-start}ms)`);
    if (body) console.error(`[Scraper] [SerpAPI] ERROR BODY: ${JSON.stringify(body).slice(0,500)}`);
    throw err;
  }
}

async function searchBing(query, numResults = 10) {
  console.log(`[Scraper] [Bing] Searching: "${query}" (numResults=${numResults})`);
  const key = process.env.BING_SEARCH_KEY;
  if (!key) throw new Error('BING_SEARCH_KEY required for Bing search');
  const start = Date.now();
  try {
    const { data, status } = await axios.get('https://api.bing.microsoft.com/v7.0/search', {
      headers: { 'Ocp-Apim-Subscription-Key': key },
      params: { q: query, count: numResults, mkt: 'en-US' },
      timeout: 12000,
    });
    const items = (data.webPages?.value || []).map(r => ({
      title: r.name || '',
      url: r.url || '',
      snippet: r.snippet || '',
      displayUrl: r.displayUrl || '',
    }));
    console.log(`[Scraper] [Bing] Results: ${items.length} (status=${status}, time=${Date.now()-start}ms)`);
    items.forEach((i, idx) => console.log(`[Scraper] [Bing] [${idx}] ${i.title} | ${i.url}`));
    return items;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(`[Scraper] [Bing] ERROR: ${err.message} (status=${status}, time=${Date.now()-start}ms)`);
    if (body) console.error(`[Scraper] [Bing] ERROR BODY: ${JSON.stringify(body).slice(0,500)}`);
    throw err;
  }
}

async function runSearch(query, numResults = 10) {
  const useGoogle = process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX;
  const useSerp = process.env.SERPAPI_KEY;
  const useBing = process.env.BING_SEARCH_KEY;

  console.log(`[Scraper] Provider selection: Google=${!!useGoogle}, SerpAPI=${!!useSerp}, Bing=${!!useBing}`);

  if (useGoogle && useSerp) {
    console.log(`[Scraper] Running BOTH Google and SerpAPI for query: "${query}"`);
    const [googleResults, serpResults] = await Promise.all([
      searchGoogle(query, numResults),
      searchSerp(query, numResults)
    ]);
    // Merge and deduplicate by URL
    const all = [...googleResults, ...serpResults];
    const seen = new Set();
    const deduped = [];
    for (const r of all) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      deduped.push(r);
    }
    console.log(`[Scraper] Merged results: Google=${googleResults.length}, SerpAPI=${serpResults.length}, Deduped=${deduped.length}`);
    return deduped.slice(0, numResults);
  } else if (useGoogle) {
    console.log(`[Scraper] Running ONLY Google for query: "${query}"`);
    return searchGoogle(query, numResults);
  } else if (useSerp) {
    console.log(`[Scraper] Running ONLY SerpAPI for query: "${query}"`);
    return searchSerp(query, numResults);
  } else if (useBing) {
    console.log(`[Scraper] Running ONLY Bing for query: "${query}"`);
    return searchBing(query, numResults);
  } else {
    console.error('[Scraper] No search API configured.');
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
    console.log(`[Scraper] [Extract] Fetching: ${url}`);
    const { data: html } = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlphadomeBot/1.0)' },
      maxRedirects: 3,
    });
    // Standard email/phone extraction (raw HTML)
    let emails = [...new Set((html.match(EMAIL_REGEX) || [])
      .filter(e => !e.includes('example.com') && !e.includes('noreply')))].map(e => e.trim());
    let phones = [...new Set((html.match(PHONE_REGEX) || []).slice(0, 3))];

    // Obfuscated email extraction (e.g., user [at] domain [dot] com)
    const obfuscated = [...html.matchAll(/([\w.%-]+)\s*\[at\]|\(at\)|@\s*([\w.-]+)\s*(\[dot\]|\(dot\)|\.|\s+dot\s+)([a-z]{2,})/gi)];
    for (const match of obfuscated) {
      const user = match[1] || '';
      const domain = match[2] || '';
      const tld = match[4] || '';
      if (user && domain && tld) {
        emails.push(`${user}@${domain}.${tld}`);
      }
    }

    // Heuristic: look for mailto links
    const mailtos = [...html.matchAll(/mailto:([\w.+%-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1]);
    emails.push(...mailtos);

    // Cheerio: extract visible text and run regexes
    const $ = cheerio.load(html);
    const visibleText = $('body').text();
    let emailsText = [...new Set((visibleText.match(EMAIL_REGEX) || []))];
    let phonesText = [...new Set((visibleText.match(PHONE_REGEX) || []))];
    emails.push(...emailsText);
    phones.push(...phonesText);

    emails = [...new Set(emails)].filter(e => !e.includes('example.com') && !e.includes('noreply'));
    phones = [...new Set(phones)];

    // Log page snippet if nothing found
    if (emails.length === 0 && phones.length === 0) {
      console.log(`[Scraper] [Extract] No contacts found on ${url}. Page snippet: ${visibleText.slice(0, 500)}`);
    }

    // If still nothing, optionally use LLM (Hugging Face)
    if (emails.length === 0 && process.env.HF_API_KEY_WRITERS_FLOW) {
      try {
        const prompt = `Extract all email addresses and phone numbers from this text. Output as JSON with keys 'emails' and 'phones'.\nText:\n${visibleText.slice(0, 2000)}`;
        const response = await axios.post(
          'https://api-inference.huggingface.co/models/mistralai/Mixtral-8x7B-Instruct-v0.1',
          { inputs: prompt },
          { headers: { Authorization: `Bearer ${process.env.HF_API_KEY_WRITERS_FLOW}` }, timeout: 15000 }
        );
        const llmOut = response.data?.[0]?.generated_text || '';
        console.log(`[Scraper] [Extract] LLM output for ${url}: ${llmOut.slice(0, 300)}`);
        const json = JSON.parse(llmOut.match(/\{[\s\S]*\}/)?.[0] || '{}');
        if (Array.isArray(json.emails)) emails.push(...json.emails);
        if (Array.isArray(json.phones)) phones.push(...json.phones);
      } catch (llmErr) {
        console.log(`[Scraper] [Extract] LLM extraction failed for ${url}: ${llmErr.message}`);
      }
    }

    emails = [...new Set(emails)].filter(e => !e.includes('example.com') && !e.includes('noreply'));
    phones = [...new Set(phones)];

    console.log(`[Scraper] [Extract] ${url} | emails: ${emails.length} | phones: ${phones.length}`);
    return { emails, phones };
  } catch (err) {
    console.log(`[Scraper] [Extract] ERROR fetching ${url}: ${err.message}`);
    return { emails: [], phones: [] };
  }
}

async function tryFetchContactPage(baseUrl) {
  // Try main page first
  let result = await extractContactsFromPage(baseUrl);
  if (result.emails.length > 0 || result.phones.length > 0) return result;

  // Try expanded set of subpages
  const contactPaths = [
    '/contact', '/contact-us', '/about', '/about-us', '/team', '/staff', '/directory', '/leadership', '/support', '/help', '/people', '/our-team', '/who-we-are', '/company', '/organization', '/board', '/executives', '/management', '/faculty', '/employees', '/personnel', '/members', '/partners', '/advisors', '/committee', '/trustees', '/officers', '/admin', '/administration', '/info', '/information', '/reach-us', '/get-in-touch', '/connect', '/connections', '/community', '/resources', '/departments', '/division', '/sections', '/units', '/services', '/locations', '/branches', '/offices', '/contacts', '/contactus', '/contactus.html', '/contact.html', '/aboutus', '/aboutus.html', '/team.html', '/staff.html', '/directory.html', '/leadership.html', '/support.html', '/help.html', '/people.html', '/our-team.html', '/who-we-are.html', '/company.html', '/organization.html', '/board.html', '/executives.html', '/management.html', '/faculty.html', '/employees.html', '/personnel.html', '/members.html', '/partners.html', '/advisors.html', '/committee.html', '/trustees.html', '/officers.html', '/admin.html', '/administration.html', '/info.html', '/information.html', '/reach-us.html', '/get-in-touch.html', '/connect.html', '/connections.html', '/community.html', '/resources.html', '/departments.html', '/division.html', '/sections.html', '/units.html', '/services.html', '/locations.html', '/branches.html', '/offices.html', '/contacts.html'
  ];
  for (const path of contactPaths) {
    try {
      const url = new URL(path, baseUrl).toString();
      const subResult = await extractContactsFromPage(url);
      if (subResult.emails.length > 0 || subResult.phones.length > 0) return subResult;
    } catch (err) {
      console.log(`[Scraper] [Extract] ERROR fetching subpage for ${baseUrl}: ${err.message}`);
    }
  }
  return { emails: [], phones: [] };
}

// ──────────────────────────────────────────────
// Build search queries from keywords + industries
// ──────────────────────────────────────────────

function buildQueries(keywords = [], industries = [], outreachTypes = ['pitch'], industryPlan = []) {
  const queries = [];
  const typeHints = {
    pitch: 'contact email site',
    proposal: 'RFP proposal contact email',
    partnership: 'partnership collaboration contact',
    employment: 'hiring careers contact email',
  };
  const baseKeywords = keywords.slice(0, 3).join(' ');

  const plannedIndustries = Array.isArray(industryPlan) && industryPlan.length
    ? industryPlan
        .map((p) => ({ industry: p.industry || '', priority: Number(p.score || p.priority || 0) }))
        .filter((p) => p.industry)
        .sort((a, b) => b.priority - a.priority)
    : (industries.length ? industries : ['']).map((industry, idx) => ({ industry, priority: 100 - idx }));

  for (const planned of plannedIndustries) {
    const industry = planned.industry;
    for (const type of outreachTypes) {
      const hint = typeHints[type] || 'contact email';
      const parts = [baseKeywords, industry, hint].filter(Boolean);
      queries.push({
        query: parts.join(' '),
        industry,
        outreachType: type,
        priority: planned.priority,
      });
    }
  }

  // Deduplicate query strings while preserving metadata
  const seen = new Set();
  const deduped = [];
  for (const item of queries) {
    if (!item.query || seen.has(item.query)) continue;
    seen.add(item.query);
    deduped.push(item);
  }

  return deduped.slice(0, 12);
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
  industryPlan = [],
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

  const queries = buildQueries(keywords, industries, outreachTypes, industryPlan);
  const seen = new Set();
  const leads = [];

  const scrapeStart = Date.now();
  for (const querySpec of queries) {
    if (leads.length >= targetCount) break;
    let results = [];
    console.log(`[Scraper] Running query: "${querySpec.query}" (industry=${querySpec.industry}, outreachType=${querySpec.outreachType})`);
    try {
      results = await runSearch(querySpec.query, 10);
      console.log(`[Scraper] Query results for "${querySpec.query}": ${results.length}`);
    } catch (err) {
      console.error(`[Scraper] Search failed for "${querySpec.query}": ${err.message}`);
      continue;
    }

    for (const r of results) {
      if (leads.length >= targetCount) break;
      if (!r.url || seen.has(r.url)) {
        if (!r.url) console.log(`[Scraper] Skipping result with missing URL.`);
        else console.log(`[Scraper] Skipping duplicate URL: ${r.url}`);
        continue;
      }
      seen.add(r.url);

      // Try quick email extract from snippet first
      const snippetEmails = (r.snippet.match(EMAIL_REGEX) || []).filter(
        e => !e.includes('example.com') && !e.includes('noreply')
      );

      let email = snippetEmails[0] || null;
      let phone = null;

      if (email) {
        console.log(`[Scraper] Found email in snippet for ${r.url}: ${email}`);
      }

      // If no email in snippet, try fetching the page
      if (!email) {
        console.log(`[Scraper] No email in snippet for ${r.url}, trying contact page extraction...`);
        const contacts = await tryFetchContactPage(r.url);
        email = contacts.emails[0] || null;
        phone = contacts.phones[0] || null;
        if (email) {
          console.log(`[Scraper] Found email on contact page for ${r.url}: ${email}`);
        } else {
          console.log(`[Scraper] No email found for ${r.url}`);
        }
      }

      leads.push({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        email,
        phone,
        sourceQuery: querySpec.query,
        industry: querySpec.industry || industries[0] || null,
        outreachType: querySpec.outreachType || outreachTypes[0] || 'pitch',
      });
    }
  }

  console.log(`[Scraper] All queries complete. Total leads found: ${leads.length} (time=${Date.now()-scrapeStart}ms)`);
  leads.forEach((lead, idx) => {
    console.log(`[Scraper] [Lead ${idx}] ${lead.title} | ${lead.url} | email=${lead.email || 'none'} | phone=${lead.phone || 'none'}`);
  });
  return leads;
}
