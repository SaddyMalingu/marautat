/**
 * Content Brief Generator
 * Generates production-ready content briefs from trends
 * Includes: hook, script, remix template, angle
 */

import config from "./config.js";
import { generateLLMContentBrief } from "./llmService.js";

const logger = {
  log: (msg, level = "INFO") => console.log(`[${level}] ${msg}`),
};

/**
 * Generate a complete content brief for a trend
 * @param {object} trendData - Classified and contextualized trend
 * @returns {object} - Production-ready content brief
 */
export async function generateContentBrief(trendData) {
  try {
    // 1. Generate LLM-powered content
    const llmContent = await generateLLMContentBrief(trendData);

    // 2. Create the content brief structure
    const brief = {
      trendId: `trend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      trend: trendData.trend,
      platform: trendData.platform,
      generatedAt: new Date().toISOString(),
      urgency: trendData.urgency,
      timelineMinutes: estimateProductionTime(llmContent),

      // What is happening
      summary: {
        whatIsHappening: llmContent.whatIsHappening || trendData.context.whatsHappening,
        whyItsSpreading: llmContent.whyItsSpreading || trendData.context.whyItsSpreading,
        estimatedLifespanHours: trendData.lifespan.estimatedHours,
      },

      // Kuzana angle
      angle: {
        kuzanaAngle: llmContent.kuzanaAngle || trendData.context.businessAngle,
        whyThisMatters: llmContent.whyThisMatters || "This trend directly impacts Kuzana's audience",
        opportunityWindow: `${trendData.lifespan.estimatedHours} hours from trend detection`,
      },

      // Hook (opening line)
      hook: {
        primary: llmContent.hook,
        alternatives: [
          generateHookVariation(trendData, "curiosity"),
          generateHookVariation(trendData, "urgency"),
          generateHookVariation(trendData, "relatability"),
        ],
      },

      // Script (30-60 seconds)
      script: {
        full: llmContent.script,
        wordCount: (llmContent.script || "").split(/\s+/).length,
        duration: estimateVideoDuration(llmContent.script),
        keyPoints: extractKeyPoints(llmContent.script),
      },

      // Remix template
      remixTemplate: config.contentBrief.includeRemixTemplate
        ? generateRemixTemplate(trendData, llmContent)
        : null,

      // Content production checklist
      productionChecklist: [
        {
          item: "Record hook and opening (10 seconds)",
          priority: "critical",
          estimated_minutes: 5,
        },
        {
          item: "Film main content segment (40-60 seconds)",
          priority: "critical",
          estimated_minutes: 15,
        },
        {
          item: "Add relevant B-roll or graphics",
          priority: "high",
          estimated_minutes: 10,
        },
        {
          item: "Add captions/text overlays",
          priority: "medium",
          estimated_minutes: 5,
        },
        {
          item: "Final edit and export",
          priority: "medium",
          estimated_minutes: 5,
        },
      ],

      // Platform-specific adaptations
      platformAdaptations: generatePlatformAdaptations(trendData, llmContent),

      // Metadata for tracking
      metadata: {
        relevanceScore: trendData.relevanceScore,
        confidenceLevel: llmContent.confidenceLevel || "high",
        sourceTrends: [trendData.trend],
        tags: extractTags(trendData, llmContent),
        estimatedViews: estimateReachPotential(trendData),
        audienceSegment: "Kuzana founder community",
      },
    };

    logger.log(
      `Content brief generated for "${trendData.trend}" (${trendData.platform})`,
      "INFO"
    );
    return brief;
  } catch (error) {
    logger.log(`Content brief generation failed: ${error.message}`, "ERROR");
    throw error;
  }
}

/**
 * Generate hook variations with different angles
 */
function generateHookVariation(trendData, angle) {
  const trend = trendData.trend;

  if (angle === "curiosity") {
    return `Did you know about ${trend}? Here's what you need to know...`;
  }
  if (angle === "urgency") {
    return `Everyone's talking about ${trend} - and here's why it matters for your business...`;
  }
  if (angle === "relatability") {
    return `If you're building something, you've probably thought about ${trend}...`;
  }

  return `Let's talk about ${trend}...`;
}

/**
 * Estimate video duration from script
 */
function estimateVideoDuration(script) {
  const wordCount = (script || "").split(/\s+/).length;
  const wordsPerSecond = 2.5; // Average speaking rate
  const durationSeconds = Math.round(wordCount / wordsPerSecond);

  return {
    seconds: durationSeconds,
    formatted: formatDuration(durationSeconds),
    category: durationSeconds <= 60 ? "short_form" : "long_form",
  };
}

/**
 * Extract key points from script
 */
function extractKeyPoints(script) {
  const sentences = (script || "").split(/[.!?]+/).filter(Boolean);
  return sentences
    .slice(0, 3)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

/**
 * Generate platform-specific adaptations
 */
function generatePlatformAdaptations(trendData, llmContent) {
  return {
    tiktok: {
      format: "Short-form video (15-60 seconds)",
      hook: llmContent.hook,
      musicSuggestion: "Trending audio that fits the trend",
      hashtags: generateHashtags(trendData, llmContent),
      captionStyle: "Text overlays + captions",
    },
    instagram: {
      format: "Reel (15-90 seconds)",
      hook: llmContent.hook,
      coverImage: "Eye-catching first frame",
      hashtags: generateHashtags(trendData, llmContent),
      captionStyle: "Narrative caption (150-300 chars)",
    },
    youtube: {
      format: "YouTube Short (15-60 seconds) or regular video",
      title: `${trendData.trend} - What You Need to Know`,
      description: llmContent.whatIsHappening,
      thumbnail: "Bold, clear text + relevant imagery",
      hashtags: generateHashtags(trendData, llmContent),
    },
    twitter: {
      format: "Thread or video tweet",
      tweet1: llmContent.hook,
      threadLength: "3-5 tweets",
      callToAction: "Reply with your thoughts",
    },
  };
}

/**
 * Generate hashtags for the content
 */
function generateHashtags(trendData, llmContent) {
  const baseHashtags = [
    "#Kuzana",
    "#Entrepreneur",
    "#BusinessTips",
    "#StartupLife",
    "#KenyaBusiness",
  ];

  const trendHashtags = trendData.trend
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => `#${word}`)
    .filter((h) => h.length > 2 && h.length < 30);

  return [...baseHashtags, ...trendHashtags].slice(0, 10);
}

/**
 * Generate remix template for adapting the trend
 */
function generateRemixTemplate(trendData, llmContent) {
  return {
    title: "Remix this trend for your business",
    template: `
    1. IDENTIFY the core of ${trendData.trend}
    2. TRANSLATE it to a business/founder context
    3. ADD your unique insight or story
    4. CREATE a 30-second hook that connects it
    5. CALL audiences to action (comment, share, ask questions)
    `,
    example: {
      coreOfTrend: `The core is: ${llmContent.whatIsHappening}`,
      businessTranslation: `How this applies to founders/businesses`,
      uniqueInsight: "Your unique perspective or story",
      actionableHook: llmContent.hook,
      cta: "What should your audience do next?",
    },
  };
}

/**
 * Generate production checklist tags
 */
function extractTags(trendData, llmContent) {
  const tags = [
    trendData.platform,
    "content-brief",
    "kuzana",
    trendData.lifespan.category,
  ];

  if (trendData.urgency === "high") {
    tags.push("urgent");
  }

  if (trendData.relevanceScore > 70) {
    tags.push("high-relevance");
  }

  return tags;
}

/**
 * Estimate reach potential based on trend metrics
 */
function estimateReachPotential(trendData) {
  const baseEstimate = 5000; // Conservative estimate
  const multipliers = {
    twitter: 1.2,
    tiktok: 1.8,
    instagram: 1.5,
    youtube: 2.0,
    reddit: 0.8,
    news: 1.3,
  };

  const multiplier = multipliers[trendData.platform] || 1;
  const relevanceBoost = trendData.relevanceScore / 100;

  return Math.round(baseEstimate * multiplier * (0.5 + relevanceBoost));
}

/**
 * Estimate total production time
 */
function estimateProductionTime(content) {
  // Hook: 2 minutes
  // Script: 8 minutes
  // B-roll/graphics: 8 minutes
  // Editing: 5 minutes
  // Total: ~23 minutes (round to 25)
  return 25;
}

/**
 * Format duration into readable format
 */
function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes === 0) return `${secs}s`;
  return `${minutes}m ${secs}s`;
}

export default {
  generateContentBrief,
};
