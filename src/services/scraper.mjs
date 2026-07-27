import { chromium } from "playwright";

// ---------------------------------------------------------------------------
// Config: selectors and tunables centralized so DOM changes are one-line fixes
// ---------------------------------------------------------------------------

const SELECTORS = {
  // Listing cards are anchors pointing at /marketplace/item/<id>
  item: 'a[href*="/marketplace/item/"]',
  // Container around the anchor that holds the visible price/title text
  itemContainer: 'div[style*="max-width"]',
  loginForm: 'input[name="pass"], form[action*="/login"]',
};

// Empty-state copy varies by locale; cover es/en variants
const EMPTY_STATE_RE =
  /no (?:hay|encontramos|se encontr)|couldn'?t find|no (?:listings|results)|nothing (?:was )?found/i;

// Login-wall copy shown when FB demands a session (URL may stay unchanged)
const LOGIN_TEXT_RE =
  /inicia(?:r)? sesi[oó]n|log in to facebook|create new account|crear cuenta nueva|conn?ectate/i;

const TIMEOUTS = {
  navigationMs: intEnv("SCRAPER_NAV_TIMEOUT_MS", 30_000),
  outcomeMs: intEnv("SCRAPER_RESULT_TIMEOUT_MS", 15_000),
  scrollPauseMs: 700,
};
const SCROLL_PASSES = intEnv("SCRAPER_SCROLL_PASSES", 3);
const MAX_CONCURRENCY = intEnv("SCRAPER_MAX_CONCURRENCY", 2);

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Error taxonomy: every failure mode is distinguishable by `code`
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  LOGIN_REQUIRED: "LOGIN_REQUIRED", // FB served the login wall
  BLOCKED: "BLOCKED", // captcha / checkpoint / bot detection
  DOM_CHANGED: "DOM_CHANGED", // page loaded but no known markers found
  NAV_FAILED: "NAV_FAILED", // navigation error or timeout
};

export class ScraperError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "ScraperError";
    this.code = code;
    this.meta = meta;
  }
}

function log(level, msg, extra) {
  const out = level === "error" ? console.error : console.log;
  out(`[scraper] ${new Date().toISOString()} ${level.toUpperCase()} ${msg}`, extra ?? "");
}

// ---------------------------------------------------------------------------
// Browser lifecycle: one shared browser, one context per request,
// bounded concurrency
// ---------------------------------------------------------------------------

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).then((browser) => {
      browser.on("disconnected", () => {
        browserPromise = null;
      });
      return browser;
    });
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const p = browserPromise;
    browserPromise = null;
    await p.then((b) => b.close()).catch(() => {});
  }
}

let activeSlots = 0;
const slotQueue = [];

async function withSlot(fn) {
  if (activeSlots >= MAX_CONCURRENCY) {
    await new Promise((resolve) => slotQueue.push(resolve));
  }
  activeSlots++;
  try {
    return await fn();
  } finally {
    activeSlots--;
    const next = slotQueue.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// Session: cookies from FB_STORAGE_STATE (Playwright storage state JSON path)
// or FB_COOKIES (raw "name=value; name2=value2" string, e.g. "c_user=..; xs=..")
// ---------------------------------------------------------------------------

function sessionConfig() {
  if (process.env.FB_STORAGE_STATE) {
    return { kind: "storageState", storageState: process.env.FB_STORAGE_STATE };
  }
  if (process.env.FB_COOKIES) {
    const cookies = process.env.FB_COOKIES.split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        return {
          name: pair.slice(0, eq).trim(),
          value: pair.slice(eq + 1).trim(),
          domain: ".facebook.com",
          path: "/",
          secure: true,
          sameSite: "None",
        };
      })
      .filter((c) => c.name);
    if (cookies.length) return { kind: "cookies", cookies };
  }
  return { kind: "none" };
}

async function newSessionContext(browser) {
  const session = sessionConfig();
  const options = { locale: "es-ES" };
  if (session.kind === "storageState") options.storageState = session.storageState;
  const context = await browser.newContext(options);
  if (session.kind === "cookies") await context.addCookies(session.cookies);
  return { context, hasSession: session.kind !== "none" };
}

