/**
 * Social media and news source adapters for Trendjack Hunter
 * Handles API calls to Twitter, TikTok, Reddit, YouTube, Instagram, Kenyan news
 */

import axios from "axios";
import config from "./config.js";

const logger = {
  log: (msg, level = "INFO") => console.log(`[${level}] ${msg}`),
};

/**
 * Twitter/X API - Get trending topics and relevant tweets
 */
export async function fetchTwitterTrends() {
  try {
    if (!config.twitter.bearerToken) {
      logger.log("Twitter API key not configured", "WARN");
      return { trends: [], tweets: [], error: null };
    }

    const headers = {
      Authorization: `Bearer ${config.twitter.bearerToken}`,
      "User-Agent": "Trendjack-Hunter/1.0",
    };

    // Fetch tweets with business/entrepreneur keywords
    const query = config.platforms.twitter.searchTerms.join(" OR ");
    const twitterResponse = await axios.get("https://api.twitter.com/2/tweets/search/recent", {
      headers,
      params: {
        query,
        max_results: 100,
        "tweet.fields": "public_metrics,created_at,author_id",
        expansions: "author_id",
        "user.fields": "username,followers_count",
      },
      timeout: 15000,
    });

    const tweets = (twitterResponse.data?.data || []).map((tweet) => ({
      platform: "twitter",
      id: tweet.id,
      text: tweet.text,
      createdAt: tweet.created_at,
      metrics: tweet.public_metrics,
      url: `https://twitter.com/i/web/status/${tweet.id}`,
    }));

    // Extract trending keywords from tweets
    const trends = extractTrendsFromTweets(tweets);

    return { trends, tweets, error: null };
  } catch (error) {
    logger.log(`Twitter fetch error: ${error.message}`, "ERROR");
    return { trends: [], tweets: [], error: error.message };
  }
}

/**
 * TikTok API - Get trending sounds and hashtags
 */
export async function fetchTikTokTrends() {
  try {
    if (!config.tiktok.apiKey) {
      logger.log("TikTok API key not configured", "WARN");
      return { trends: [], videos: [], error: null };
    }

    // Note: TikTok API is limited; using unofficial endpoint simulation
    const trendingHashtags = [
      "entrepreneur",
      "sidehustle",
      "businesstips",
      "startuplife",
      "moneytips",
      "kenyabusiness",
    ];

    const videos = [];
    for (const hashtag of trendingHashtags) {
      try {
        // Simulated endpoint - replace with actual TikTok API
        const response = await axios.get(
          `https://www.tiktok.com/api/v1/feed/?hashtag=${hashtag}`,
          { timeout: 10000 }
        );
        if (response.data?.items) {
          videos.push(
            ...response.data.items.map((item) => ({
              platform: "tiktok",
              id: item.id,
              text: item.desc,
              videoUrl: item.video.downloadAddr,
              createdAt: new Date(item.createTime * 1000).toISOString(),
              stats: { likes: item.stats.diggCount, shares: item.stats.shareCount },
              hashtag,
            }))
          );
        }
      } catch (err) {
        logger.log(`TikTok hashtag fetch failed for #${hashtag}: ${err.message}`, "WARN");
      }
    }

    const trends = extractTrendsFromTikTok(videos);
    return { trends, videos: videos.slice(0, 50), error: null };
  } catch (error) {
    logger.log(`TikTok fetch error: ${error.message}`, "ERROR");
    return { trends: [], videos: [], error: error.message };
  }
}

/**
 * Reddit API - Get trending posts from relevant subreddits
 */
export async function fetchRedditTrends() {
  try {
    if (!config.reddit.clientId) {
      logger.log("Reddit API credentials not configured", "WARN");
      return { trends: [], posts: [], error: null };
    }

    const posts = [];

    for (const subreddit of config.platforms.reddit.subreddits) {
      try {
        const subredditName = subreddit.replace("r/", "");
        const response = await axios.get(
          `https://www.reddit.com/r/${subredditName}/hot.json`,
          {
            headers: { "User-Agent": config.reddit.userAgent },
            params: { limit: 25 },
            timeout: 10000,
          }
        );

        if (response.data?.data?.children) {
          posts.push(
            ...response.data.data.children
              .map((child) => child.data)
              .map((post) => ({
                platform: "reddit",
                id: post.id,
                title: post.title,
                text: post.selftext,
                subreddit: post.subreddit,
                createdAt: new Date(post.created_utc * 1000).toISOString(),
                stats: {
                  upvotes: post.ups,
                  comments: post.num_comments,
                },
                url: `https://reddit.com${post.permalink}`,
              }))
          );
        }
      } catch (err) {
        logger.log(`Reddit fetch failed for ${subreddit}: ${err.message}`, "WARN");
      }
    }

    const trends = extractTrendsFromReddit(posts);
    return { trends, posts: posts.slice(0, config.platforms.reddit.maxResults), error: null };
  } catch (error) {
    logger.log(`Reddit fetch error: ${error.message}`, "ERROR");
    return { trends: [], posts: [], error: error.message };
  }
}

/**
 * YouTube API - Get trending videos in Business category
 */
