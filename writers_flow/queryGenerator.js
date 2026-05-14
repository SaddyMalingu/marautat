// writers_flow/queryGenerator.js
// LLM-powered search query generator for sector-specific lead extraction
import { hfChatCompletion } from './hfLLM.js';

/**
 * Generate a set of high-value search queries for a given sector and value proposition.
 * @param {string} userCommand - The user's original request (e.g., "find me 30 opportunities in healthcare").
 * @param {string} sector - The target sector (e.g., "healthcare").
 * @param {string} valueProps - Alphadome's value proposition summary.
 * @returns {Promise<string[]>} Array of search queries.
 */
export async function generateSearchQueries(userCommand, sector, valueProps) {
  const prompt = `
You are an expert AI business development strategist for Alphadome, which builds information systems (websites, apps, bots, custom software) and automates operations/content for businesses using advanced AI agents.

Your task: Given the sector: "${sector}", the user request: "${userCommand}", and Alphadome's value proposition: "${valueProps}", generate a list of 10 highly diverse, creative, and sector-intelligent search queries.

Guidelines:
- Cover a wide range of sub-industries, business types, and digital transformation opportunities within the sector.
- Include queries targeting organizations with outdated digital presence, manual operations, or high potential for AI automation.
- Vary the queries: some broad, some niche, some targeting pain points, some targeting innovators.
- Use synonyms and related terms for the sector and value proposition.
- Make queries actionable for Google/Bing/SerpAPI (e.g., "top fintech startups seeking automation", "healthcare clinics with outdated websites", "manufacturers AI digital transformation case studies").
- Output ONLY the queries as a JSON array of strings, no explanation.
`;
  let response;
  try {
    response = await hfChatCompletion({ prompt, max_tokens: 500, temperature: 0.85 });
    const queries = JSON.parse(response);
    if (Array.isArray(queries)) return queries;
    throw new Error('Not an array');
  } catch {
    // Fallback: try to extract JSON array from text
    const match = response?.match(/\[.*\]/s);
    if (match) {
      try {
        const queries = JSON.parse(match[0]);
        if (Array.isArray(queries)) return queries;
      } catch {}
    }
    // Final fallback: return generic queries
    return [
      `"${sector}" organizations digital transformation opportunities`,
      `"${sector}" companies AI automation case studies`,
      `"${sector}" manual operations digital upgrade`,
      `"${sector}" outdated websites`,
      `"${sector}" innovation leaders`,
      `"${sector}" pain points automation`,
      `"${sector}" digital-first startups`,
      `"${sector}" process automation`,
      `"${sector}" AI adoption`,
      `"${sector}" business digitalization`
    ];
  }
}
