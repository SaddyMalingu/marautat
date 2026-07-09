/**
 * Trend Classification Engine
 * Determines if a trend is relevant to Kuzana's audience (entrepreneurs, business, money, founder culture)
 */

import config from "./config.js";

const logger = {
  log: (msg, level = "INFO") => console.log(`[${level}] ${msg}`),
};

/**
 * Check if a trend/content is relevant to Kuzana's audience
 * @param {string} text - The trend text/content
 * @param {object} metadata - Optional metadata (platform, metrics, etc)
 * @returns {object} - { isRelevant, relevanceScore, reason, lifespan }
 */
export function classifyTrend(text, metadata = {}) {
  const lowerText = text.toLowerCase();

  // Check for excluded keywords (spam, harmful content)
  for (const excluded of config.excludedKeywords) {
    if (lowerText.includes(excluded.toLowerCase())) {
      return {
        isRelevant: false,
        relevanceScore: 0,
        reason: `Contains excluded keyword: ${excluded}`,
        lifespan: null,
      };
    }
  }

  // Check for relevant keywords
  let relevanceScore = 0;
  const foundKeywords = [];

  for (const keyword of config.relevanceKeywords) {
    if (lowerText.includes(keyword.toLowerCase())) {
      relevanceScore += 10;
      foundKeywords.push(keyword);
    }
  }

  // Boost score based on metrics (if available)
  if (metadata.engagement) {
    if (metadata.engagement > 10000) relevanceScore += 30;
    else if (metadata.engagement > 1000) relevanceScore += 20;
    else if (metadata.engagement > 100) relevanceScore += 10;
  }

  if (metadata.platform === "news" && metadata.source?.includes("kenya")) {
    relevanceScore += 15;
  }

  // Estimate lifespan based on content type and relevance
  const lifespan = estimateTrendLifespan(text, metadata, relevanceScore);

  const isRelevant = relevanceScore >= 15; // Threshold

  return {
    isRelevant,
    relevanceScore: Math.min(100, relevanceScore),
    foundKeywords,
    reason: isRelevant
      ? `Relevant to Kuzana audience (keywords: ${foundKeywords.slice(0, 3).join(", ")})`
      : "Low relevance score - not targeted enough",
    lifespan,
  };
}

/**
 * Estimate how long a trend will remain relevant
 * @returns {object} - { estimatedHours, category }
 */
function estimateTrendLifespan(text, metadata, score) {
  const lowerText = text.toLowerCase();

  // News trends typically last longer
  if (metadata.platform === "news") {
    return {
      estimatedHours: 72,
      category: "news",
      reason: "News-based trends typically have 72-hour lifespan",
    };
  }

  // Check for evergreen content (always relevant)
  const evergreenKeywords = [
    "how to",
    "guide",
    "tutorial",
    "tips",
    "best practices",
    "mistakes to avoid",
  ];
  if (evergreenKeywords.some((kw) => lowerText.includes(kw))) {
    return {
      estimatedHours: 168, // 1 week
      category: "evergreen",
      reason: "Evergreen content remains relevant longer",
    };
  }

  // Event-based trends (fast-moving)
  const eventKeywords = ["launch", "breaking", "announced", "revealed", "just dropped"];
  if (eventKeywords.some((kw) => lowerText.includes(kw))) {
    return {
      estimatedHours: 24,
      category: "event",
      reason: "Event-based trends are short-lived (24 hours)",
    };
  }

  // Meme/viral trends (very fast-moving)
  if (metadata.platform === "tiktok" || metadata.platform === "twitter") {
    if (score < 30) {
      return {
        estimatedHours: 12,
        category: "viral",
        reason: "Viral trends peak within 12 hours",
      };
    }
    return {
      estimatedHours: 48,
      category: "trending",
      reason: "Platform trends typically last 24-48 hours",
    };
  }

  // Default
  return {
    estimatedHours: 36,
    category: "standard",
    reason: "Standard trend lifespan estimation",
  };
}

/**
 * Score multiple trends and rank them
 * @param {array} trends - Array of { trend, score, platform, metadata }
 * @returns {array} - Ranked and classified trends
 */
export function rankTrends(trends) {
  const classified = trends
    .map((trendData) => {
      const classification = classifyTrend(trendData.trend, {
        platform: trendData.platform,
        engagement: trendData.score,
      });

      return {
        ...trendData,
        ...classification,
        combinedScore: (trendData.score || 0) * (classification.relevanceScore / 100),
      };
    })
    .filter((t) => t.isRelevant)
    .sort((a, b) => b.combinedScore - a.combinedScore);

  return classified;
}

/**
 * Generate context about a trend
 * @param {object} trendData - Classified trend data
 * @returns {object} - Context for content generation
 */
export function generateTrendContext(trendData) {
  return {
    trendName: trendData.trend,
    relevanceScore: trendData.relevanceScore,
    platform: trendData.platform,
    lifespan: trendData.lifespan,
    urgency: trendData.lifespan.estimatedHours <= 24 ? "high" : "medium",
    context: {
      whatsHappening: `${trendData.trend} is trending on ${trendData.platform}`,
      whyItsSpreading: generateWhyItsSpreading(trendData),
      estimatedLifespan: trendData.lifespan.estimatedHours,
      businessAngle: generateBusinessAngle(trendData),
    },
  };
}

function generateWhyItsSpreading(trendData) {
  const platform = trendData.platform;
  const reasons = {
    twitter: "People are actively discussing and sharing opinions",
    tiktok: "The trend is being adopted and remixed in creative ways",
    reddit: "Communities are finding it relatable and discussing depth",
    youtube: "Content creators are producing videos around this topic",
    news: "News outlets are covering this emerging story",
  };

  return reasons[platform] || "The trend is gaining traction across multiple platforms";
}

function generateBusinessAngle(trendData) {
  const trend = trendData.trend.toLowerCase();

  if (trend.includes("startup") || trend.includes("founder")) {
    return "Leverage this moment to share founder stories or startup lessons";
  }
  if (trend.includes("business") || trend.includes("entrepreneur")) {
    return "This is a direct business topic - share actionable insights";
  }
  if (trend.includes("money") || trend.includes("revenue")) {
    return "Connect to personal finance or business revenue principles";
  }
  if (trend.includes("side") || trend.includes("hustle")) {
    return "Perfect angle for side hustle or passive income content";
  }

  return "Adapt this trend to showcase Kuzana founder wisdom";
}

export default {
  classifyTrend,
  rankTrends,
  generateTrendContext,
};
