/**
 * The Express app, with no side effects on import.
 *
 * Kept apart from main.mjs so tests can mount it on an ephemeral port: the two
 * used to be one file that called app.listen() at module scope, so importing it
 * to test a route started a real server on the real port and left the process
 * hanging on an open handle.
 */
import express from "express";
import cors from "cors";
import marketplaceRoutes from "./routes/marketplace.mjs";
import opportunityRoutes from "./routes/opportunities.mjs";
import contactQueueRoutes from "./routes/contact-queue.mjs";
import { config } from "./config.mjs";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cors());

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      database: config.db.url ? "configured" : "absent",
      facebookSession: config.session.storageStatePath || config.session.cookies ? "configured" : "absent",
    });
  });

  app.use("/api/marketplace", marketplaceRoutes);
  app.use("/api/opportunities", opportunityRoutes);
  app.use("/api/contact-queue", contactQueueRoutes);

  // Unknown route: the documented error envelope, not Express's HTML page.
  app.use((req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: `no route for ${req.method} ${req.originalUrl}` },
    });
  });

  /**
   * Error handler. Without one, Express's default replied to a malformed JSON
   * body with the full stack trace - absolute filesystem paths and all - to any
   * caller. Everything past this point is logged in full server-side and
   * reduced to a code and a safe message on the wire.
   */
  app.use((err, req, res, _next) => {
    const malformedJson = err.type === "entity.parse.failed" || err instanceof SyntaxError;
    const status = malformedJson ? 400 : err.status && err.status < 600 ? err.status : 500;
    console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
    if (res.headersSent) return;
    res.status(status).json({
      error: {
        code: malformedJson ? "BAD_REQUEST" : status === 500 ? "INTERNAL" : "REQUEST_FAILED",
        message: malformedJson
          ? "request body is not valid JSON"
          : status === 500
            ? "internal server error"   // never the stack, never a filesystem path
            : err.message,
      },
    });
  });

  return app;
}

export default createApp;
