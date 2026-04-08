/**
 * Twitter scraper singleton.
 */

import { Scraper, SearchMode } from '@the-convocation/twitter-scraper';
import { Cookie } from 'tough-cookie';
import { TTLCache } from './cache.js';

// ─── Caches ──────────────────────────────────────────────────────────────────
const profileCache = new TTLCache();   
const tweetCache   = new TTLCache();   
const trendsCache  = new TTLCache();

const TWEET_CACHE_TTL   = 30_000;      // 30 s
const PROFILE_CACHE_TTL = 10 * 60_000; // 10 min
const TRENDS_CACHE_TTL  = 5 * 60_000;  // 5 min

// ─── Scraper state ───────────────────────────────────────────────────────────
let scraper     = null;
let ready       = false;
let initPromise = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseCookieString(raw) {
  return raw.split(';').map(s => Cookie.parse(s.trim())).filter(Boolean);
}

// ─── Init / Auth ─────────────────────────────────────────────────────────────

export async function initScraper() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    scraper = new Scraper();
    const cookieEnv = process.env.TWITTER_COOKIES;

    if (!cookieEnv || !cookieEnv.trim()) {
      console.error('❌ TWITTER_COOKIES env var is not set.');
      return;
    }

    try {
      let cookiesToSet;
      try {
        const decoded = Buffer.from(cookieEnv.trim(), 'base64').toString('utf8');
        const arr     = JSON.parse(decoded);
        if (Array.isArray(arr)) {
          cookiesToSet = arr.map(c => Cookie.parse(c)).filter(Boolean);
          console.log('🍪 Loaded cookies from base64 JSON format');
        } else {
          throw new Error('not an array');
        }
      } catch {
        cookiesToSet = parseCookieString(cookieEnv.trim());
        console.log('🍪 Loaded cookies from plain string format');
      }

      if (!cookiesToSet.length) {
        throw new Error('No valid cookies could be parsed from TWITTER_COOKIES');
      }

      await scraper.setCookies(cookiesToSet);
      ready = await scraper.isLoggedIn();

      if (ready) {
        console.log('✅ Twitter session active — scraper is ready');
      } else {
        console.error('❌ Cookies loaded but session is invalid.');
      }
    } catch (err) {
      console.error('❌ Failed to load cookies:', err.message);
    }
  })();

  return initPromise;
}

export const isReady = () => ready;

// ─── Profile ─────────────────────────────────────────────────────────────────

export async function getProfile(username) {
  const key    = `profile:${username.toLowerCase()}`;
  const cached = profileCache.get(key);
  if (cached) return cached;

  const p = await scraper.getProfile(username);
  const formatted = {
    username:       p.username   || username,
    name:           p.name       || username,
    avatar:         p.avatar     || null,
    followersCount: p.followersCount ?? 0,
    isVerified:     p.isBlueVerified || p.isVerified || false,
  };

  profileCache.set(key, formatted, PROFILE_CACHE_TTL);
  return formatted;
}

// ─── Tweet helpers ────────────────────────────────────────────────────────────

function formatTweet(tweet) {
  return {
    id:           tweet.id            || null,
    text:         tweet.text          || '',
    username:     tweet.username      || '',
    timestamp:    tweet.timestamp     || (tweet.timeParsed ? Math.floor(tweet.timeParsed.getTime() / 1000) : null),
    timeParsed:   tweet.timeParsed    || null,
    likes:        tweet.likes         ?? 0,
    retweets:     tweet.retweets      ?? 0,
    replies:      tweet.replies       ?? 0,
    views:        tweet.views         ?? 0,
    photos:       tweet.photos        || [],
    videos:       tweet.videos        || [],
    permanentUrl: tweet.permanentUrl  || (tweet.id ? `https://x.com/${tweet.username}/status/${tweet.id}` : null),
    isRetweet:    tweet.isRetweet     || false,
    isReply:      tweet.isReply       || false,
    profileImage:  null,
    displayName:   tweet.username || '',
    followersCount: 0,
    isVerified:    false,
  };
}

