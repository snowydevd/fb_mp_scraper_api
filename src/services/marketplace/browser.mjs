/**
 * Browser lifecycle, Facebook session, concurrency and politeness.
 *
 * One browser per process, one fresh context per navigation. Every navigation
 * goes through `withPoliteSlot`, which enforces both a concurrency cap and a
 * randomised delay - the previous code had a concurrency cap only, so two
 * scrapes could fire back-to-back with no pause at all.
 */
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { config } from "../../config.mjs";

const { scraper, session } = config;

export function log(level, msg, extra) {
  const out = level === "error" ? console.error : console.log;
  out(`[mp] ${new Date().toISOString()} ${level.toUpperCase()} ${msg}`, extra ?? "");
}

let browserPromise = null;

export async function getBrowser() {
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
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  await p.then((b) => b.close()).catch(() => {});
}

// --- session -------------------------------------------------------------

function sessionConfig() {
  if (session.storageStatePath) {
    return { kind: "storageState", storageState: session.storageStatePath };
  }
  if (session.cookies) {
    const cookies = session.cookies
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 1) return null;
        return {
          name: pair.slice(0, eq).trim(),
          value: pair.slice(eq + 1).trim(),
          domain: ".facebook.com",
          path: "/",
          secure: true,
          sameSite: "None",
        };
      })
      .filter(Boolean);
    if (cookies.length) return { kind: "cookies", cookies };
  }
  return { kind: "none" };
}

export async function newSessionContext(browser) {
  const s = sessionConfig();
  const options = { locale: "es-ES", timezoneId: "America/Montevideo" };
  if (s.kind === "storageState") options.storageState = s.storageState;
  const context = await browser.newContext(options);
  if (s.kind === "cookies") await context.addCookies(s.cookies);
  return { context, hasSession: s.kind !== "none" };
}

/**
 * Persist the (possibly refreshed) session so a rotation Facebook performs
 * mid-run survives the context closing. Best-effort: never fails a scrape.
 */
export async function persistSession(context) {
  if (!session.persistStatePath) return false;
  try {
    const state = await context.storageState();
    await writeFile(session.persistStatePath, JSON.stringify(state), "utf8");
    return true;
  } catch (err) {
    log("error", `could not persist session state: ${err.message}`);
    return false;
  }
}

// --- politeness ----------------------------------------------------------

let activeSlots = 0;
const slotQueue = [];
let listingsThisRun = 0;

export class BudgetExceededError extends Error {
  constructor(budget) {
    super(`session listing budget of ${budget} reached - stop and resume later`);
    this.name = "BudgetExceededError";
    this.code = "BUDGET_EXCEEDED";
  }
}

export function countListings(n) {
  listingsThisRun += n;
}
export function listingsUsed() {
  return listingsThisRun;
}
export function resetBudget() {
  listingsThisRun = 0;
}
export function assertBudget() {
  if (listingsThisRun >= scraper.sessionListingBudget) {
    throw new BudgetExceededError(scraper.sessionListingBudget);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Uniform jitter in [minDelayMs, maxDelayMs]. */
export function nextDelayMs() {
  const { minDelayMs, maxDelayMs } = scraper;
  if (maxDelayMs <= minDelayMs) return minDelayMs;
  return minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
}

/**
 * Run `fn` under the concurrency cap, after a randomised pause and a budget
 * check. `skipDelay` exists only for tests.
 */
export async function withPoliteSlot(fn, { skipDelay = false } = {}) {
  assertBudget();
  if (activeSlots >= scraper.maxConcurrency) {
    await new Promise((resolve) => slotQueue.push(resolve));
  }
  activeSlots++;
  try {
    if (!skipDelay) {
      const ms = nextDelayMs();
      log("info", `waiting ${(ms / 1000).toFixed(1)}s before next request`);
      await sleep(ms);
    }
    return await fn();
  } finally {
    activeSlots--;
    const next = slotQueue.shift();
    if (next) next();
  }
}
