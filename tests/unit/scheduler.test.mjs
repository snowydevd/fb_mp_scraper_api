import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseActiveHours, isWithinActiveHours, nextIntervalMs, localHour,
} from "../../src/worker/scheduler.mjs";

test("parseActiveHours rejects a window that cannot be honoured", () => {
  assert.deepEqual(parseActiveHours("9-22"), { from: 9, to: 22 });
  assert.throws(() => parseActiveHours("22-9"), /invalid/);
  assert.throws(() => parseActiveHours("siempre"), /must look like/);
  assert.throws(() => parseActiveHours("9-30"), /invalid/);
});

// "no correr 24/7" was an explicit constraint, not a nicety.
test("the active window is evaluated in Montevideo time, not UTC", () => {
  // 03:00 UTC is midnight in Montevideo (UTC-3): outside a 9-22 window.
  const night = new Date("2026-09-02T03:00:00Z");
  assert.equal(localHour(night, "America/Montevideo"), 0);
  assert.equal(isWithinActiveHours(night, "9-22", "America/Montevideo"), false);

  const afternoon = new Date("2026-09-02T18:00:00Z"); // 15:00 local
  assert.equal(isWithinActiveHours(afternoon, "9-22", "America/Montevideo"), true);
});

test("the window is half-open, so the closing hour is already outside", () => {
  const at22 = new Date("2026-09-03T01:00:00Z"); // 22:00 local
  assert.equal(localHour(at22, "America/Montevideo"), 22);
  assert.equal(isWithinActiveHours(at22, "9-22", "America/Montevideo"), false);
});

// A run every 6h on the dot is a trivially detectable signature.
test("the interval is jittered, never a fixed clock", () => {
  const cfg = { intervalHours: 6, jitterPct: 0.2 };
  const base = 6 * 3_600_000;
  assert.equal(nextIntervalMs(cfg, () => 0), base * 0.8);
  assert.equal(nextIntervalMs(cfg, () => 1), base * 1.2);
  assert.equal(nextIntervalMs(cfg, () => 0.5), base);

  const samples = new Set(Array.from({ length: 50 }, () => nextIntervalMs(cfg)));
  assert.ok(samples.size > 40, "consecutive intervals must not repeat");
});

test("the interval never collapses to a hot loop, whatever the config says", () => {
  assert.ok(nextIntervalMs({ intervalHours: 0, jitterPct: 0.9 }, () => 0) >= 60_000);
});
