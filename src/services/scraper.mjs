import {
  getBrowser,
  closeBrowser,
  withPoliteSlot,
  countListings,
} from "./marketplace/browser.mjs";

// ---------------------------------------------------------------------------
// Config: selectors and tunables centralized so DOM changes are one-line fixes
// ---------------------------------------------------------------------------

const SELECTORS = {
  // Listing cards are anchors pointing at /marketplace/item/<id>. The anchor
  // itself wraps the whole card (image + price + title + location), so it is
  // the extraction root: any ancestor lookup ("closest div[style*=max-width]")
  // resolves to a different element run to run and shreds the text layout.
  item: 'a[href*="/marketplace/item/"]',
  loginForm: 'input[name="pass"], form[action*="/login"]',
  // Chrome that only the real Marketplace search page renders. Its presence
  // proves we are past any login wall even while zero results are on screen.
  marketplaceShell: '[aria-label*="Marketplace" i], a[href*="/marketplace/create"]',
};

// Empty-state copy varies by locale; cover es/en variants. es-UY renders
// "No se han encontrado publicaciones para ..." - the intervening "han" is why
// a bare /no se encontr/ missed it and every empty search burned the full
// outcome budget before falling through.
const EMPTY_STATE_RE =
  /no se (?:han? )?encontrad|no (?:hay|encontramos)|sin resultados|couldn'?t find|didn'?t find|no (?:listings|results)|nothing (?:was )?found/i;

// Copy proving the Marketplace search UI rendered (not a login wall).
const SHELL_TEXT_RE =
  /resultados de la b[u\u00fa]squeda|search results|filtros|filters|crear publicaci[o\u00f3]n|create new listing/i;

const TIMEOUTS = {
  navigationMs: intEnv("SCRAPER_NAV_TIMEOUT_MS", 30_000),
  outcomeMs: intEnv("SCRAPER_RESULT_TIMEOUT_MS", 15_000),
  scrollPauseMs: 700,
};
const SCROLL_PASSES = intEnv("SCRAPER_SCROLL_PASSES", 3);

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
  out(
    `[scraper] ${new Date().toISOString()} ${level.toUpperCase()} ${msg}`,
    extra ?? "",
  );
}

// ---------------------------------------------------------------------------
// Browser lifecycle: one shared browser, one context per request,
// bounded concurrency
// ---------------------------------------------------------------------------

