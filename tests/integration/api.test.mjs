/**
 * The read paths, end to end: Postgres -> repo -> Express -> JSON.
 *
 * Seeded through the repo rather than raw SQL, so a schema change that breaks
 * the writer breaks these too. Skipped unless TEST_DATABASE_URL is set; see
 * tests/integration/repo.test.mjs for how to start one.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const opts = DB ? {} : { skip: "TEST_DATABASE_URL is not set" };

let server;
let base;
let repo;

before(async () => {
  if (!DB) return;
  process.env.DATABASE_URL = DB;
  repo = await import("../../src/db/repo.mjs");
  const pool = repo.getPool();
  await pool.query(`DROP TABLE IF EXISTS contact_queue, listing_scores, reference_prices,
                    raw_snapshots, sellers, price_history, listings CASCADE`);
  await repo.migrate();

  await repo.upsertListings([
    {
      id: "300000000000001", title: "Nissan March 2015", price: 7200, priceLabel: "US$7200",
      currency: "USD", currencyResolved: "USD", currencyConfidence: "high", oldPrice: 7600,
      city: "Montevideo", state: "Montevideo", url: "https://fb/1", thumbnail: null,
      categoryId: "807311116002614", sellerId: "private-1",
      createdAt: "2026-07-01T00:00:00Z", isSold: false,
    },
    {
      id: "300000000000002", title: "Fiat uno way NOAHCARS", price: 5990, priceLabel: "US$5990",
      currency: "USD", currencyResolved: "USD", currencyConfidence: "high", oldPrice: null,
      city: "Montevideo", state: "Montevideo", url: "https://fb/2", thumbnail: null,
      categoryId: "807311116002614", sellerId: "dealer-1",
      createdAt: "2026-08-01T00:00:00Z", isSold: false,
    },
  ]);
  await repo.updateDetail("300000000000001", { make: "Nissan", model: "March", vehicleYear: 2015, mileageKm: 57_000, isDealer: false });
  await repo.updateDetail("300000000000002", { make: "Fiat", model: "Uno", vehicleYear: 2015, isDealer: true, dealerScore: 2.55, dealerReasons: ["gestoría"] });
  await repo.saveScore({ listingId: "300000000000001", score: 0.42, version: "v2", breakdown: { price: { value: 0.7, weight: 0.38 } } });
  await repo.saveScore({ listingId: "300000000000002", score: 0.88, version: "v2", breakdown: { price: { value: 1, weight: 0.38 } } });
  await repo.enqueueContact({
    listingId: "300000000000001", suggestedOffer: 6900, currency: "USD",
    rationale: { asking: 7200, marketMedian: 8400, anchoredTo: "market_median" },
    messageDraft: "Hola, buenas. Me interesa Nissan March 2015.",
  });

  const { createApp } = await import("../../src/app.mjs");
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (repo) await repo.closePool();
});

const get = async (path) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};

test("/health reports what is actually configured", opts, async () => {
  const { status, body } = await get("/health");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.database, "configured");
});

test("an unknown route returns the documented error envelope, not Express HTML", opts, async () => {
  const { status, body } = await get("/api/definitely-not-a-route");
  assert.equal(status, 404);
  assert.equal(body.error.code, "NOT_FOUND");
});

// Verified failing before the fix: a malformed body returned the full stack
// trace, absolute filesystem paths included, to any caller.
test("a malformed JSON body never leaks a stack trace or a filesystem path", opts, async () => {
  const res = await fetch(`${base}/api/contact-queue/1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "{bad",
  });
  const text = await res.text();
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(text).error.code, "BAD_REQUEST");
  assert.ok(!text.includes("/home/"), "no filesystem path in the response");
  assert.ok(!text.includes("at "), "no stack frames in the response");
});

test("the ranking hides the dealership even though it scores highest", opts, async () => {
  const { status, body } = await get("/api/opportunities");
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.items[0].id, "300000000000001");
  assert.ok(body.items[0].breakdown.price, "the breakdown survives so the rank can be explained");
  assert.equal(body.items[0].contact_status, "pending", "the ranking shows where a listing already sits in the queue");
});

test("includeDealers is how the filter gets audited", opts, async () => {
  const { body } = await get("/api/opportunities?includeDealers=1");
  assert.equal(body.count, 2);
  assert.equal(body.items[0].id, "300000000000002", "and it does rank first, which is the whole problem");
  assert.equal(body.items[0].is_dealer, true);
});

test("minScore filters and is validated", opts, async () => {
  assert.equal((await get("/api/opportunities?minScore=0.5")).body.count, 0);
  const bad = await get("/api/opportunities?minScore=mucho");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "BAD_REQUEST");
});

test("the contact queue serves pending drafts", opts, async () => {
  const { status, body } = await get("/api/contact-queue");
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.items[0].status, "pending");
  assert.equal(Number(body.items[0].suggested_offer), 6900);
  assert.match(body.items[0].message_draft, /Me interesa/);
});

test("a status outside the vocabulary is rejected at the edge", opts, async () => {
  const { body: queue } = await get("/api/contact-queue");
  const id = queue.items[0].id;
  const res = await fetch(`${base}/api/contact-queue/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "enviado" }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "BAD_REQUEST");
});

test("approving a draft is a human action the API records", opts, async () => {
  const { body: queue } = await get("/api/contact-queue");
  const id = queue.items[0].id;
  const res = await fetch(`${base}/api/contact-queue/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).item.status, "approved");

  assert.equal((await get("/api/contact-queue")).body.count, 0, "no longer pending");
  assert.equal((await get("/api/contact-queue?status=approved")).body.count, 1);
  assert.equal((await get("/api/contact-queue?status=all")).body.count, 1);
});

test("patching an entry that does not exist is a 404, not a 500", opts, async () => {
  const res = await fetch(`${base}/api/contact-queue/999999`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "discarded" }),
  });
  assert.equal(res.status, 404);
});
