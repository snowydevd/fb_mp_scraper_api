/** HTTP entry point. The app itself is built in app.mjs, side-effect free. */
import { createApp } from "./app.mjs";
import { config } from "./config.mjs";
import { closeBrowser } from "./services/scraper.mjs";

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  await closeBrowser().catch(() => {});
  if (config.db.url) {
    const { closePool } = await import("./db/repo.mjs");
    await closePool().catch(() => {});
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
