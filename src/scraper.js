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

const TWEET_CACHE_TTL   = 30_000;              // 30 seconds
const PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const TRENDS_CACHE_TTL  = 5 * 60_000;          // 5 minutes

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

// ─── Syndication API Helpers (No Auth / High Limits) ─────────────────────────
function getSyndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

async function fetchSyndicationProfile(tweetId) {
  try {
    const token = getSyndicationToken(tweetId);
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}`;
    
    // fetch from Twitter's public CDN — completely bypasses auth and IP bans
    const res = await fetch(url);
    if (!res.ok) return null;
    
    const data = await res.json();
    const user = data.user;
    if (!user) return null;

    return {
      username: user.screen_name,
      name: user.name,
      avatar: user.profile_image_url_https?.replace('_normal', ''),
      followersCount: user.followers_count || 0,
      isVerified: user.is_blue_verified || user.verified || false,
    };
  } catch (err) {
    return null;
  }
}

// ─── Init / Auth ─────────────────────────────────────────────────────────────

export async function initScraper() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    scraper = new Scraper();
    const cookieEnv = process.env.TWITTER_COOKIES;

    try {
      if (!cookieEnv || !cookieEnv.trim()) {
        console.warn('⚠️ TWITTER_COOKIES env var is not set. Attempting fresh login...');
        
        if (!process.env.TWITTER_USERNAME || !process.env.TWITTER_PASSWORD) {
          throw new Error('TWITTER_USERNAME and TWITTER_PASSWORD must be set if cookies are empty.');
        }

        await scraper.login(
          process.env.TWITTER_USERNAME,
          process.env.TWITTER_PASSWORD,
          process.env.TWITTER_EMAIL
        );
        
        const cookies = await scraper.getCookies();
        const cookieStrings = cookies.map(c => c.toString());
        const base64Cookies = Buffer.from(JSON.stringify(cookieStrings)).toString('base64');
        
        console.log('\n========================================================================');
        console.log('✅ FRESH LOGIN SUCCESSFUL!');
        console.log('🚨 Copy the string below and paste it into TWITTER_COOKIES in Render:');
        console.log('\n' + base64Cookies + '\n');
        console.log('========================================================================\n');
        
        ready = await scraper.isLoggedIn();
      } else {
        // Load existing cookies
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
      }

      if (ready) {
        console.log('✅ Twitter session active — scraper is ready');
        runBackgroundFirehose();
        setInterval(runBackgroundFirehose, 60_000); 
      } else {
        console.error('❌ Authentication failed. Session is invalid.');
      }
    } catch (err) {
      console.error('❌ Init Error:', err.message);
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

  try {
    // 1. Try standard scraper first
    const res = await scraper.getProfile(username);
    const p = res?.value || res; // Handle library wrapper if present
    
    if (p && p.username) {
      const formatted = {
        username:       p.username,
        name:           p.name,
        avatar:         p.avatar,
        followersCount: p.followersCount || 0,
        isVerified:     p.isBlueVerified || p.isVerified || false,
      };
      profileCache.set(key, formatted, PROFILE_CACHE_TTL);
      return formatted;
    }
  } catch (err) {
    console.warn(`[getProfile] Scraper failed for ${username}, trying syndication fallback...`);
  }

  // 2. Fallback: Grab their latest tweet and extract profile via Syndication
  try {
    const tweetsIter = scraper.getTweets(username, 1);
    for await (const tweet of tweetsIter) {
      if (tweet.id) {
        const profile = await fetchSyndicationProfile(tweet.id);
        if (profile) {
           profileCache.set(key, profile, PROFILE_CACHE_TTL);
           return profile;
        }
      }
    }
  } catch (e) {
     // Ignore
  }

  throw new Error(`Profile fetch failed for ${username}`);
}

// ─── Tweet helpers ────────────────────────────────────────────────────────────

function formatTweet(tweet) {
  const likes = tweet.likes ?? tweet.likeCount ?? tweet.favoriteCount ?? tweet.favorite_count ?? 0;
  const retweets = tweet.retweets ?? tweet.retweetCount ?? tweet.retweet_count ?? 0;
  const replies = tweet.replies ?? tweet.replyCount ?? tweet.reply_count ?? 0;
  const views = tweet.views ?? tweet.viewCount ?? tweet.view_count ?? 0;

  const user = tweet.user || tweet.author || {};
  const legacy = tweet.core?.user_results?.result?.legacy || user.legacy || {};
  const result = tweet.core?.user_results?.result || user.result || {};

  const username = tweet.username || user.screen_name || legacy.screen_name || '';

  const embeddedAvatar =
    tweet.profileImageUrl ||
    tweet.avatar ||
    user.profile_image_url_https ||
    user.profile_image_url ||
    legacy.profile_image_url_https ||
    result.profile_image_url_https ||
    null;

  const embeddedName =
    tweet.name ||
    tweet.displayName ||
    user.name ||
    legacy.name ||
    username ||
    '';

  const embeddedFollowers =
    tweet.followersCount ??
    user.followers_count ??
    legacy.followers_count ??
    0;

  const isVerified =
    tweet.isBlueVerified ??
    tweet.isVerified ??
    user.is_blue_verified ??
    user.verified ??
    legacy.is_blue_verified ??
    legacy.verified ??
    false;

  return {
    id:           tweet.id || tweet.id_str || tweet.rest_id || null,
    text:         tweet.text || tweet.full_text || '',
    username:     username,
    timestamp:    tweet.timestamp || (tweet.timeParsed ? Math.floor(new Date(tweet.timeParsed).getTime() / 1000) : null),
    timeParsed:   tweet.timeParsed || null,
    likes,
    retweets,
    replies,
    views,
    photos:       tweet.photos || [],
    videos:       tweet.videos || [],
    permanentUrl: tweet.permanentUrl || (tweet.id ? `https://x.com/${username}/status/${tweet.id}` : null),
    isRetweet:    tweet.isRetweet || false,
    isReply:      tweet.isReply || false,
    
    profileImage:   embeddedAvatar,
    displayName:    embeddedName,
    followersCount: embeddedFollowers,
    isVerified:     isVerified,
  };
}

