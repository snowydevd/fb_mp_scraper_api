/**
 * Read-only ranking endpoint. Serves the database, never Facebook: scraping
 * happens in the worker, on its own schedule.
 */
import { Router } from "express";
import { config } from "../config.mjs";

const router = Router();

router.get("/", async (req, res, next) => {
  if (!config.db.url) {
    return res.status(503).json({
      error: { code: "NO_DATABASE", message: "DATABASE_URL is not configured; run the worker with --dry to see a ranking without persistence" },
    });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const minScore = req.query.minScore != null ? Number(req.query.minScore) : null;
  if (minScore != null && !Number.isFinite(minScore)) {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "minScore must be a number" } });
  }
  // Dealerships are filtered out by default; ?includeDealers=1 is for auditing
  // the filter, not for browsing.
  const includeDealers = req.query.includeDealers === "1" || req.query.includeDealers === "true";
  try {
    const { rankedOpportunities } = await import("../db/repo.mjs");
    const rows = await rankedOpportunities({ limit, minScore, includeDealers });
    res.json({ count: rows.length, items: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
