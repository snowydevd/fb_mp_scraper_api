/**
 * Fase 6: the contact queue, for review by a human.
 *
 * Nothing in this file sends a message. Automated Messenger outreach is the
 * fastest way to lose the account and a generic message converts badly, so the
 * only writes exposed here are the status transitions a person performs after
 * reading a draft.
 */
import { Router } from "express";
import { config } from "../config.mjs";

const router = Router();
const STATUSES = ["pending", "approved", "discarded", "sent"];

function requireDb(res) {
  if (config.db.url) return true;
  res.status(503).json({
    error: { code: "NO_DATABASE", message: "DATABASE_URL is not configured; the contact queue lives in Postgres" },
  });
  return false;
}

router.get("/", async (req, res, next) => {
  if (!requireDb(res)) return;
  const status = req.query.status == null || req.query.status === "" ? "pending" : String(req.query.status);
  if (status !== "all" && !STATUSES.includes(status)) {
    return res.status(400).json({
      error: { code: "BAD_REQUEST", message: `status must be one of ${STATUSES.join(", ")} or "all"` },
    });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const { listContactQueue } = await import("../db/repo.mjs");
    const rows = await listContactQueue({ status: status === "all" ? null : status, limit });
    res.json({ count: rows.length, items: rows });
  } catch (err) {
    next(err);
  }
});

/** Manual approval / discard / mark-as-sent. The human is the only writer. */
router.patch("/:id", async (req, res, next) => {
  if (!requireDb(res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "id must be a positive integer" } });
  }
  const status = req.body?.status;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({
      error: { code: "BAD_REQUEST", message: `status must be one of ${STATUSES.join(", ")}` },
    });
  }
  try {
    const { setContactStatus } = await import("../db/repo.mjs");
    const row = await setContactStatus(id, status);
    if (!row) return res.status(404).json({ error: { code: "NOT_FOUND", message: `no contact_queue entry ${id}` } });
    res.json({ item: row });
  } catch (err) {
    next(err);
  }
});

export default router;
