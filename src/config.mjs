/**
 * Central config. Loads .env explicitly - `dotenv` was a declared dependency
 * that nothing ever imported, so FB_COOKIES in a .env file was silently ignored.
 */
import "dotenv/config";

const int = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: int("PORT", 4000),

  scraper: {
    navTimeoutMs: int("SCRAPER_NAV_TIMEOUT_MS", 30_000),
    outcomeTimeoutMs: int("SCRAPER_RESULT_TIMEOUT_MS", 15_000),
    scrollPasses: int("SCRAPER_SCROLL_PASSES", 3),
    maxConcurrency: int("SCRAPER_MAX_CONCURRENCY", 2),
    // Politeness: a random pause before each navigation. Fixed intervals are a
    // trivially detectable signature, so the delay is sampled per request.
    minDelayMs: int("SCRAPER_MIN_DELAY_MS", 8_000),
    maxDelayMs: int("SCRAPER_MAX_DELAY_MS", 20_000),
    // Hard stop per process run, so a bug in a loop cannot hammer Facebook.
    sessionListingBudget: int("SCRAPER_SESSION_BUDGET", 100),
  },

  session: {
    cookies: process.env.FB_COOKIES || null,
    storageStatePath: process.env.FB_STORAGE_STATE || null,
    // Where to write a refreshed storage state back to, so a session Facebook
    // rotates mid-run is not lost when the context closes.
    persistStatePath: process.env.FB_STORAGE_STATE_OUT || process.env.FB_STORAGE_STATE || null,
  },

  meli: {
    accessToken: process.env.MELI_ACCESS_TOKEN || null,
    clientId: process.env.MELI_CLIENT_ID || null,
    clientSecret: process.env.MELI_CLIENT_SECRET || null,
    siteId: process.env.MELI_SITE_ID || "MLU",
    carsCategory: process.env.MELI_CARS_CATEGORY || "MLU1744",
    cacheTtlHours: int("MELI_CACHE_TTL_HOURS", 72),
  },

  db: { url: process.env.DATABASE_URL || null },
};

export default config;
