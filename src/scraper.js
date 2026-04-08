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

// 🔥 Global memory cache for instant responses
let instantFirehoseData = [];

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
        
        // 🔥 START THE BACKGROUND WORKER HERE 🔥
        runBackgroundFirehose();
        setInterval(runBackgroundFirehose, 30_000); // Polls Twitter every 30 seconds
        
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

// ─── LIVE FIREHOSE BACKGROUND WORKER ──────────────────────────────────────────

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

// This runs silently in the background so the user never has to wait.
async function runBackgroundFirehose() {
  if (!ready) return;

  console.log('🔄 Background Worker: Fetching live feed...');
  try {
    // Broad, high-volume queries. NO filter:verified (too restrictive),
    // NO filter:media, NO strict time cutoff. Just recent tweets from
    // high-activity topics.
    // Removed lang:en — some scraper builds don't support it and silently return 0.
    const queries = [
      '(crypto OR bitcoin OR $SOL OR memecoin OR ethereum OR solana) -filter:replies',
      '(AI OR OpenAI OR ChatGPT OR elon OR SpaceX) -filter:replies',
      '(breaking OR "just in" OR news) -filter:replies',
    ];

    const allTweets = [];
    // 1-hour soft cutoff (relaxed from 10 min). Tweets older than this are dropped,
    // but the loop does NOT break early on them — it keeps looking for newer ones.
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

    const results = await Promise.allSettled(
      queries.map(async (query) => {
        const out = [];
        try {
          let iterated = 0;
          for await (const tweet of scraper.searchTweets(query, 25, SearchMode.Latest)) {
            iterated++;
            if (iterated > 25) break; // safety
            out.push(formatTweet(tweet));
          }
          console.log(`  ↳ [${query.slice(0, 40)}...] fetched ${out.length} tweets`);
        } catch (err) {
          console.error(`[Firehose] Error on query [${query.slice(0, 40)}]:`, err.message);
        }
        return out;
      })
    );

    results
      .filter(r => r.status === 'fulfilled')
      .forEach(r => allTweets.push(...r.value));

    // Deduplicate by id
    const uniqueTweets = Array.from(
      new Map(allTweets.filter(t => t && t.id).map(t => [t.id, t])).values()
    );

    // Prefer fresh (< 1 hour) but fall back to whatever we have if fresh is empty
    const freshTweets = uniqueTweets.filter(t => {
      const tTime = t.timestamp || (t.timeParsed ? Math.floor(new Date(t.timeParsed).getTime() / 1000) : 0);
      return tTime >= oneHourAgo;
    });

    const finalTweets = freshTweets.length > 0 ? freshTweets : uniqueTweets;

    // Sort newest first
    finalTweets.sort((a, b) => {
      const timeA = a.timestamp || (a.timeParsed ? Math.floor(new Date(a.timeParsed).getTime() / 1000) : 0);
      const timeB = b.timestamp || (b.timeParsed ? Math.floor(new Date(b.timeParsed).getTime() / 1000) : 0);
      return timeB - timeA;
    });

    if (finalTweets.length > 0) {
      instantFirehoseData = await enrichTweets(finalTweets.slice(0, 100));
      console.log(`✅ Background Worker: Saved ${instantFirehoseData.length} tweets (${freshTweets.length} fresh < 1h).`);
    } else {
      console.warn('⚠️ Background Worker: ALL queries returned 0 tweets. Twitter auth may be broken.');
    }
  } catch (err) {
    console.error('❌ Background Worker Error:', err.message, err.stack);
  }
}
/**
 * Live firehose — returns recent tweets across all topics.
 * If background worker has populated the cache, returns instantly.
 * Otherwise does a SYNCHRONOUS fallback search so the endpoint never returns empty.
 */
export async function getLiveFirehose(count = 30) {
  // Fast path: background worker has data
  if (instantFirehoseData.length > 0) {
    return instantFirehoseData.slice(0, count);
  }

  // Fallback: do a live search directly. This guarantees we return data
  // even on the very first request before the background worker finishes.
  console.log('⚡ getLiveFirehose: cache empty, doing live fallback search...');

  const fallbackQueries = [
    '(crypto OR bitcoin OR solana OR memecoin) -filter:replies',
    '(breaking OR news OR AI) -filter:replies',
  ];

  const collected = [];
  for (const q of fallbackQueries) {
    try {
      let n = 0;
      for await (const tweet of scraper.searchTweets(q, 20, SearchMode.Latest)) {
        collected.push(formatTweet(tweet));
        if (++n >= 20) break;
      }
    } catch (err) {
      console.error(`[getLiveFirehose fallback] query [${q}] failed:`, err.message);
    }
    if (collected.length >= count) break;
  }

  // Deduplicate
  const unique = Array.from(
    new Map(collected.filter(t => t && t.id).map(t => [t.id, t])).values()
  );

  unique.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const enriched = await enrichTweets(unique.slice(0, count));

  // Populate the cache so next call is instant
  if (enriched.length > 0) {
    instantFirehoseData = enriched;
    console.log(`⚡ Fallback saved ${enriched.length} tweets to cache.`);
  }

  return enriched;
}

/**
 * Debug: returns the current state of the firehose cache.
 */
export function getFirehoseStatus() {
  return {
    cacheSize: instantFirehoseData.length,
    ready,
    sampleIds: instantFirehoseData.slice(0, 3).map(t => t.id),
    latestTimestamp: instantFirehoseData[0]?.timestamp || null,
  };
}

// ─── Cache maintenance ────────────────────────────────────────────────────────
setInterval(() => {
  profileCache.cleanup();
  tweetCache.cleanup();
  trendsCache.cleanup();
}, 5 * 60_000);
