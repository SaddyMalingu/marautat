/**
 * LLM Service for Trendjack Hunter
 * Uses Claude/OpenAI to generate content briefs
 */

import config from "./config.js";

const logger = {
  log: (msg, level = "INFO") => console.log(`[${level}] ${msg}`),
};

/**
 * Generate LLM-powered content brief
 * @param {object} trendData - Classified trend data
 * @returns {object} - Generated content
 */
export async function generateLLMContentBrief(trendData) {
  if (!config.openai.apiKey) {
    logger.log("OpenAI API key not configured, using fallback", "WARN");
    return generateFallbackContentBrief(trendData);
  }

  try {
    const prompt = buildPrompt(trendData);

    // Simulate API call (in production, use actual OpenAI API)
    const response = await callLLM(prompt);

    return parseResponse(response);
  } catch (error) {
    logger.log(`LLM call failed: ${error.message}, using fallback`, "WARN");
    return generateFallbackContentBrief(trendData);
  }
}

/**
 * Build prompt for LLM
 */
function buildPrompt(trendData) {
  return `
You are a content strategist for Kuzana, a Kenya-based SME accelerator. Create a content brief for this trending topic that resonates with entrepreneurs and founders.

TREND: ${trendData.trend}
PLATFORM: ${trendData.platform}
RELEVANCE_SCORE: ${trendData.relevanceScore}/100
LIFESPAN: ~${trendData.lifespan.estimatedHours} hours

Generate a content brief with:

1. WHAT IS HAPPENING (1-2 sentences)
   - Clear explanation of the trend

2. WHY IT'S SPREADING (1 sentence)
   - Why people care about this

3. KUZANA ANGLE (1-2 sentences)
   - How this relates to entrepreneurs and founders

4. WHY THIS MATTERS (1 sentence)
   - Business/founder relevance

5. HOOK (15-20 words)
   - Attention-grabbing opening line for video

6. SCRIPT (60-80 words, ~30-45 seconds)
   - Engaging video script for creators
   - Include the hook
   - Include a clear CTA

Format your response as JSON with these exact keys:
{
  "whatIsHappening": "...",
  "whyItsSpreading": "...",
  "kuzanaAngle": "...",
  "whyThisMatters": "...",
  "hook": "...",
  "script": "...",
  "confidenceLevel": "high|medium|low"
}
`;
}

/**
 * Simulate LLM call (in production, use actual API)
 */
async function callLLM(prompt) {
  // Placeholder for actual OpenAI API call
  // In production: use OpenAI client library
  logger.log("Calling LLM for content generation...", "DEBUG");

  // For now, return structured fallback
  // Replace with actual OpenAI API call
  return generateFallbackResponse(prompt);
}

/**
 * Parse LLM response
 */
function parseResponse(response) {
  try {
    // Handle JSON response from LLM
    const parsed = typeof response === "string" ? JSON.parse(response) : response;

    return {
      whatIsHappening: parsed.whatIsHappening || "",
      whyItsSpreading: parsed.whyItsSpreading || "",
      kuzanaAngle: parsed.kuzanaAngle || "",
      whyThisMatters: parsed.whyThisMatters || "",
      hook: parsed.hook || "",
      script: parsed.script || "",
      confidenceLevel: parsed.confidenceLevel || "medium",
    };
  } catch (error) {
    logger.log(`Failed to parse LLM response: ${error.message}`, "ERROR");
    return generateFallbackResponse();
  }
}

/**
 * Fallback content brief generation (no LLM call)
 */
function generateFallbackContentBrief(trendData) {
  const trend = trendData.trend;
  const platform = trendData.platform;

  return {
    whatIsHappening: `${trend} is gaining significant traction on ${platform}. People are engaging with this topic at scale.`,
    whyItsSpreading: `The trend resonates because it addresses something people care deeply about - whether it's practical tips, entertainment, or relatability.`,
    kuzanaAngle: `For Kuzana's founder community, this is an opportunity to showcase how entrepreneurial thinking applies to this moment. Founders solve problems, and this trend shows where market attention is flowing.`,
    whyThisMatters: `Trends show us what your audience is thinking about. Content creators who jump on relevant trends get 5-10x more engagement than evergreen content.`,
    hook: `Did you know? Here's what every founder needs to understand about ${trend}...`,
    script: `Everyone's talking about ${trend} right now. Here's what's actually happening: [EXPLAIN]. The reason this matters to us as founders is [WHY]. If you're building something, here's the action: [CALL TO ACTION]. What's your take?`,
    confidenceLevel: "medium",
  };
}

/**
 * Generate fallback response when LLM is unavailable
 */
function generateFallbackResponse(prompt = "") {
  // Extract trend from prompt if available
  const trendMatch = prompt?.match(/TREND: (.+)\n/);
  const trend = trendMatch ? trendMatch[1] : "this trend";

  return JSON.stringify({
    whatIsHappening: `${trend} is trending across social platforms with significant engagement.`,
    whyItsSpreading: `People are connecting with this topic because it's timely, relatable, or provides value.`,
    kuzanaAngle: `This is a perfect moment for Kuzana to share founder insights on how entrepreneurs can leverage or learn from ${trend}.`,
    whyThisMatters: `Founder and SME audiences engage 5-10x more with content that speaks to trends they care about.`,
    hook: `Wait, you haven't heard about ${trend} yet? Here's what you need to know...`,
    script: `${trend} is everywhere right now. Here's why it matters: It shows where market attention is flowing. For founders, that means there's an opportunity. Whether it's a new problem to solve, a new audience to reach, or a new way to think about your business. Here's what smart founders are doing about it. What's your move?`,
    confidenceLevel: "medium",
  });
}

/**
 * Batch generate briefs for multiple trends
 */
export async function generateMultipleBriefs(trends) {
  const results = [];

  for (const trend of trends) {
    try {
      const brief = await generateLLMContentBrief(trend);
      results.push({
        trend: trend.trend,
        brief,
        status: "success",
      });
    } catch (error) {
      logger.log(`Failed to generate brief for ${trend.trend}: ${error.message}`, "ERROR");
      results.push({
        trend: trend.trend,
        brief: null,
        status: "failed",
        error: error.message,
      });
    }
  }

  return results;
}

export default {
  generateLLMContentBrief,
  generateMultipleBriefs,
};
