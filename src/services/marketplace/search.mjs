/**
 * Fase 1: category-based vehicle search.
 *
 * Every bound is applied by Facebook via the category URL; nothing is
 * re-filtered here. The keyword path (services/scraper.mjs) stays available for
 * anything still calling it, but is no longer how vehicles are found.
 */
import { config } from "../../config.mjs";
import { ScraperError, ERROR_CODES, waitForOutcome } from "../scraper.mjs";
import { buildVehicleUrl } from "./url.mjs";
import { extractRelayNodes, mapListings } from "./extract.mjs";
import {
  getBrowser,
  newSessionContext,
  persistSession,
  withPoliteSlot,
  countListings,
  log,
} from "./browser.mjs";

const { scraper } = config;

async function scrollToLoadMore(page) {
  let previous = 0;
  for (let i = 0; i < scraper.scrollPasses; i++) {
    const height = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });
    if (height === previous) break;
    previous = height;
    // Short, jittered pause - a fixed 700ms cadence is a bot signature.
    await page.waitForTimeout(500 + Math.floor(Math.random() * 700));
  }
}

async function runSearch(filters) {
  const { url, filters: f } = buildVehicleUrl(filters);
  const browser = await getBrowser();
  const { context, hasSession } = await newSessionContext(browser);

  try {
    const page = await context.newPage();
    log("info", `vehicles ${f.location}/${f.category} session=${hasSession}`, url);

    let response;
    try {
      response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: scraper.navTimeoutMs,
      });
    } catch (err) {
      throw new ScraperError(
        ERROR_CODES.NAV_FAILED,
        `Navigation to the vehicles category failed: ${err.message.split("\n")[0]}`,
        { url }
      );
    }

    const status = response?.status();
    const { state, snapshot } = await waitForOutcome(page, { mainStatus: status });
    const meta = { url, finalUrl: snapshot?.url, status, filters: f };

    switch (state) {
      case "login":
        throw new ScraperError(
          ERROR_CODES.LOGIN_REQUIRED,
          hasSession
            ? "Facebook redirected to login: the configured session is expired. Refresh FB_COOKIES / FB_STORAGE_STATE."
            : "Facebook requires a logged-in session from this IP. Configure FB_COOKIES or FB_STORAGE_STATE.",
          meta
        );
      case "blocked":
        throw new ScraperError(ERROR_CODES.BLOCKED, "Facebook served a captcha/checkpoint page.", meta);
      case "empty":
        log("info", "no vehicles matched the filters", meta.finalUrl);
        await persistSession(context);
        return { url, filters: f, items: [], failures: [] };
      case "unknown":
        if (status != null && status >= 400) {
          throw new ScraperError(ERROR_CODES.NAV_FAILED, `Facebook returned HTTP ${status}.`, meta);
        }
        throw new ScraperError(
          ERROR_CODES.DOM_CHANGED,
          "Category page loaded but no known markers appeared. Selectors may be outdated.",
          meta
        );
    }

    await scrollToLoadMore(page);

    const nodes = await extractRelayNodes(page);
    if (nodes.length === 0) {
      // Cards were on screen but the Relay payload held none: a real schema
      // change, not an empty result. Fail loudly rather than return [].
      throw new ScraperError(
        ERROR_CODES.DOM_CHANGED,
        "Listing cards rendered but the embedded Relay payload contained no listing nodes.",
        meta
      );
    }

    const { items, failures } = mapListings(nodes);
    if (failures.length) {
      log("error", `${failures.length}/${nodes.length} nodes failed to map`, failures.slice(0, 3));
    }
    countListings(items.length);
    log("info", `extracted ${items.length} vehicles (budget used: ${items.length})`);
    await persistSession(context);

    return { url, filters: f, items, failures };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Search the vehicles category with server-side filters.
 *
 * @param {object} filters see normalizeVehicleFilters
 * @param {object} [opts]
 * @param {boolean} [opts.skipDelay] skip the politeness pause (tests only)
 * @returns {Promise<{url:string, filters:object, items:object[], failures:object[]}>}
 */
export function searchVehicles(filters = {}, opts = {}) {
  return withPoliteSlot(() => runSearch(filters), opts);
}
