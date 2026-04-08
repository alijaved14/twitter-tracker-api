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

  console.log('🔄 Background Worker: Fetching 10-seconds-ago alpha...');
  try {
    // ─── THE CREATEMEME ALPHA QUERY ───
    // We stop using massive 'from:' lists which crash the search engine.
    // Instead, we search for the exact topics that drive the market, 
    // restrict it to verified accounts to kill spam, and use SearchMode.Latest.
    const queries = [
      '(crypto OR $SOL OR memecoin OR pump.fun OR dexscreener) filter:verified -filter:replies',
      '(AI OR OpenAI OR ChatGPT OR SpaceX OR robotics) filter:verified -filter:replies',
      '(breaking OR alert OR "just in" OR ceasefire OR war) filter:verified filter:media -filter:replies'
    ];

    const allTweets = [];
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600; // STRICT 10-minute cutoff

    for (const query of queries) {
      try {
        for await (const tweet of scraper.searchTweets(query, 15, SearchMode.Latest)) {
          const tweetTime = tweet.timestamp || (tweet.timeParsed ? Math.floor(tweet.timeParsed.getTime() / 1000) : 0);
          
          // HARD STOP: If a tweet is older than 10 minutes, kill the loop immediately.
          if (tweetTime > 0 && tweetTime < tenMinutesAgo) {
            break; 
          }
          
          allTweets.push(formatTweet(tweet));
        }
      } catch (err) {
        console.error(`[Firehose] Error on query [${query}]:`, err.message);
      }
    }

    // Deduplicate
    const uniqueTweets = Array.from(new Map(allTweets.map(t => [t.id, t])).values());
    
    // Sort strictly by absolute newest first
    uniqueTweets.sort((a, b) => {
      const timeA = a.timestamp || (a.timeParsed ? Math.floor(a.timeParsed.getTime() / 1000) : 0);
      const timeB = b.timestamp || (b.timeParsed ? Math.floor(b.timeParsed.getTime() / 1000) : 0);
      return timeB - timeA;
    });

    // Final safety net: Strip anything that somehow bypassed the time check
    const ultraFreshTweets = uniqueTweets.filter(t => {
      const tTime = t.timestamp || (t.timeParsed ? Math.floor(t.timeParsed.getTime() / 1000) : 0);
      return tTime >= tenMinutesAgo;
    });
    
    // Save the finalized data to the global variable
    if (ultraFreshTweets.length > 0) {
        instantFirehoseData = await enrichTweets(ultraFreshTweets);
        console.log(`✅ Background Worker: Saved ${instantFirehoseData.length} tweets from the last 10 minutes.`);
    } else {
        console.log(`⚠️ Background Worker: No tweets found in the last 10 minutes. Keeping previous cache.`);
    }
  } catch (err) {
    console.error('❌ Background Worker Error:', err.message);
  }
}
/**
 * The Curated Alpha Firehose (MEDIA ONLY)
 * NOW INSTANT: Returns the pre-fetched data from the background worker in 1 millisecond.
 */
export async function getLiveFirehose(count = 30) {
  // Return the data instantly, no waiting for Twitter!
  return instantFirehoseData.slice(0, count);
}

// ─── Cache maintenance ────────────────────────────────────────────────────────
setInterval(() => {
  profileCache.cleanup();
  tweetCache.cleanup();
  trendsCache.cleanup();
}, 5 * 60_000);