// ---------------------------------------------------------------------------
// Scraping
// ---------------------------------------------------------------------------

function buildSearchUrl(query, location, minPrice, maxPrice) {
  const base = `https://www.facebook.com/marketplace/${encodeURIComponent(location)}/search`;
  const params = new URLSearchParams({ query });
  // FB supports server-side price filtering on the search URL
  if (minPrice != null) params.set("minPrice", String(minPrice));
  if (maxPrice != null) params.set("maxPrice", String(maxPrice));
  return `${base}?${params.toString()}`;
}

/**
 * Poll the page until it reaches a recognizable state. Distinguishes:
 * items present / login wall / captcha-checkpoint / empty results / unknown DOM.
 * Exported for fixture tests only.
 */
export async function waitForOutcome(page, { mainStatus } = {}) {
  // On an HTTP error page nothing more will render; don't wait the full budget
  const budget =
    mainStatus != null && mainStatus >= 400 ? Math.min(TIMEOUTS.outcomeMs, 4000) : TIMEOUTS.outcomeMs;
  const deadline = Date.now() + budget;
  let snapshot = null;
  while (Date.now() < deadline) {
    try {
      snapshot = await page.evaluate((sel) => {
        return {
          url: location.href,
          hasItems: !!document.querySelector(sel.item),
          hasLoginForm: !!document.querySelector(sel.loginForm),
          bodyText: (document.body?.innerText || "").slice(0, 8000),
        };
      }, SELECTORS);
    } catch {
      // Execution context destroyed mid-navigation; retry on next tick
      snapshot = null;
    }
    if (snapshot) {
      if (/\/(checkpoint|captcha)/.test(snapshot.url)) return { state: "blocked", snapshot };
      if (snapshot.hasItems) return { state: "items", snapshot };
      if (
        /\/login/.test(snapshot.url) ||
        snapshot.hasLoginForm ||
        LOGIN_TEXT_RE.test(snapshot.bodyText)
      )
        return { state: "login", snapshot };
      if (EMPTY_STATE_RE.test(snapshot.bodyText)) return { state: "empty", snapshot };
    }
    await page.waitForTimeout(500);
  }
  return { state: "unknown", snapshot };
}

async function scrollToLoadMore(page) {
  let previousHeight = 0;
  for (let i = 0; i < SCROLL_PASSES; i++) {
    const height = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });
    if (height === previousHeight) break;
    previousHeight = height;
    await page.waitForTimeout(TIMEOUTS.scrollPauseMs);
  }
}

/**
 * Extract listing data from all item anchors currently in the DOM.
 * Exported separately so parsing can be tested against HTML fixtures.
 */
