/**
 * MiniHack Central Router
 * Unified interface for all bounty modules
 * Routes intents to appropriate bounty orchestrators
 */

import runTrendjack, { formatBriefsForWhatsApp as formatTrendjack } from "./bounty2-trendjack/orchestrator.js";

const logger = {
  log: (msg, level = "INFO") => console.log(`[MINIHACK-ROUTER] [${level}] ${msg}`),
};

/**
 * Registry of all bounty modules
 */
export const bountyRegistry = {
  bounty1_financial: {
    name: "Financial Controller",
    intent: "minihack_financial",
    keywords: /(financial|audit|books|accounting|cash flow|zoho)/i,
    enabled: false, // Not yet implemented
    description: "AI financial auditor for Zoho Books integration",
  },

  bounty2_trendjack: {
    name: "Trendjack Hunter",
    intent: "minihack_trendjack",
    keywords: /(trendjack|trend|viral|what['']s trending|trending)/i,
    enabled: true,
    description: "Real-time trend monitoring and content brief generation",
    module: runTrendjack,
    formatter: formatTrendjack,
    timeout: 30000,
    sampleInput:
      "What's trending? / Find me a trend for content / TRENDJACK",
  },

  bounty3_boardy: {
    name: "Boardy.ai for Kuzana",
    intent: "minihack_boardy",
    keywords: /(boardy|match|connection|mentor|investor|introduction)/i,
    enabled: false, // Not yet implemented
    description: "AI-powered conversational matchmaking system",
  },

  bounty4_equity: {
    name: "Equity Investing Legal Framework",
    intent: "minihack_equity",
    keywords: /(legal|template|document|agreement|founder agreement|investment agreement)/i,
    enabled: false, // Not yet implemented
    description: "Founder-friendly, investor-friendly legal templates for Kenya",
  },

  bounty5_discovery: {
    name: "Find Kenya's Hidden Champions",
    intent: "minihack_discovery",
    keywords: /(hidden|champion|business|discover|profile|remarkable)/i,
    enabled: false, // Not yet implemented
    description: "Discovery engine for exceptional Kenyan businesses",
  },

  bounty6_knowledge: {
    name: "Kuzana Brain - Institutional Knowledge System",
    intent: "minihack_knowledge",
    keywords: /(brain|know|answer|knowledge|faq|help)/i,
    enabled: false, // Not yet implemented
    description: "Retrieval system for organizational knowledge",
  },
};

/**
 * Main router function
 * Detects intent and routes to appropriate bounty
 */
export function detectMiniHackIntent(text) {
  const lowerText = String(text || "").toLowerCase();

  for (const [key, bounty] of Object.entries(bountyRegistry)) {
    if (!bounty.enabled) continue;
    if (bounty.keywords.test(lowerText)) {
      return bounty.intent;
    }
  }

  return null; // No minihack intent detected
}

/**
 * Execute a minihack bounty
 */
export async function executeMiniHackBounty(intent, params = {}) {
  const bounty = findBountyByIntent(intent);

  if (!bounty) {
    return {
      ok: false,
      error: "Unknown minihack intent",
      intent,
    };
  }

  if (!bounty.enabled) {
    return {
      ok: false,
      error: `${bounty.name} is not yet available`,
      intent,
    };
  }

  if (!bounty.module) {
    return {
      ok: false,
      error: `${bounty.name} module not loaded`,
      intent,
    };
  }

  try {
    logger.log(`Executing ${bounty.name}...`, "INFO");

    // Execute with timeout protection
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${bounty.name} execution timeout`)),
        bounty.timeout || 30000
      )
    );

    const result = await Promise.race([bounty.module(params), timeoutPromise]);

    logger.log(
      `${bounty.name} completed: ${result.ok ? "success" : "failed"}`,
      "INFO"
    );

    return {
      ...result,
      bountyName: bounty.name,
      intent,
    };
  } catch (error) {
    logger.log(`${bounty.name} error: ${error.message}`, "ERROR");
    return {
      ok: false,
      error: error.message,
      bountyName: bounty.name,
      intent,
    };
  }
}

/**
 * Find bounty by intent
 */
function findBountyByIntent(intent) {
  for (const bounty of Object.values(bountyRegistry)) {
    if (bounty.intent === intent) return bounty;
  }
  return null;
}

/**
 * Get status of all bounties
 */
export function getMinihackStatus() {
  return {
    generatedAt: new Date().toISOString(),
    bounties: Object.entries(bountyRegistry).map(([key, bounty]) => ({
      id: key,
      name: bounty.name,
      intent: bounty.intent,
      enabled: bounty.enabled,
      keywords: bounty.keywords.source,
      description: bounty.description,
      sampleInput: bounty.sampleInput || null,
      timeout: bounty.timeout || null,
    })),
    summary: {
      total: Object.keys(bountyRegistry).length,
      enabled: Object.values(bountyRegistry).filter((b) => b.enabled).length,
      disabled: Object.values(bountyRegistry).filter((b) => !b.enabled).length,
    },
  };
}

/**
 * Format output for different platforms
 */
export function formatBountyOutput(result, platform = "whatsapp") {
  if (platform === "whatsapp") {
    return formatBountyOutputWhatsApp(result);
  }
  return result; // Default: return as-is
}

function formatBountyOutputWhatsApp(result) {
  if (!result.ok) {
    return `⚠️ ${result.bountyName || "MiniHack"}: ${result.error}`;
  }

  // Delegate to bounty-specific formatter if available
  const bounty = findBountyByIntent(result.intent);
  if (bounty?.formatter) {
    return bounty.formatter(result.briefs || result.data || result);
  }

  // Default formatting
  return `✅ ${result.bountyName} completed successfully`;
}

/**
 * Test all enabled bounties
 */
export async function testAllBounties() {
  const results = {};

  for (const [key, bounty] of Object.entries(bountyRegistry)) {
    if (!bounty.enabled) continue;

    try {
      logger.log(`Testing ${bounty.name}...`, "INFO");
      const result = await executeMiniHackBounty(bounty.intent, {
        userId: "test-user",
        maxBriefs: 2,
      });
      results[key] = result;
    } catch (error) {
      results[key] = { ok: false, error: error.message };
    }
  }

  return results;
}

/**
 * Log bounty usage for analytics
 */
export async function logBountyUsage(intent, result, params = {}) {
  const bounty = findBountyByIntent(intent);
  if (!bounty) return;

  const logEntry = {
    timestamp: new Date().toISOString(),
    bountyName: bounty.name,
    intent,
    success: result.ok,
    durationMs: result.summary?.durationMs || null,
    userId: params.userId || null,
    fromPhone: params.fromPhone || null,
    error: result.error || null,
  };

  // In production, save to database or logging service
  logger.log(JSON.stringify(logEntry), "USAGE");
}

export default {
  bountyRegistry,
  detectMiniHackIntent,
  executeMiniHackBounty,
  getMinihackStatus,
  formatBountyOutput,
  testAllBounties,
  logBountyUsage,
};
