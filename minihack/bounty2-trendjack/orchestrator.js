/**
 * Trendjack Hunter - Main Orchestrator
 * Coordinates trend monitoring, classification, and content brief generation
 * Follows the same pattern as Writer's Flow
 */

import {
  fetchTwitterTrends,
  fetchTikTokTrends,
  fetchRedditTrends,
  fetchYouTubeTrends,
  fetchKenyaNews,
} from "./sources.js";
import { rankTrends, generateTrendContext } from "./classifier.js";
import { generateContentBrief } from "./contentBriefGenerator.js";
import config from "./config.js";

const logger = {
  log: (msg, level = "INFO") => console.log(`[TRENDJACK] [${level}] ${msg}`),
};

/**
 * Main orchestrator function
 * Call this to run the Trendjack Hunter workflow
 */
export default async function runTrendjackHunter({
  userId = null,
  fromPhone = null,
  context = {},
  maxBriefs = 3,
  platforms = ["twitter", "tiktok", "reddit", "youtube", "news"],
} = {}) {
  const startTime = Date.now();
  const sessionId = `tj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    logger.log(`[${sessionId}] Starting Trendjack Hunter orchestration...`, "INFO");

    // STEP 1: Collect trends from all enabled platforms
    const allTrends = await collectTrendsFromPlatforms(platforms);
    logger.log(`[${sessionId}] Collected ${allTrends.length} trends from platforms`, "INFO");

    if (allTrends.length === 0) {
      logger.log(`[${sessionId}] No trends collected`, "WARN");
      return {
        ok: false,
        sessionId,
        briefsGenerated: 0,
        error: "No trends available",
      };
    }

    // STEP 2: Classify and rank trends by relevance
    const rankedTrends = rankTrends(allTrends);
    logger.log(`[${sessionId}] Ranked ${rankedTrends.length} relevant trends`, "INFO");

    if (rankedTrends.length === 0) {
      logger.log(`[${sessionId}] No relevant trends found`, "WARN");
      return {
        ok: false,
        sessionId,
        briefsGenerated: 0,
        error: "No trends relevant to Kuzana audience",
      };
    }

    // STEP 3: Generate content briefs for top N trends
    const topTrends = rankedTrends.slice(0, maxBriefs);
    const briefs = await generateBriefsForTrends(topTrends);

    logger.log(`[${sessionId}] Generated ${briefs.length} content briefs`, "INFO");

    // STEP 4: Format response
    const duration = Date.now() - startTime;
    const response = {
      ok: true,
      sessionId,
      briefsGenerated: briefs.length,
      briefs,
      summary: {
        totalTrendsAnalyzed: allTrends.length,
        relevantTrends: rankedTrends.length,
        contentBriefCount: briefs.length,
        durationMs: duration,
        processingTimeSeconds: Math.round(duration / 1000),
      },
      metadata: {
        userId,
        fromPhone,
        generatedAt: new Date().toISOString(),
        platforms: platforms.join(", "),
      },
    };

    logger.log(
      `[${sessionId}] Orchestration complete (${duration}ms). Generated ${briefs.length} briefs.`,
      "INFO"
    );
    return response;
  } catch (error) {
    logger.log(`[${sessionId}] Orchestration failed: ${error.message}`, "ERROR");
    return {
      ok: false,
      sessionId,
      briefsGenerated: 0,
      error: error.message,
    };
  }
}

/**
 * Collect trends from specified platforms
 */
async function collectTrendsFromPlatforms(platforms) {
  const allTrends = [];
  const results = {};

  const platformFetchers = {
    twitter: fetchTwitterTrends,
    tiktok: fetchTikTokTrends,
    reddit: fetchRedditTrends,
    youtube: fetchYouTubeTrends,
    news: fetchKenyaNews,
  };

  // Fetch in parallel
  const promises = platforms
    .filter((p) => config.platforms[p]?.enabled)
    .map(async (platform) => {
      try {
        const fetcher = platformFetchers[platform];
        if (!fetcher) {
          logger.log(`Unknown platform: ${platform}`, "WARN");
          return;
        }

        const { trends, error } = await fetcher();
        results[platform] = { trends, error };

        if (error) {
          logger.log(`${platform}: ${error}`, "WARN");
        } else {
          logger.log(`${platform}: ${trends.length} trends collected`, "DEBUG");
          allTrends.push(...trends);
        }
      } catch (err) {
        logger.log(`${platform} fetch error: ${err.message}`, "ERROR");
        results[platform] = { trends: [], error: err.message };
      }
    });

  await Promise.all(promises);

  logger.log(`Trend collection summary: ${JSON.stringify(results)}`, "DEBUG");
  return allTrends;
}

/**
 * Generate content briefs for classified trends
 */
async function generateBriefsForTrends(trends) {
  const briefs = [];

  for (const trendData of trends) {
    try {
      // Generate trend context
      const context = generateTrendContext(trendData);

      // Generate full content brief
      const brief = await generateContentBrief({
        ...trendData,
        context,
      });

      briefs.push(brief);
    } catch (error) {
      logger.log(`Failed to generate brief for ${trendData.trend}: ${error.message}`, "ERROR");
    }
  }

  return briefs;
}

/**
 * Format briefs for WhatsApp delivery
 */
export function formatBriefsForWhatsApp(briefs) {
  if (!briefs || briefs.length === 0) {
    return "No trends available at this time.";
  }

  let message = "🚀 *Trendjack Hunter Alert*\n\n";
  message += `Found ${briefs.length} trending opportunity(ies) for Kuzana content:\n\n`;

  briefs.forEach((brief, index) => {
    message += `*${index + 1}. ${brief.trend}*\n`;
    message += `📱 Platform: ${brief.platform}\n`;
    message += `⏱️ Time to shoot: ${brief.timelineMinutes} mins\n`;
    message += `📊 Engagement potential: ${brief.metadata.estimatedViews.toLocaleString()} views\n`;
    message += `🎯 Kuzana angle: ${brief.angle.kuzanaAngle}\n`;
    message += `📌 Hook: "${brief.hook.primary}"\n`;
    message += `\n`;
  });

  message += "_Get full briefs in dashboard or reply BRIEF <number> for details_";
  return message;
}

/**
 * Export stats for dashboard
 */
export function getStatistics() {
  return {
    lastUpdated: new Date().toISOString(),
    platforms: Object.keys(config.platforms).filter((p) => config.platforms[p].enabled),
    pollingInterval: `${config.polling.trendCheckIntervalMs / 1000}s`,
    maxTrendLifespan: `${config.polling.maxTrendLifespanHours}h`,
    relevanceKeywordCount: config.relevanceKeywords.length,
  };
}

/**
 * Test orchestrator
 */
export async function testOrchestrator() {
  logger.log("Running Trendjack Hunter test...", "INFO");

  const result = await runTrendjackHunter({
    userId: "test-user",
    maxBriefs: 2,
    platforms: ["twitter", "reddit"],
  });

  logger.log(`Test result: ${JSON.stringify(result, null, 2)}`, "INFO");
  return result;
}

export default runTrendjackHunter;