export async function fetchYouTubeTrends() {
  try {
    if (!config.youtube.apiKey) {
      logger.log("YouTube API key not configured", "WARN");
      return { trends: [], videos: [], error: null };
    }

    const videos = [];
    for (const searchTerm of config.platforms.youtube.searchTerms) {
      try {
        const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
          params: {
            part: "snippet",
            q: searchTerm,
            key: config.youtube.apiKey,
            maxResults: 10,
            type: "video",
            order: "viewCount",
            publishedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          },
          timeout: 10000,
        });

        if (response.data?.items) {
          videos.push(
            ...response.data.items.map((item) => ({
              platform: "youtube",
              id: item.id.videoId,
              title: item.snippet.title,
              description: item.snippet.description,
              channelTitle: item.snippet.channelTitle,
              publishedAt: item.snippet.publishedAt,
              thumbnail: item.snippet.thumbnails.default.url,
              url: `https://youtu.be/${item.id.videoId}`,
              searchTerm,
            }))
          );
        }
      } catch (err) {
        logger.log(`YouTube fetch failed for "${searchTerm}": ${err.message}`, "WARN");
      }
    }

    const trends = extractTrendsFromYouTube(videos);
    return { trends, videos: videos.slice(0, config.platforms.youtube.maxResults), error: null };
  } catch (error) {
    logger.log(`YouTube fetch error: ${error.message}`, "ERROR");
    return { trends: [], videos: [], error: error.message };
  }
}

/**
 * Kenyan News Sources - Scrape business/startup news
 */
export async function fetchKenyaNews() {
  try {
    const articles = [];

    for (const source of config.platforms.kenyaNews.sources) {
      try {
        // Note: This would require proper web scraping setup with cheerio or similar
        // For now, using a placeholder that would integrate with RSS or API endpoints
        const response = await axios.get(source, {
          timeout: 15000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        });

        // Parse HTML or JSON response
        // This is a simplified version; in production, use a proper HTML parser
        articles.push({
          platform: "news",
          source,
          title: "Sample news article",
          url: source,
          publishedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.log(`News fetch failed for ${source}: ${err.message}`, "WARN");
      }
    }

    const trends = extractTrendsFromNews(articles);
    return { trends, articles: articles.slice(0, config.platforms.kenyaNews.maxResults), error: null };
  } catch (error) {
    logger.log(`Kenya news fetch error: ${error.message}`, "ERROR");
    return { trends: [], articles: [], error: error.message };
  }
}

// ===== HELPER FUNCTIONS TO EXTRACT TRENDS =====

function extractTrendsFromTweets(tweets) {
  const trends = {};
  for (const tweet of tweets) {
    const hashtags = (tweet.text.match(/#\w+/g) || []).map((h) => h.toLowerCase());
    const mentions = (tweet.text.match(/@\w+/g) || []).map((m) => m.toLowerCase());
    const keywords = extractKeywords(tweet.text);

    for (const tag of hashtags) {
      trends[tag] = (trends[tag] || 0) + tweet.metrics.like_count + tweet.metrics.retweet_count;
    }

    for (const kw of keywords) {
      trends[kw] = (trends[kw] || 0) + tweet.metrics.like_count;
    }
  }

  return Object.entries(trends)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([trend, score]) => ({ trend, score, platform: "twitter" }));
}

function extractTrendsFromTikTok(videos) {
  const trends = {};
  for (const video of videos) {
    const hashtags = (video.text.match(/#\w+/g) || []).map((h) => h.toLowerCase());
    const keywords = extractKeywords(video.text);

    for (const tag of hashtags) {
      trends[tag] = (trends[tag] || 0) + video.stats.likes + video.stats.shares;
    }
    for (const kw of keywords) {
      trends[kw] = (trends[kw] || 0) + video.stats.likes;
    }
  }

  return Object.entries(trends)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([trend, score]) => ({ trend, score, platform: "tiktok" }));
}

function extractTrendsFromReddit(posts) {
  const trends = {};
  for (const post of posts) {
    const keywords = extractKeywords(post.title + " " + post.text);
    const score = post.stats.upvotes + post.stats.comments * 2;

    for (const kw of keywords) {
      trends[kw] = (trends[kw] || 0) + score;
    }
  }

  return Object.entries(trends)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([trend, score]) => ({ trend, score, platform: "reddit" }));
}

function extractTrendsFromYouTube(videos) {
  const trends = {};
  for (const video of videos) {
    const keywords = extractKeywords(video.title + " " + video.description);

    for (const kw of keywords) {
      trends[kw] = (trends[kw] || 0) + 100; // YouTube content = higher baseline
    }
  }

  return Object.entries(trends)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([trend, score]) => ({ trend, score, platform: "youtube" }));
}

function extractTrendsFromNews(articles) {
  const trends = {};
  for (const article of articles) {
    const keywords = extractKeywords(article.title);

    for (const kw of keywords) {
      trends[kw] = (trends[kw] || 0) + 50;
    }
  }

  return Object.entries(trends)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([trend, score]) => ({ trend, score, platform: "news" }));
}

function extractKeywords(text) {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "is",
    "was",
  ]);
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  return [...new Set(words)].slice(0, 10);
}

export default {
  fetchTwitterTrends,
  fetchTikTokTrends,
  fetchRedditTrends,
  fetchYouTubeTrends,
  fetchKenyaNews,
};
