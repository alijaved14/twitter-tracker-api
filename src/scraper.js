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
  // The scraper library uses a few different field names depending on version
  // (likes/likeCount/favoriteCount, views/viewCount, etc). Try them all.
  const likes =
    tweet.likes ?? tweet.likeCount ?? tweet.favoriteCount ?? tweet.favorite_count ?? 0;
  const retweets =
    tweet.retweets ?? tweet.retweetCount ?? tweet.retweet_count ?? 0;
  const replies =
    tweet.replies ?? tweet.replyCount ?? tweet.reply_count ?? 0;
  const views =
    tweet.views ?? tweet.viewCount ?? tweet.view_count ?? 0;

  // Some scraper versions embed user/author data directly on the tweet object
  const embeddedUser = tweet.user || tweet.author || tweet.core?.user_results?.result?.legacy || {};
  const embeddedAvatar =
    embeddedUser.profile_image_url_https ||
    embeddedUser.profile_image_url ||
    embeddedUser.avatar ||
    tweet.profileImageUrl ||
    tweet.avatar ||
    null;
  const embeddedName =
    embeddedUser.name ||
    tweet.name ||
    tweet.displayName ||
    tweet.username ||
    '';
  const embeddedFollowers =
    embeddedUser.followers_count ??
    embeddedUser.followersCount ??
    tweet.followersCount ??
    0;
  const embeddedVerified =
    embeddedUser.verified ||
    embeddedUser.is_blue_verified ||
    tweet.isBlueVerified ||
    tweet.isVerified ||
    false;

  return {
    id:           tweet.id            || tweet.id_str || tweet.rest_id || null,
    text:         tweet.text          || tweet.full_text || '',
    username:     tweet.username      || embeddedUser.screen_name || '',
    timestamp:    tweet.timestamp     || (tweet.timeParsed ? Math.floor(new Date(tweet.timeParsed).getTime() / 1000) : null),
    timeParsed:   tweet.timeParsed    || null,
    likes,
    retweets,
    replies,
    views,
    photos:       tweet.photos        || [],
    videos:       tweet.videos        || [],
    permanentUrl: tweet.permanentUrl  || (tweet.id ? `https://x.com/${tweet.username}/status/${tweet.id}` : null),
    isRetweet:    tweet.isRetweet     || false,
    isReply:      tweet.isReply       || false,
    // Pre-populate from embedded user if present — enrichment will overwrite later
    profileImage:   embeddedAvatar,
    displayName:    embeddedName,
    followersCount: embeddedFollowers,
    isVerified:     embeddedVerified,
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

/**
 * Batched enrichment — fetches profiles 5 at a time instead of all at once,
 * with a per-profile timeout. Used by the background firehose to avoid
 * rate-limit hangs on large batches.
 */
async function enrichTweetsBatched(tweets, batchSize = 5) {
  const usernames = [...new Set(tweets.map(t => t.username).filter(Boolean))];
  const profileMap = {};

  const fetchOne = (u) =>
    Promise.race([
      getProfile(u),
      new Promise((_, reject) => setTimeout(() => reject(new Error('profile timeout')), 4_000)),
    ]);

  for (let i = 0; i < usernames.length; i += batchSize) {
    const batch = usernames.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(fetchOne));
    batch.forEach((u, idx) => {
      if (results[idx].status === 'fulfilled') {
        profileMap[u.toLowerCase()] = results[idx].value;
      }
    });
  }

  return tweets.map(tweet => {
    const p = profileMap[tweet.username?.toLowerCase()] || {};
    return {
      ...tweet,
      profileImage:   p.avatar         || tweet.profileImage || null,
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

// Prevents overlapping background worker runs (if previous run hangs, skip new one)
let backgroundRunning = false;

// This runs silently in the background so the user never has to wait.
async function runBackgroundFirehose() {
  if (!ready) return;
  if (backgroundRunning) {
    console.log('⏭  Background Worker: previous run still in progress, skipping.');
    return;
  }
  backgroundRunning = true;

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

    // Back to Latest — Top mode hangs in this scraper version
    const results = await Promise.allSettled(
      queries.map(async (query) => {
        const out = [];
        try {
          let iterated = 0;
          for await (const tweet of scraper.searchTweets(query, 25, SearchMode.Latest)) {
            iterated++;
            if (iterated > 25) break;
            out.push(formatTweet(tweet));
          }
          const withLikes = out.filter(t => t.likes > 0).length;
          const withViews = out.filter(t => t.views > 0).length;
          console.log(`  ↳ [${query.slice(0, 40)}...] fetched ${out.length} (${withLikes}L ${withViews}V)`);
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
      const capped = finalTweets.slice(0, 60); // 60 is enough, keeps enrichment fast

      // Save raw immediately so /api/live never returns empty even if enrichment hangs
      instantFirehoseData = capped;
      console.log(`✅ Background Worker: Saved ${capped.length} raw tweets. Enriching...`);

      // Now wait (with timeout) for enrichment so the cache has profile data
      try {
        const enriched = await Promise.race([
          enrichTweetsBatched(capped),
          new Promise((_, reject) => setTimeout(() => reject(new Error('enrich timeout')), 20_000)),
        ]);
        if (Array.isArray(enriched) && enriched.length > 0) {
          instantFirehoseData = enriched;
          const withAvatars = enriched.filter(t => t.profileImage).length;
          console.log(`🎨 Enriched ${enriched.length} tweets (${withAvatars} with avatars).`);
        }
      } catch (e) {
        console.warn(`⚠️ Enrichment failed/timed out: ${e.message} — keeping raw tweets.`);
      }
    } else {
      console.warn('⚠️ Background Worker: ALL queries returned 0 tweets. Twitter auth may be broken.');
    }
  } catch (err) {
    console.error('❌ Background Worker Error:', err.message, err.stack);
  } finally {
    backgroundRunning = false;
  }
}
/**
 * Live firehose — returns recent tweets across all topics.
 * If background worker has populated the cache, returns instantly.
 * Otherwise a SINGLE-FLIGHT fallback search runs so 20 concurrent
 * requests don't trigger 20 concurrent Twitter searches (which hang).
 */
let fallbackInFlight = null;

export async function getLiveFirehose(count = 30) {
  // Fast path: background worker (or previous fallback) has populated cache
  if (instantFirehoseData.length > 0) {
    return instantFirehoseData.slice(0, count);
  }

  // Single-flight: if a fallback is already running, await it instead of starting a new one
  if (fallbackInFlight) {
    await fallbackInFlight;
    return instantFirehoseData.slice(0, count);
  }

  console.log('⚡ getLiveFirehose: cache empty, running ONE fallback search (single-flight)...');

  fallbackInFlight = (async () => {
    try {
      const q = '(crypto OR bitcoin OR solana OR news OR AI) -filter:replies';
      const collected = [];

      try {
        let n = 0;
        for await (const tweet of scraper.searchTweets(q, 40, SearchMode.Latest)) {
          collected.push(formatTweet(tweet));
          if (++n >= 40) break;
        }
      } catch (err) {
        console.error(`[fallback search] failed:`, err.message);
      }

      const unique = Array.from(
        new Map(collected.filter(t => t && t.id).map(t => [t.id, t])).values()
      );
      unique.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      if (unique.length > 0) {
        instantFirehoseData = unique;
        console.log(`⚡ Fallback saved ${unique.length} raw tweets. Enriching...`);

        try {
          const enriched = await Promise.race([
            enrichTweetsBatched(unique),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20_000)),
          ]);
          if (Array.isArray(enriched) && enriched.length > 0) {
            instantFirehoseData = enriched;
            console.log(`🎨 Fallback enriched ${enriched.length} tweets.`);
          }
        } catch (e) {
          console.warn(`[fallback enrichment] skipped: ${e.message}`);
        }
      } else {
        console.warn('⚡ Fallback returned 0 tweets.');
      }
    } finally {
      fallbackInFlight = null;
    }
  })();

  await fallbackInFlight;
  return instantFirehoseData.slice(0, count);
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
