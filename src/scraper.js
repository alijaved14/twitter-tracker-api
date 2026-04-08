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
const PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours (prevents rate limits on avatars)
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

  try {
    const p = await scraper.getProfile(username);
    
    // Deep fallback to find the avatar in any scraper version
    const avatarUrl = p.avatar || p.profileImageUrl || p.profile_image_url_https || null;
    const followers = p.followersCount ?? p.followers_count ?? 0;

    const formatted = {
      username:       p.username   || username,
      name:           p.name       || username,
      avatar:         avatarUrl,
      followersCount: followers,
      isVerified:     p.isBlueVerified || p.isVerified || false,
    };

    profileCache.set(key, formatted, PROFILE_CACHE_TTL);
    return formatted;
  } catch (err) {
    throw new Error(`Profile fetch failed for ${username}`);
  }
}

// ─── Tweet helpers ────────────────────────────────────────────────────────────

function formatTweet(tweet) {
  // Standardize engagement stats
  const likes = tweet.likes ?? tweet.likeCount ?? tweet.favoriteCount ?? tweet.favorite_count ?? 0;
  const retweets = tweet.retweets ?? tweet.retweetCount ?? tweet.retweet_count ?? 0;
  const replies = tweet.replies ?? tweet.replyCount ?? tweet.reply_count ?? 0;
  const views = tweet.views ?? tweet.viewCount ?? tweet.view_count ?? 0;

  // Extract deeply nested user data directly from the tweet to avoid API calls
  const user = tweet.user || tweet.author || {};
  const legacy = tweet.core?.user_results?.result?.legacy || user.legacy || {};
  const result = tweet.core?.user_results?.result || user.result || {};

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
    tweet.username ||
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
    username:     tweet.username || user.screen_name || legacy.screen_name || '',
    timestamp:    tweet.timestamp || (tweet.timeParsed ? Math.floor(new Date(tweet.timeParsed).getTime() / 1000) : null),
    timeParsed:   tweet.timeParsed || null,
    likes,
    retweets,
    replies,
    views,
    photos:       tweet.photos || [],
    videos:       tweet.videos || [],
    permanentUrl: tweet.permanentUrl || (tweet.id ? `https://x.com/${tweet.username}/status/${tweet.id}` : null),
    isRetweet:    tweet.isRetweet || false,
    isReply:      tweet.isReply || false,
    
    // Set raw defaults first, enrichment will safely overwrite if needed
    profileImage:   embeddedAvatar,
    displayName:    embeddedName,
    followersCount: embeddedFollowers,
    isVerified:     isVerified,
  };
}

async function enrichTweets(tweets) {
  const usernames = [...new Set(tweets.map(t => t.username).filter(Boolean))];
  
  // Only fetch users that aren't already cached
  const missingUsernames = usernames.filter(u => !profileCache.has(`profile:${u.toLowerCase()}`));
  
  // Cap at 20 fetches to dodge rate limits
  const toFetch = missingUsernames.slice(0, 20);

  const fetchOne = (u) =>
    Promise.race([
      getProfile(u),
      new Promise((_, reject) => setTimeout(() => reject(new Error('profile timeout')), 4_00