// Browser lifecycle, concurrency and politeness all live in
// marketplace/browser.mjs now. This module used to keep its own Chromium
// singleton and its own slot queue - so the process ran two browsers, and the
// keyword path had a concurrency cap with NO delay and NO session budget at
// all: a loop against GET /api/marketplace hammered Facebook as fast as
// Chromium could navigate, while the worker politely waited 8-20s per request.
// Re-exported so existing importers (src/main.mjs) keep working.
export { closeBrowser };

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
  if (session.kind === "storageState")
    options.storageState = session.storageState;
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
    mainStatus != null && mainStatus >= 400
      ? Math.min(TIMEOUTS.outcomeMs, 4000)
      : TIMEOUTS.outcomeMs;
  const deadline = Date.now() + budget;
  let snapshot = null;
  // Anonymous Marketplace always ships "Iniciar sesión" text AND a login form
  // in the page chrome, even on scrapes that succeed. Neither is evidence of a
  // login wall on its own, so a wall is only called when the Marketplace shell
  // is absent — i.e. the login form is the page rather than a widget on it.
  let sawShell = false;

  while (Date.now() < deadline) {
    try {
      snapshot = await page.evaluate((sel) => {
        return {
          url: location.href,
          hasItems: !!document.querySelector(sel.item),
          hasLoginForm: !!document.querySelector(sel.loginForm),
          hasShell: !!document.querySelector(sel.marketplaceShell),
          bodyText: (document.body?.innerText || "").slice(0, 8000),
        };
      }, SELECTORS);
    } catch {
      // Execution context destroyed mid-navigation; retry on next tick
      snapshot = null;
    }

    if (snapshot) {
      const shell = snapshot.hasShell || SHELL_TEXT_RE.test(snapshot.bodyText);
      if (shell) sawShell = true;

      if (/\/(checkpoint|captcha)/.test(snapshot.url))
        return { state: "blocked", snapshot };
      if (snapshot.hasItems) return { state: "items", snapshot };
      // A real wall: FB navigated us to /login, or served a login form on a
      // page with no Marketplace UI at all.
      if (/\/login/.test(snapshot.url) || (snapshot.hasLoginForm && !shell))
        return { state: "login", snapshot };
      if (EMPTY_STATE_RE.test(snapshot.bodyText))
        return { state: "empty", snapshot };
    }
    await page.waitForTimeout(500);
  }

  // Budget spent with the search UI on screen and no cards: a genuine
  // zero-result search whose empty-state copy we don't recognise.
  if (sawShell) return { state: "empty", snapshot };
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
  const raw = await page.$$eval(SELECTORS.item, (anchors) => {
    // -- price grammar ------------------------------------------------------
    // FB renders the currency as a SUFFIX in es-UY ("2800 $U", "20 000 $U")
    // and as a prefix elsewhere ("$ 1.500", "USD 200"), and separates
    // thousands with NBSP. Normalise the spaces, then accept either side.
    const CUR = "UYU|U\\$S|US\\$|USD|AR\\$|R\\$|\\$U|\\$|€|£";
    const NUM = "\\d[\\d.,\\s]*";
    const PRICE_RE = new RegExp(
      `^(?:(?:${CUR})\\s*${NUM}|${NUM}\\s*(?:${CUR}))$`,
      "i"
    );
    const FREE_RE = /^(?:gratis|free)$/i;
    const CURRENCIES = [
      [/UYU|\$U/i, "UYU"],
      [/U\$S|US\$|USD/i, "USD"],
      [/AR\$/i, "ARS"],
      [/R\$/i, "BRL"],
      [/€/, "EUR"],
      [/£/, "GBP"],
    ];

    // NBSP / narrow-NBSP / thin space -> plain space, then collapse
    const norm = (v) =>
      (v == null ? "" : String(v))
        .replace(/[   ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const isPrice = (v) => {
      const t = norm(v);
      return !!t && (PRICE_RE.test(t) || FREE_RE.test(t));
    };

    const currencyOf = (v) => {
      const t = norm(v);
      if (!t || FREE_RE.test(t)) return null;
      for (const [re, code] of CURRENCIES) if (re.test(t)) return code;
      return null; // a bare "$" is genuinely ambiguous; don't guess
    };

    const parseAmount = (v) => {
      const t = norm(v);
      if (!t) return null;
      if (FREE_RE.test(t)) return 0;
      const stripped = t
        .replace(new RegExp(CUR, "gi"), "")
        // drop a 2-digit decimal tail ("1.500,50" -> "1.500"); leaves
        // thousand groups ("1.500", "20 000") untouched
        .replace(/[.,](\d{2})\s*$/, "");
      const digits = stripped.replace(/\D/g, "");
      return digits ? parseInt(digits, 10) : null;
    };

    // -- aria-label: the reliable source ------------------------------------
    // Every card carries "<title>, <price>, [reducido desde <old>,] <location>,
    // publicación <id>". Parsing it beats splitting innerText, which also picks
    // up badges ("Recién publicado") and collapses to one line at random.
    const ID_TAIL_RE = /,\s*(?:publicación|publicacion|listing|post|anuncio)\s*\d+\s*$/i;
    const OLD_PRICE_RE = /^(?:reducido desde|reduced from|antes|was)\s+(.+)$/i;

    const fromAria = (aria) => {
      const body = norm(aria).replace(ID_TAIL_RE, "");
      if (!body) return null;
      const segs = body.split(/\s*,\s*/).filter(Boolean);
      if (segs.length < 2) return null;

      // The title is never empty, so the price is never segment 0. That guard
      // also stops a title that reads like a price ("Bicicleta $1500") from
      // being mistaken for the price field.
      let i = -1;
      for (let k = 1; k < segs.length; k++) {
        if (isPrice(segs[k])) {
          i = k;
          break;
        }
      }
      if (i === -1) return null;

      // Title and location are re-joined, so commas inside them survive
      // ("Colonia Nicolich, Canelones, Uruguay").
      const title = segs.slice(0, i).join(", ") || null;
      const priceRaw = segs[i];
      let j = i + 1;
      let oldPriceRaw = null;
      const discount = segs[j] ? segs[j].match(OLD_PRICE_RE) : null;
      if (discount && isPrice(discount[1])) {
        oldPriceRaw = norm(discount[1]);
        j++;
      }
      return { title, priceRaw, oldPriceRaw, location: segs.slice(j).join(", ") || null };
    };

    // -- innerText fallback, for cards that ever ship without aria-label ----
    const BADGE_RE =
      /^(?:recién publicado|recien publicado|just listed|nuevo|new|patrocinado|sponsored)$/i;

    const fromLines = (anchor) => {
      const lines = (anchor.innerText || "")
        .split(/\r?\n/)
        .map(norm)
        .filter((t) => t && !BADGE_RE.test(t));
      if (!lines.length) return null;

      const i = lines.findIndex(isPrice);
      if (i === -1) return { title: lines[0] || null, priceRaw: null, oldPriceRaw: null, location: lines[1] || null };

      const priceRaw = lines[i];
      const rest = lines.slice(i + 1);
      // A second consecutive price line is the struck-through original
      const oldPriceRaw = rest[0] && isPrice(rest[0]) ? rest.shift() : null;
      return { title: rest[0] || null, priceRaw, oldPriceRaw, location: rest[1] || null };
    };

    return anchors.map((anchor) => {
      const parsed = fromAria(anchor.getAttribute("aria-label")) || fromLines(anchor) || {};
      const idMatch = anchor.href.match(/\/marketplace\/item\/(\d+)/);
      const priceRaw = parsed.priceRaw || null;

      return {
        id: idMatch ? idMatch[1] : null,
        title: parsed.title || norm(anchor.querySelector("img")?.alt) || null,
        price: parseAmount(priceRaw),
        priceRaw,
        currency: currencyOf(priceRaw),
        oldPrice: parseAmount(parsed.oldPriceRaw),
        oldPriceRaw: parsed.oldPriceRaw || null,
        location: parsed.location || null,
        thumbnail: anchor.querySelector("img")?.src || null,
        url: idMatch
          ? `https://www.facebook.com/marketplace/item/${idMatch[1]}/`
          : anchor.href,
      };
    });
  });

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
    log(
      "info",
      `navigating query="${query}" location="${location}" session=${hasSession}`,
    );

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
        { url },
      );
    }

    const status = response?.status();
    const { state, snapshot } = await waitForOutcome(page, {
      mainStatus: status,
    });
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
          meta,
        );
      case "blocked":
        throw new ScraperError(
          ERROR_CODES.BLOCKED,
          "Facebook served a captcha/checkpoint page (bot detection).",
          meta,
        );
      case "empty":
        log("info", `no results for query="${query}"`, meta.finalUrl);
        return [];
      case "unknown":
        if (status != null && status >= 400) {
          throw new ScraperError(
            ERROR_CODES.NAV_FAILED,
            `Facebook returned HTTP ${status} for the search page.`,
            meta,
          );
        }
        throw new ScraperError(
          ERROR_CODES.DOM_CHANGED,
          `Page loaded but no known markers (items, login, empty-state) appeared within ${TIMEOUTS.outcomeMs}ms. Selectors may be outdated.`,
          meta,
        );
    }

    await scrollToLoadMore(page);
    const items = await extractItems(page);

    // FB already filtered via URL params; re-check locally as a guarantee.
    // Items without a parseable price are dropped only when a bound is set.
    // Bounds are compared against the raw number, so on a page mixing UYU and
    // USD cards they mean "whatever `currency` says" — same as FB's own filter.
    const filtered = items.filter((item) => {
      if (item.price == null) return minPrice == null && maxPrice == null;
      if (minPrice != null && item.price < minPrice) return false;
      if (maxPrice != null && item.price > maxPrice) return false;
      return true;
    });

    log(
      "info",
      `extracted ${items.length} items (${filtered.length} after price filter)`,
    );
    // Against the same session budget the worker draws from: one navigation
    // that pulled 24 cards is not free just because it was a single request.
    countListings(1);
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
export async function scrapeMarketplace(
  searchQuery,
  location = "montevideo",
  minPrice,
  maxPrice,
  opts = {},
) {
  const query = String(searchQuery ?? "").trim();
  if (!query) throw new TypeError("searchQuery is required");
  // withPoliteSlot, not a bare concurrency gate: it also applies the randomised
  // 8-20s pause and enforces the per-process session budget, so the public
  // endpoint can no longer outpace the worker's own rate limiting.
  return withPoliteSlot(() => doScrape(query, location, minPrice, maxPrice), opts);
}
