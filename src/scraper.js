/**
 * Twitter scraper singleton.
 *
 * Auth — set TWITTER_COOKIES env var in Render (recommended):
 *
 *   Simple format (just auth_token + ct0 from browser):
 *     auth_token=YOUR_AUTH_TOKEN; ct0=YOUR_CT0_TOKEN
 *
 *   How to get cookies:
 *     1. Open https://x.com in Chrome, make sure you're logged in
 *     2. Press F12 → Application → Cookies → https://x.com
 *     3. Copy the Value of  auth_token  and  ct0
 *     4. Paste into Render env var as:  auth_token=VALUE; ct0=VALUE
 *
 * Username/password login is intentionally disabled —
 * Cloudflare blocks it on server IPs.
 */

import { Scraper, SearchMode } from '@the-convocation/twitter-scraper';
import { Cookie } from 'tough-cookie';
import { TTLCache } from './cache.js';

// ─── Caches ──────────────────────────────────────────────────────────────────
const profileCache = new TTLCache();   // TTL set per-call below
const tweetCache   = new TTLCache();   // TTL set per-call below

const TWEET_CACHE_TTL   = 30_000;      // 30 s  — fresh tweets
const PROFILE_CACHE_TTL = 10 * 60_000; // 10 min — profiles change rarely

// ─── Scraper state ───────────────────────────────────────────────────────────
let scraper     = null;
let ready       = false;
let initPromise = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a semicolon-separated cookie string into tough-cookie Cookie objects. */
function parseCookieString(raw) {
  return raw
    .split(';')
    .map(s => Cookie.parse(s.trim()))
    .filter(Boolean);
}

/** Serialise cookies back to a semicolon-separated string for env var storage. */
async function cookiesToString(cookies) {
  return cookies.map(c => c.toString()).join('; ');
}

// ─── Init / Auth ─────────────────────────────────────────────────────────────

export async function initScraper() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    scraper = new Scraper();

    const cookieEnv = process.env.TWITTER_COOKIES;

    if (!cookieEnv || !cookieEnv.trim()) {
      console.error('');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('❌  TWITTER_COOKIES env var is not set.');
      console.error('');
      console.error('   1. Open https://x.com in Chrome (logged in)');
      console.error('   2. Press F12 → Application → Cookies → https://x.com');
      console.error('   3. Copy auth_token value and ct0 value');
      console.error('   4. In Render dashboard → Environment, set:');
      console.error('      TWITTER_COOKIES = auth_token=YOURVALUE; ct0=YOURVALUE');
      console.error('   5. Redeploy');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('');
      return;
    }

    try {
      // Parse the cookie string — supports:
      //   auth_token=X; ct0=Y                  (simple browser copy-paste)
      //   base64-encoded JSON array             (legacy format)
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
        // Plain  auth_token=X; ct0=Y  string — the normal case
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
        console.error('   Your auth_token or ct0 may be expired.');
        console.error('   Get fresh cookies from your browser and update TWITTER_COOKIES in Render.');
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
    // profile fields injected later by enrichTweets()
    profileImage:  null,
    displayName:   tweet.username || '',
    followersCount: 0,
    isVerified:    false,
  };
}

/** Fetch profiles for all unique authors and merge into tweet objects. */
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

/**
 * Search tweets by keyword/query.
 * @param {string} query
 * @param {number} count   Max tweets to return (capped at 50)
 * @param {'latest'|'top'} mode
 */
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

/**
 * Get recent tweets from a specific user's timeline.
 * @param {string} username   Twitter handle (without @)
 * @param {number} count      Max tweets to return
 */
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

/**
 * Get latest tweets from multiple accounts, merged and sorted by time.
 * @param {string[]} accounts   Array of Twitter handles
 * @param {number}   perAccount Tweets to fetch per account
 */
export async function getMultiAccountFeed(accounts, perAccount = 5) {
  const cacheKey = `feed:${accounts.join(',')}:${perAccount}`;
  const cached   = tweetCache.get(cacheKey);
  if (cached) return cached;

  const results = await Promise.allSettled(
    accounts.map(a => getUserTweets(a, perAccount))
  );

  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  tweetCache.set(cacheKey, all, TWEET_CACHE_TTL);
  return all;
}

// ─── Cache maintenance ────────────────────────────────────────────────────────
setInterval(() => {
  profileCache.cleanup();
  tweetCache.cleanup();
}, 5 * 60_000);
