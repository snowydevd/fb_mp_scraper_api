/**
 * Fase 2's missing half: the worker on a schedule.
 *
 * `npm run worker` was manual-only, so nothing ever accumulated - and the whole
 * point of persistence is the history. staleness_score and price_change_count
 * are worth nothing without runs spread over days.
 *
 * The politeness rules from docs/claude-prompt.md are enforced HERE, not just
 * inside the browser layer:
 *   - a randomised interval, because a run every 6h on the dot is a signature
 *   - an active-hours window, because "no correr 24/7" was explicit
 *   - one run at a time, so a slow run can never overlap the next
 *   - the session listing budget reset per run, never per process
 *
 * Run:  node src/worker/scheduler.mjs
 *       node src/worker/scheduler.mjs --dry        (no writes; still scrapes)
 *       node src/worker/scheduler.mjs --now=false  (wait for the first tick)
 */
import { config } from "../config.mjs";
import { runSync, DEFAULT_FILTERS } from "./sync.mjs";
import { closeBrowser, resetBudget, log } from "../services/marketplace/browser.mjs";

export const SCHEDULE = {
  intervalHours: Number(process.env.WORKER_INTERVAL_HOURS ?? 6),
  /** ±jitter applied to every interval so runs never land on a fixed clock. */
  jitterPct: Number(process.env.WORKER_JITTER_PCT ?? 0.2),
  /** Local hours (America/Montevideo) the worker is allowed to run in. */
  activeHours: process.env.WORKER_ACTIVE_HOURS ?? "9-22",
  timeZone: process.env.WORKER_TIMEZONE ?? "America/Montevideo",
};

export function parseActiveHours(spec) {
  const m = String(spec).match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) throw new Error(`WORKER_ACTIVE_HOURS must look like "9-22", got "${spec}"`);
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from > 23 || to > 24 || from >= to) throw new Error(`invalid active-hours window "${spec}"`);
  return { from, to };
}

/** The hour of day at `date` in the configured timezone. */
export function localHour(date, timeZone = SCHEDULE.timeZone) {
  return Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone }).format(date)
  );
}

export function isWithinActiveHours(date, spec = SCHEDULE.activeHours, timeZone = SCHEDULE.timeZone) {
  const { from, to } = parseActiveHours(spec);
  const h = localHour(date, timeZone);
  return h >= from && h < to;
}

/** Interval in ms with jitter applied, so consecutive runs are never evenly spaced. */
export function nextIntervalMs({ intervalHours, jitterPct } = SCHEDULE, random = Math.random) {
  const base = intervalHours * 3_600_000;
  const spread = base * jitterPct;
  return Math.max(60_000, Math.round(base - spread + random() * spread * 2));
}

/**
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @param {number|null} opts.maxRuns  stop after N runs (tests; null = forever)
 */
export async function startScheduler({ dryRun = false, runNow = true, maxRuns = null, filters = DEFAULT_FILTERS } = {}) {
  if (!dryRun && !config.db.url) {
    throw new Error("DATABASE_URL is not set - a scheduled worker with nothing to write to is pointless");
  }
  parseActiveHours(SCHEDULE.activeHours); // fail fast on a bad window

  let timer = null;
  let running = false;
  let runs = 0;
  let stopped = false;

  const stop = async (reason) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    log("info", `scheduler stopping (${reason})`);
    await closeBrowser().catch(() => {});
  };

  const schedule = (ms) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref?.();
    log("info", `next check in ${(ms / 60_000).toFixed(1)} min`);
  };

  async function tick() {
    if (stopped) return;
    // A run that overran its own interval must never get a second one on top.
    if (running) {
      log("info", "previous run still in flight, skipping this tick");
      return schedule(nextIntervalMs());
    }
    if (!isWithinActiveHours(new Date())) {
      log("info", `outside the active window (${SCHEDULE.activeHours} ${SCHEDULE.timeZone}), skipping`);
      // Re-check on a short cycle rather than sleeping until morning, so a
      // config change or a restart does not lose most of a day.
      return schedule(Math.min(nextIntervalMs(), 30 * 60_000));
    }

    running = true;
    // Per RUN, not per process: the budget is a rate limit, not a lifetime cap.
    resetBudget();
    try {
      const { summary } = await runSync({ dryRun, filters });
      runs++;
      log("info", `run ${runs} done`, summary);
    } catch (err) {
      // A failed run is normal (session expired, captcha, Facebook changed a
      // selector). It must never take the scheduler down with it.
      log("error", `run failed: ${err.message}`);
    } finally {
      running = false;
      // The browser is closed between runs: holding a Chromium idle for hours
      // is both wasteful and a longer-lived fingerprint than we need.
      await closeBrowser().catch(() => {});
    }

    if (maxRuns != null && runs >= maxRuns) return stop(`reached maxRuns=${maxRuns}`);
    schedule(nextIntervalMs());
  }

  log("info", `scheduler start: every ~${SCHEDULE.intervalHours}h ±${SCHEDULE.jitterPct * 100}%, ` +
    `active ${SCHEDULE.activeHours} ${SCHEDULE.timeZone}, dry=${dryRun}`);

  if (runNow) await tick();
  else schedule(nextIntervalMs());

  return { stop, runsCompleted: () => runs };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry");
  const runNow = !process.argv.includes("--now=false");
  const scheduler = await startScheduler({ dryRun, runNow }).catch((err) => {
    console.error("[scheduler] failed to start:", err.message);
    process.exit(1);
  });
  // Keep the process alive: every timer is unref'd so the loop would otherwise
  // exit between runs.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const bye = async (sig) => {
    clearInterval(keepAlive);
    await scheduler.stop(sig);
    process.exit(0);
  };
  process.on("SIGINT", () => bye("SIGINT"));
  process.on("SIGTERM", () => bye("SIGTERM"));
}
