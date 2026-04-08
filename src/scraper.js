/**
 * Twitter scraper singleton.
 *
 * Auth priority:
 *   1. TWITTER_COOKIES env var  (base64-encoded JSON array of cookie strings)
 *   2. TWITTER_USERNAME + TWITTER_PASSWORD  (fresh login)
 *
 * On first login the raw cookie string is printed to stdout so you can
 * copy it into the TWITTER_COOKIES env var in Render — this prevents
 * re-logging in on every cold start (which accelerates account bans).
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
  // Only run once even if called multiple times
  if (initPromise) return initPromise;

  initPromise = (async () => {
    scraper = new Scraper();

    // ── 1. Try restoring session from TWITTER_COOKIES ────────────────────────
    const cookieEnv = process.env.TWITTER_COOKIES;
    if (cookieEnv) {
      try {
        // Support both raw semicolon string AND base64-encoded JSON array
        let cookieList;
        try {
          // Try base64-encoded JSON array first (safer for env vars with semicolons)
          cookieList = JSON.parse(Buffer.from(cookieEnv, 'base64').toString('utf8'));
          if (Array.isArray(cookieList)) {
            await scraper.setCookies(cookieList.map(c => Cookie.parse(c)).filter(Boolean));
          } else {
            throw new Error('not an array');
          }
        } catch {
          // Fall back to raw semicolon string
          await scraper.setCookies(parseCookieString(cookieEnv));
        }

        ready = await scraper.isLoggedIn();

        if (ready) {
          console.log('✅ Session restored from TWITTER_COOKIES');
          return;
        }

        console.warn('⚠️  Cookies present but session invalid — will re-login');
      } catch (err) {
        console.warn('⚠️  Failed to restore cookies:', err.message);
      }
    }

    // ── 2. Fresh login with credentials ──────────────────────────────────────
    const { TWITTER_USERNAME, TWITTER_PASSWORD, TWITTER_EMAIL } = process.env;

    if (!TWITTER_USERNAME || !TWITTER_PASSWORD) {
      console.error(
        '❌ No valid session and no TWITTER_USERNAME/PASSWORD set.\n' +
        '   Set at least TWITTER_USERNAME and TWITTER_PASSWORD in env vars.'
      );
      return;
    }

    try {
      console.log(`🔐 Logging in as @${TWITTER_USERNAME}...`);
      await scraper.login(TWITTER_USERNAME, TWITTER_PASSWORD, TWITTER_EMAIL);
      ready = await scraper.isLoggedIn();

      if (ready) {
        const cookies    = await scraper.getCookies();
        const cookieArr  = cookies.map(c => c.toString());
        const b64Cookies = Buffer.from(JSON.stringify(cookieArr)).toString('base64');

        console.log('✅ Logged in successfully');
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💾  SAVE THIS to TWITTER_COOKIES env var in Render');
        console.log('    (prevents re-login on every cold-start)');
        console.log('');
        console.log(b64Cookies);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
      } else {
        console.error('❌ Login completed but isLoggedIn() returned false');
      }
    } catch (err) {
      console.error('❌ Login failed:', err.message);
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