export async function extractItems(page) {
  const raw = await page.$$eval(
    SELECTORS.item,
    (anchors, containerSel) => {
      // A price line starts with a currency marker ("$ 1.500", "U$S 200",
      // "UYU 3.000", "€50") or is a free-item label. Anchored at the start so
      // titles like "Suzuki 125" never match.
      const PRICE_RE = /^(?:UYU|U\$S|US\$|USD|\$U|R\$|\$|€|£)\s*[\d.,]+/i;
      const FREE_RE = /^(?:gratis|free)$/i;
      const isPrice = (s) => PRICE_RE.test(s) || FREE_RE.test(s);
      const parseAmount = (s) => {
        if (s == null) return null;
        if (FREE_RE.test(s)) return 0;
        const digits = s.replace(/[^\d]/g, "");
        return digits ? parseInt(digits, 10) : null;
      };

      return anchors.map((anchor) => {
        const container = anchor.closest(containerSel) || anchor;
        const lines = (container.innerText || "")
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean);

        let priceRaw = null;
        let oldPriceRaw = null;
        let title = null;
        let locationText = null;

        const priceIdx = lines.findIndex(isPrice);
        if (priceIdx !== -1) {
          priceRaw = lines[priceIdx];
          const rest = lines.slice(priceIdx + 1);
          // A second consecutive price line is the strikethrough old price
          if (rest[0] && isPrice(rest[0])) oldPriceRaw = rest.shift();
          title = rest[0] || null;
          locationText = rest[1] || null;
        } else {
          title = lines[0] || null;
          locationText = lines[1] || null;
        }
        if (!title) {
          title =
            anchor.getAttribute("aria-label") ||
            container.querySelector("img")?.alt ||
            null;
        }

        const idMatch = anchor.href.match(/\/marketplace\/item\/(\d+)/);
        return {
          id: idMatch ? idMatch[1] : null,
          title,
          price: parseAmount(priceRaw),
          priceRaw,
          oldPriceRaw,
          location: locationText,
          thumbnail: container.querySelector("img")?.src || null,
          url: idMatch
            ? `https://www.facebook.com/marketplace/item/${idMatch[1]}/`
            : anchor.href,
        };
      });
    },
    SELECTORS.itemContainer
  );

  // FB renders duplicate anchors for the same listing; keep the first of each
  const seen = new Set();
  return raw.filter((item) => {
    const key = item.id ?? item.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function doScrape(query, location, minPrice, maxPrice) {
  const url = buildSearchUrl(query, location, minPrice, maxPrice);
  const browser = await getBrowser();
  const { context, hasSession } = await newSessionContext(browser);
  try {
    const page = await context.newPage();
    log("info", `navigating query="${query}" location="${location}" session=${hasSession}`);

    let response;
    try {
      response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUTS.navigationMs,
      });
    } catch (err) {
      throw new ScraperError(
        ERROR_CODES.NAV_FAILED,
        `Navigation to Marketplace failed: ${err.message.split("\n")[0]}`,
        { url }
      );
    }

    const status = response?.status();
    const { state, snapshot } = await waitForOutcome(page, { mainStatus: status });
    const meta = {
      url,
      finalUrl: snapshot?.url,
      status,
      pageTitle: await page.title().catch(() => null),
    };

    switch (state) {
      case "login":
        throw new ScraperError(
          ERROR_CODES.LOGIN_REQUIRED,
          hasSession
            ? "Facebook redirected to login: the configured session is expired or invalid. Refresh FB_COOKIES / FB_STORAGE_STATE."
            : "Facebook requires a logged-in session for Marketplace from this IP. Configure FB_COOKIES or FB_STORAGE_STATE.",
          meta
        );
      case "blocked":
        throw new ScraperError(
          ERROR_CODES.BLOCKED,
          "Facebook served a captcha/checkpoint page (bot detection).",
          meta
        );
      case "empty":
        log("info", `no results for query="${query}"`, meta.finalUrl);
        return [];
      case "unknown":
        if (status != null && status >= 400) {
          throw new ScraperError(
            ERROR_CODES.NAV_FAILED,
            `Facebook returned HTTP ${status} for the search page.`,
            meta
          );
        }
        throw new ScraperError(
          ERROR_CODES.DOM_CHANGED,
          `Page loaded but no known markers (items, login, empty-state) appeared within ${TIMEOUTS.outcomeMs}ms. Selectors may be outdated.`,
          meta
        );
    }

    await scrollToLoadMore(page);
    const items = await extractItems(page);

    // FB already filtered via URL params; re-check locally as a guarantee.
    // Items without a parseable price are dropped only when a bound is set.
    const filtered = items.filter((item) => {
      if (item.price == null) return minPrice == null && maxPrice == null;
      if (minPrice != null && item.price < minPrice) return false;
      if (maxPrice != null && item.price > maxPrice) return false;
      return true;
    });

    log("info", `extracted ${items.length} items (${filtered.length} after price filter)`);
    return filtered;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Scrape Facebook Marketplace search results.
 *
 * @param {string} searchQuery required search text
 * @param {string} [location] marketplace location slug (default "montevideo")
 * @param {number} [minPrice] optional lower price bound
 * @param {number} [maxPrice] optional upper price bound
 * @returns {Promise<Array<{id, title, price, priceRaw, oldPriceRaw, location, thumbnail, url}>>}
 * @throws {ScraperError} with a `code` from ERROR_CODES on any failure
 */
export async function scrapeMarketplace(searchQuery, location = "montevideo", minPrice, maxPrice) {
  const query = String(searchQuery ?? "").trim();
  if (!query) throw new TypeError("searchQuery is required");
  return withSlot(() => doScrape(query, location, minPrice, maxPrice));
}
