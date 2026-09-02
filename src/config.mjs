/**
 * Central config. Loads .env explicitly - `dotenv` was a declared dependency
 * that nothing ever imported, so FB_COOKIES in a .env file was silently ignored.
 */
import "dotenv/config";

const int = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
};

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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


  // Tipo de cambio, sólo para netear una deuda declarada en una moneda contra
  // una oferta en la otra. Sin esto configurado no se convierte NADA: inventar
  // un tipo de cambio para poder restar sería peor que no restar, y el monto
  // queda reportado para que lo mire una persona.
  fx: { uyuPerUsd: num("UYU_PER_USD", null) },

  db: { url: process.env.DATABASE_URL || null },
};

export default config;
