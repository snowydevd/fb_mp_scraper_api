import { Router } from "express";
import { scrapeMarketplace, ScraperError } from "../services/scraper.mjs";

const router = Router();

// Scraper failure codes → HTTP status. 503: the server-side session/access
// needs fixing; 502: upstream page no longer matches our selectors; 504:
// upstream navigation failed.
const STATUS_BY_CODE = {
  LOGIN_REQUIRED: 503,
  BLOCKED: 503,
  DOM_CHANGED: 502,
  NAV_FAILED: 504,
};

function parseOptionalInt(value, name) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw Object.assign(new Error(`${name} must be a non-negative integer`), { badRequest: true });
  }
  return n;
}

router.get("/", async (req, res) => {
  const { query, location } = req.query;
  if (!query || !String(query).trim()) {
    return res
      .status(400)
      .json({ error: { code: "BAD_REQUEST", message: "query parameter is required" } });
  }

  let minPrice, maxPrice;
  try {
    minPrice = parseOptionalInt(req.query.minPrice, "minPrice");
    maxPrice = parseOptionalInt(req.query.maxPrice, "maxPrice");
    if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
      throw Object.assign(new Error("minPrice cannot be greater than maxPrice"), {
        badRequest: true,
      });
    }
  } catch (err) {
    if (!err.badRequest) throw err;
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: err.message } });
  }

  try {
    const items = await scrapeMarketplace(String(query), location || undefined, minPrice, maxPrice);
    res.json({ count: items.length, items });
  } catch (err) {
    if (err instanceof ScraperError) {
      console.error(`[api] scrape failed: ${err.code} ${err.message}`, err.meta);
      return res
        .status(STATUS_BY_CODE[err.code] ?? 500)
        .json({ error: { code: err.code, message: err.message } });
    }
    console.error("[api] unexpected error:", err);
    res.status(500).json({ error: { code: "INTERNAL", message: err.message } });
  }
});

export default router;