async function enrichTweets(tweets) {
  return Promise.all(tweets.map(async (tweet) => {
    const cacheKey = `profile:${tweet.username?.toLowerCase()}`;
    let profile = profileCache.get(cacheKey);

    // If not cached, fetch via public CDN using the Tweet ID
    if (!profile && tweet.id) {
      profile = await fetchSyndicationProfile(tweet.id);
      if (profile) {
        profileCache.set(cacheKey, profile, PROFILE_CACHE_TTL);
      }
    }

    return {
      ...tweet,
      profileImage:   profile?.avatar         || tweet.profileImage || null,
      displayName:    profile?.name           || tweet.displayName  || tweet.username,
      followersCount: profile?.followersCount ?? tweet.followersCount ?? 0,
      isVerified:     profile?.isVerified     || tweet.isVerified   || false,
    };
  }));
}

// Syndication is so fast we don't need a separate batched strategy anymore
async function enrichTweetsBatched(tweets) {
  return enrichTweets(tweets);
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

export async function getTrendingTweets(tweetsPerTrend = 2, mode = 'top', totalLimit = 10) {
  const cacheKey = `trending:${tweetsPerTrend}:${mode}:${totalLimit}`;
  const cached   = tweetCache.get(cacheKey);
  if (cached) return cached;

  const trends     = await getTrends();
  const searchMode = mode === 'top' ? SearchMode.Top : SearchMode.Latest;

  const BATCH = 5;
  const all   = [];

  for (let i = 0; i < trends.length && all.length < totalLimit; i += BATCH) {
    const batch   = trends.slice(i, i + BATCH);
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
  const limited   = all.slice(0, totalLimit);
  const enriched  = await enrichTweets(limited);
  const withTrend = enriched.map((t, i) => ({ ...t, trend: limited[i]?.trend || '' }));

  tweetCache.set(cacheKey, withTrend, TRENDS_CACHE_TTL);
  return withTrend;
}

// ─── LIVE FIREHOSE BACKGROUND WORKER ──────────────────────────────────────────

let backgroundRunning = false;

async function runBackgroundFirehose() {
  if (!ready) return;
  if (backgroundRunning) {
    return;
  }
  backgroundRunning = true;

  try {
    const queries = [
      '(crypto OR $SOL OR memecoin OR pump.fun OR dexscreener) filter:verified min_faves:15 -filter:replies',
      '(AI OR OpenAI OR ChatGPT OR SpaceX OR robotics) filter:verified min_faves:15 -filter:replies',
      '(breaking OR alert OR "just in" OR ceasefire OR war) filter:verified filter:media min_faves:15 -filter:replies'
    ];

    const allTweets = [];
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

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
        } catch (err) {
          console.error(`[Firehose] Error on query [${query.slice(0, 40)}]:`, err.message);
        }
        return out;
      })
    );

    results
      .filter(r => r.status === 'fulfilled')
      .forEach(r => allTweets.push(...r.value));

    const uniqueTweets = Array.from(
      new Map(allTweets.filter(t => t && t.id).map(t => [t.id, t])).values()
    );

    const freshTweets = uniqueTweets.filter(t => {
      const tTime = t.timestamp || (t.timeParsed ? Math.floor(new Date(t.timeParsed).getTime() / 1000) : 0);
      return tTime >= oneHourAgo;
    });

    const finalTweets = freshTweets.length > 0 ? freshTweets : uniqueTweets;

    finalTweets.sort((a, b) => {
      const timeA = a.timestamp || (a.timeParsed ? Math.floor(new Date(a.timeParsed).getTime() / 1000) : 0);
      const timeB = b.timestamp || (b.timeParsed ? Math.floor(new Date(b.timeParsed).getTime() / 1000) : 0);
      return timeB - timeA;
    });

    if (finalTweets.length > 0) {
      const capped = finalTweets.slice(0, 60);

      instantFirehoseData = capped;

      try {
        const enriched = await Promise.race([
          enrichTweetsBatched(capped),
          new Promise((_, reject) => setTimeout(() => reject(new Error('enrich timeout')), 20_000)),
        ]);
        if (Array.isArray(enriched) && enriched.length > 0) {
          instantFirehoseData = enriched;
        }
      } catch (e) {
        console.warn(`⚠️ Enrichment failed/timed out: ${e.message} — keeping raw tweets.`);
      }
    }
  } catch (err) {
    console.error('❌ Background Worker Error:', err.message);
  } finally {
    backgroundRunning = false;
  }
}

