/**
 * Configuration for Trendjack Hunter
 * Contains API keys, endpoints, and polling settings
 */

export const config = {
  // API Keys (loaded from environment)
  twitter: {
    apiKey: process.env.TWITTER_API_KEY || "",
    apiSecret: process.env.TWITTER_API_SECRET || "",
    bearerToken: process.env.TWITTER_BEARER_TOKEN || "",
    accessToken: process.env.TWITTER_ACCESS_TOKEN || "",
    accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET || "",
  },
  
  reddit: {
    clientId: process.env.REDDIT_CLIENT_ID || "",
    clientSecret: process.env.REDDIT_CLIENT_SECRET || "",
    userAgent: process.env.REDDIT_USER_AGENT || "Trendjack-Hunter/1.0",
    username: process.env.REDDIT_USERNAME || "",
    password: process.env.REDDIT_PASSWORD || "",
  },
  
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY || "",
  },
  
  tiktok: {
    apiKey: process.env.TIKTOK_API_KEY || "",
    apiSecret: process.env.TIKTOK_API_SECRET || "",
  },
  
  instagram: {
    businessAccountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "",
    accessToken: process.env.INSTAGRAM_ACCESS_TOKEN || "",
  },
  
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4-turbo",
  },
  
  // Polling settings
  polling: {
    trendCheckIntervalMs: parseInt(process.env.TREND_CHECK_INTERVAL_MS || "300000"), // 5 min
    maxTrendLifespanHours: parseInt(process.env.MAX_TREND_LIFESPAN_HOURS || "72"),
    minTrendVelocity: parseInt(process.env.MIN_TREND_VELOCITY || "100"), // mentions in period
  },
  
  // Content brief generation
  contentBrief: {
    maxScriptWords: 60,
    minScriptWords: 30,
    includeRemixTemplate: true,
  },
  
  // Trend relevance filters (for Kuzana: entrepreneur, money, business, founder culture)
  relevanceKeywords: [
    "entrepreneur",
    "business",
    "startup",
    "founder",
    "revenue",
    "money",
    "side hustle",
    "passive income",
    "business growth",
    "market",
    "scaling",
    "pitch",
    "investment",
    "bootstrapping",
    "SME",
    "freelance",
    "ecommerce",
    "digital marketing",
    "Kenya",
    "Africa",
    "financial literacy",
    "wealth building",
    "career",
    "skill",
  ],
  
  // Excluded/filtered keywords (spam, unrelated)
  excludedKeywords: [
    "adult",
    "nsfw",
    "politics",
    "religion",
    "violent",
    "hate speech",
  ],
  
  // Platform-specific settings
  platforms: {
    twitter: {
      enabled: true,
      searchTerms: ["#entrepreneur", "#business", "#startup", "#sidehustle", "Kenya business"],
      trendingEndpoint: "https://api.twitter.com/2/trends/search",
      maxResults: 100,
    },
    tiktok: {
      enabled: true,
      searchTerms: ["entrepreneur", "business", "startup", "sidehustle"],
      maxResults: 50,
    },
    instagram: {
      enabled: true,
      searchTerms: ["entrepreneur", "business", "startup"],
      maxResults: 50,
    },
    youtube: {
      enabled: true,
      searchTerms: ["entrepreneur tips", "business growth", "side hustle", "startup"],
      maxResults: 20,
    },
    reddit: {
      enabled: true,
      subreddits: [
        "r/entrepreneurship",
        "r/startups",
        "r/business",
        "r/Kenya",
        "r/sidehustle",
        "r/digitalnomad",
      ],
      maxResults: 30,
    },
    kenyaNews: {
      enabled: true,
      sources: [
        "https://www.standardmedia.co.ke",
        "https://www.nation.co.ke",
        "https://techcrunch.com/tag/africa/",
        "https://thenextweb.com",
      ],
      maxResults: 20,
    },
  },
};

export default config;
