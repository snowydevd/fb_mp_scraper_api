import { test } from "node:test";
import assert from "node:assert/strict";
import { createReferenceCache } from "../../src/services/reference/cache.mjs";

const band = { make: "Chevrolet", model: "Corsa", yearFrom: 2006, yearTo: 2010, currency: "USD" };
const meliRef = { ...band, median: 6900, sampleSize: 17, source: "meli", isReliable: true, expiresAt: "2026-09-10T00:00:00Z" };

test("a repeated band costs one lookup, not one per listing", async () => {
  const cache = createReferenceCache();
  let calls = 0;
  const compute = async () => { calls++; return meliRef; };

  for (let i = 0; i < 24; i++) await cache.lookup(band, compute);
  assert.equal(calls, 1, "Fase 3: no pegarle a la API por cada listing");
  assert.equal(cache.stats.memoHits, 23);
});

test("different bands are cached separately", async () => {
  const cache = createReferenceCache();
  let calls = 0;
  const compute = async () => { calls++; return meliRef; };
  await cache.lookup(band, compute);
  await cache.lookup({ ...band, model: "Celta" }, compute);
  await cache.lookup({ ...band, currency: "UYU" }, compute);
  assert.equal(calls, 3);
});

test("a fresh database row is served without calling MercadoLibre at all", async () => {
  let computed = 0;
  const repo = {
    getFreshReference: async () => ({
      make: "Chevrolet", model: "Corsa", year_from: 2006, year_to: 2010, currency: "USD",
      median_price: "6900.00", p10_price: "5200.00", p90_price: "8800.00",
      sample_size: 17, source: "meli", is_reliable: true, expires_at: "2026-09-10T00:00:00Z",
    }),
    saveReference: async () => {},
  };
  const cache = createReferenceCache({ repo });
  const ref = await cache.lookup(band, async () => { computed++; return meliRef; });
  assert.equal(computed, 0);
  assert.equal(ref.median, 6900, "numerics come back from pg as strings and must be coerced");
  assert.equal(ref.cached, true);
  assert.equal(cache.stats.dbHits, 1);
});

test("a miss is written back so the next run skips the API", async () => {
  const saved = [];
  const repo = { getFreshReference: async () => null, saveReference: async (r) => saved.push(r) };
  const cache = createReferenceCache({ repo });
  await cache.lookup(band, async () => meliRef);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].median, 6900);
});

// The internal reference is a property of one run's batch, not of the market.
test("a batch-derived reference is never persisted as if it were market data", async () => {
  const saved = [];
  const repo = { getFreshReference: async () => null, saveReference: async (r) => saved.push(r) };
  const cache = createReferenceCache({ repo });
  await cache.lookup(band, async () => ({ ...meliRef, source: "internal" }));
  assert.equal(saved.length, 0);
});

test("a cache failure degrades to a live lookup instead of failing the run", async () => {
  const repo = {
    getFreshReference: async () => { throw new Error("connection refused"); },
    saveReference: async () => { throw new Error("connection refused"); },
  };
  const cache = createReferenceCache({ repo });
  const ref = await cache.lookup(band, async () => meliRef);
  assert.equal(ref.median, 6900);
});

test("once MercadoLibre is known to be down, the run stops asking", async () => {
  const cache = createReferenceCache();
  let calls = 0;
  const compute = async () => { calls++; throw new Error("HTTP 401"); };

  await assert.rejects(() => cache.lookup(band, compute));
  cache.markUpstreamUnavailable("HTTP 401");

  assert.equal(await cache.lookup({ ...band, model: "Celta" }, compute), null);
  assert.equal(await cache.lookup({ ...band, model: "Onix" }, compute), null);
  assert.equal(calls, 1, "wrong credentials must cost one token request, not one per listing");
  assert.equal(cache.stats.upstreamSkipped, 2);
  assert.equal(cache.upstreamUnavailable, "HTTP 401");
});
