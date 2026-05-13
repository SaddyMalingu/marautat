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
You are an AI business development assistant for Alphadome, which automates operations and content for businesses via AI agents.
Given the sector: "${sector}", and the following user request: "${userCommand}", generate a list of 10 diverse, high-value search queries to find organizations that would benefit from Alphadome's services (AI automation, digital ops, content, etc.).
Focus on sub-industries, business types, and digital-first opportunities. Return only the queries as a JSON array of strings.
`;
  const response = await hfChatCompletion({ prompt, max_tokens: 400, temperature: 0.7 });
  try {
    const queries = JSON.parse(response);
    if (Array.isArray(queries)) return queries;
    throw new Error('Not an array');
  } catch {
    // Fallback: try to extract JSON array from text
    const match = response.match(/\[.*\]/s);
    if (match) {
      try {
        const queries = JSON.parse(match[0]);
        if (Array.isArray(queries)) return queries;
      } catch {}
    }
    throw new Error('Failed to parse LLM query output: ' + response);
  }
}