async function enrichTweets(tweets) {
  const usernames = [...new Set(tweets.map(t => t.username).filter(Boolean))];
  const results = await Promise.allSettled(usernames.map(u => getProfile(u)));

  const profileMap = {};
  usernames.forEach((u, i) => {
    if (results[i].status === 'fulfilled') {
      profileMap[u.toLowerCase()] = results[i].value;
    }
  });

  return tweets.map(tweet => {
    const p = profileMap[tweet.username?.toLowerCase()] || {};
    return {
      ...tweet,
      profileImage:   p.avatar         || null,
      displayName:    p.name           || tweet.username,
      followersCount: p.followersCount ?? 0,
      isVerified:     p.isVerified     || false,
    };
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function searchTweets(query, count = 20, mode = 'latest') {
  const cacheKey = `search:${query}:${count}:${mode}`;
  const cached   = tweetCache.get(cacheKey);
  if (cached) return cached;

  const searchMode = mode === 'top' ? SearchMode.Top : SearchMode.Latest;
  const tweets     = [];

  for await (const tweet of scraper.searchTweets(query, count, searchMode)) {
    tweets.push(formatTweet(tweet));
    if (tweets.length >= count) break;
  }

  const enriched = await enrichTweets(tweets);
  tweetCache.set(cacheKey, enriched, TWEET_CACHE_TTL);
  return enriched;
}

export async function getUserTweets(username, count = 20) {
  const cacheKey = `user:${username.toLowerCase()}:${count}`;
  const cached   = tweetCache.get(cacheKey);
  if (cached) return cached;

  const tweets = [];
  for await (const tweet of scraper.getTweets(username, count)) {
    tweets.push(formatTweet(tweet));
    if (tweets.length >= count) break;
  }

  const enriched = await enrichTweets(tweets);
  tweetCache.set(cacheKey, enriched, TWEET_CACHE_TTL);
  return enriched;
}

export async function getMultiAccountFeed(accounts, perAccount = 5) {
  const cacheKey = `feed:${accounts.join(',')}:${perAccount}`;
  const cached   = tweetCache.get(cacheKey);
  if (cached) return cached;

  const results = await Promise.allSettled(accounts.map(a => getUserTweets(a, perAccount)));

  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  tweetCache.set(cacheKey, all, TWEET_CACHE_TTL);
  return all;
}

export async function getTrends() {
  const cached = trendsCache.get('trends');
  if (cached) return cached;

  const trends = await scraper.getTrends();
  trendsCache.set('trends', trends, TRENDS_CACHE_TTL);
  return trends;
}

export async function getTrendingTweets(trendCount = 20, tweetsPerTrend = 3, mode = 'top') {
  const cacheKey = `trending:${trendCount}:${tweetsPerTrend}:${mode}`;
  const cached   = tweetCache.get(cacheKey);
  if (cached) return cached;

  const trends    = await getTrends();
  const topTrends = trends.slice(0, trendCount);
  const searchMode = mode === 'top' ? SearchMode.Top : SearchMode.Latest;

  const BATCH = 5;
  const all   = [];
  for (let i = 0; i < topTrends.length; i += BATCH) {
    const batch   = topTrends.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (trend) => {
        const tweets = [];
        for await (const tweet of scraper.searchTweets(trend, tweetsPerTrend, searchMode)) {
          tweets.push({ ...formatTweet(tweet), trend });
          if (tweets.length >= tweetsPerTrend) break;
        }
        return tweets;
      })
    );
    results.filter(r => r.status === 'fulfilled').forEach(r => all.push(...r.value));
  }

  all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const enriched  = await enrichTweets(all);
  const withTrend = enriched.map((t, i) => ({ ...t, trend: all[i]?.trend || '' }));

  tweetCache.set(cacheKey, withTrend, TRENDS_CACHE_TTL);
  return withTrend;
}

// ─── LIVE FIREHOSE ────────────────────────────────────────────────────────────

// The Pro-Tier Alpha List (DECLARED ONLY ONCE HERE)
const FIREHOSE_SOURCES = [
  "tier10k", "FirstSquawk", "unusual_whales", "WatcherGuru", "lookonchain",
  "Reuters", "BBCWorld", "aljazeeraenglish", "business", "Bloomberg", 
  "TimesNow", "TheBlock__", "CoinDesk", "WuBlockchain",
  "BitcoinNews", "cz_binance", "VitalikButerin", "Saylor", 
  "brian_armstrong", "nayibbukele",
  "EricBalchunas", "APompliano", "RaoulGMI", "novogratz", "Pentosh1",
  "ArkhamIntel", "nansen_ai", "glassnode", "CryptoQuant_com",
  "zerohedge", "db_news",
  "elonmusk", "sama", "pmarca", "naval", "levelsio", "paulg",
  "DrewPavlou", "dom_lucre", "wholemars", "BoredElonMusk",
  "fityeth", "Tezzo100x", "thuggies_sol"
];

/**
 * The Curated Alpha Firehose (MEDIA ONLY)
 */
export async function getLiveFirehose(count = 30) {
  const cacheKey = `live:firehose:curated_media:${count}`;
  const cached   = tweetCache.get(cacheKey);
  if (cached) return cached;

  const uniqueSources = [...new Set(FIREHOSE_SOURCES)];
  const chunkSize = 10;
  const batches = [];
  for (let i = 0; i < uniqueSources.length; i += chunkSize) {
    batches.push(uniqueSources.slice(i, i + chunkSize));
  }

  const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
  const allTweets = [];

  for (const batch of batches) {
    const fromQuery = batch.map(user => `from:${user}`).join(' OR ');
    const query = `(${fromQuery}) filter:media -filter:replies`;

    try {
      for await (const tweet of scraper.searchTweets(query, 20, SearchMode.Latest)) {
        if (tweet.timestamp && tweet.timestamp < oneHourAgo) {
          break; 
        }
        allTweets.push(formatTweet(tweet));
      }
    } catch (err) {
      console.error(`[Firehose] Batch error for query [${query}]:`, err.message);
    }
  }

  const uniqueTweets = Array.from(new Map(allTweets.map(t => [t.id, t])).values());
  uniqueTweets.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const lastHourTweets = uniqueTweets.filter(t => t.timestamp && t.timestamp >= oneHourAgo);
  const finalTweets = lastHourTweets.slice(0, count);
  const enriched = await enrichTweets(finalTweets);
  
  tweetCache.set(cacheKey, enriched, 15_000); 
  return enriched;
}

// ─── Cache maintenance ────────────────────────────────────────────────────────
setInterval(() => {
  profileCache.cleanup();
  tweetCache.cleanup();
  trendsCache.cleanup();
}, 5 * 60_000);
