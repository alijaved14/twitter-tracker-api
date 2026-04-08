/**
 * twitter-tracker-api — Express server
 *
 * Endpoints
 * ─────────
 *  GET /health                            → liveness probe (no auth)
 *  GET /api/search?q=&count=&mode=        → search tweets by keyword
 *  GET /api/tweets/:username?count=       → latest tweets from one account
 *  GET /api/profile/:username             → user profile + avatar + followers
 *  GET /api/feed?accounts=a,b,c&per=5    → merged feed from multiple accounts
 *  GET /api/tracker?q=&count=            → main Tracker page endpoint (search + enrich)
 *
 * Auth
 * ────
 *  If API_SECRET env var is set every /api/* request must include:
 *    Authorization: Bearer <API_SECRET>
 */

import express         from 'express';
import cors            from 'cors';
import rateLimit       from 'express-rate-limit';
import {
  initScraper,
  isReady,
  searchTweets,
  getUserTweets,
  getProfile,
  getMultiAccountFeed,
} from './scraper.js';

// ─── App setup ────────────────────────────────────────────────────────────────
const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.API_SECRET || '';

app.use(express.json());
app.use(cors({
  origin: '*',             // tighten to your domain in production
  methods: ['GET', 'POST'],
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Protects against accidental hammering from frontend polling bugs
const limiter = rateLimit({
  windowMs: 60_000,      // 1 minute window
  max:      60,          // max 60 requests / min per IP
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests — slow down' },
});
app.use('/api/', limiter);

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!SECRET) return next();                         // no secret set → open
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${SECRET}`) return next();
  return res.status(401).json({ error: 'Unauthorized — provide Bearer token' });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scraperGuard(req, res, next) {
  if (!isReady()) {
    return res.status(503).json({
      error: 'Twitter scraper is not authenticated yet. Check server logs.',
    });
  }
  next();
}

function parseCount(raw, max = 50, fallback = 20) {
  const n = parseInt(raw, 10);
  return isNaN(n) ? fallback : Math.min(Math.max(n, 1), max);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Used by UptimeRobot (ping every 5 min to prevent Render spin-down).
 * No auth required.
 */
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    ready:     isReady(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/search
 * Query params:
 *   q      {string}  Search query (required)
 *   count  {number}  Max tweets (1–50, default 20)
 *   mode   {string}  'latest' | 'top'  (default 'latest')
 *
 * Example: /api/search?q=meme+coin+solana&count=20&mode=latest
 */
app.get('/api/search', requireAuth, scraperGuard, async (req, res) => {
  const { q, count, mode = 'latest' } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ error: "Missing required query param: 'q'" });
  }

  try {
    const tweets = await searchTweets(q.trim(), parseCount(count), mode);
    res.json({ success: true, count: tweets.length, tweets });
  } catch (err) {
    console.error('[/api/search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tweets/:username
 * Path params:
 *   username  {string}  Twitter handle (without @)
 * Query params:
 *   count     {number}  Max tweets (1–50, default 20)
 *
 * Example: /api/tweets/elonmusk?count=10
 */
app.get('/api/tweets/:username', requireAuth, scraperGuard, async (req, res) => {
  const { username } = req.params;
  const { count }    = req.query;

  try {
    const tweets = await getUserTweets(username, parseCount(count));
    res.json({ success: true, count: tweets.length, tweets });
  } catch (err) {
    console.error(`[/api/tweets/${username}]`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profile/:username
 * Returns avatar, name, followersCount, isVerified.
 *
 * Example: /api/profile/solana
 */
app.get('/api/profile/:username', requireAuth, scraperGuard, async (req, res) => {
  const { username } = req.params;

  try {
    const profile = await getProfile(username);
    res.json({ success: true, profile });
  } catch (err) {
    console.error(`[/api/profile/${username}]`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/feed
 * Fetch tweets from multiple accounts, merged newest-first.
 * Query params:
 *   accounts  {string}  Comma-separated list of handles  (required)
 *   per       {number}  Tweets per account (1–20, default 5)
 *
 * Example: /api/feed?accounts=solana,phantom,raydium&per=5
 */
app.get('/api/feed', requireAuth, scraperGuard, async (req, res) => {
  const { accounts, per } = req.query;

  if (!accounts || !accounts.trim()) {
    return res.status(400).json({ error: "Missing required query param: 'accounts'" });
  }

  const accountList = accounts
    .split(',')
    .map(a => a.trim().replace(/^@/, ''))
    .filter(Boolean)
    .slice(0, 10);   // hard cap — more than 10 accounts gets slow

  if (accountList.length === 0) {
    return res.status(400).json({ error: 'No valid account handles provided' });
  }

  try {
    const tweets = await getMultiAccountFeed(accountList, parseCount(per, 20, 5));
    res.json({ success: true, count: tweets.length, accounts: accountList, tweets });
  } catch (err) {
    console.error('[/api/feed]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tracker
 * Main endpoint for the Tracker page — search-based, enriched with profiles.
 * This is what your Supabase Edge Function or frontend should poll.
 *
 * Query params:
 *   q      {string}  Search query  (default: 'meme coin solana crypto')
 *   count  {number}  Max tweets    (default: 20)
 *   mode   {string}  'latest'|'top' (default: 'latest')
 *
 * Example: /api/tracker?q=solana+meme+coin&count=20
 */
app.get('/api/tracker', requireAuth, scraperGuard, async (req, res) => {
  const {
    q     = 'meme coin solana crypto',
    count,
    mode  = 'latest',
  } = req.query;

  try {
    const tweets = await searchTweets(q.trim(), parseCount(count, 30, 20), mode);
    res.json({ success: true, count: tweets.length, query: q, tweets });
  } catch (err) {
    console.error('[/api/tracker]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀  twitter-tracker-api listening on port ${PORT}`);
  console.log(`🔐  Auth: ${SECRET ? 'enabled (Bearer token required)' : 'disabled (open)'}`);
  console.log('🐦  Initialising Twitter scraper...');
  await initScraper();
  console.log(`📡  Ready: ${isReady()}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => { console.log('SIGTERM — shutting down'); process.exit(0); });
process.on('SIGINT',  () => { console.log('SIGINT  — shutting down'); process.exit(0); });