let fallbackInFlight = null;

export async function getLiveFirehose(count = 30) {
  if (instantFirehoseData.length > 0) {
    return instantFirehoseData.slice(0, count);
  }

  if (fallbackInFlight) {
    await fallbackInFlight;
    return instantFirehoseData.slice(0, count);
  }

  fallbackInFlight = (async () => {
    try {
      const q = '(crypto OR solana OR news OR AI) filter:verified min_faves:15 -filter:replies';
      const collected = [];

      try {
        let n = 0;
        for await (const tweet of scraper.searchTweets(q, 40, SearchMode.Latest)) {
          collected.push(formatTweet(tweet));
          if (++n >= 40) break;
        }
      } catch (err) {
        // ignore
      }

      const unique = Array.from(
        new Map(collected.filter(t => t && t.id).map(t => [t.id, t])).values()
      );
      unique.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      if (unique.length > 0) {
        instantFirehoseData = unique;
        try {
          const enriched = await Promise.race([
            enrichTweetsBatched(unique),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20_000)),
          ]);
          if (Array.isArray(enriched) && enriched.length > 0) {
            instantFirehoseData = enriched;
          }
        } catch (e) {}
      }
    } finally {
      fallbackInFlight = null;
    }
  })();

  await fallbackInFlight;
  return instantFirehoseData.slice(0, count);
}

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
