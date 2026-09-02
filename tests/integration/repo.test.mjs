/**
 * Persistence, against a real Postgres.
 *
 * The whole db layer had never been executed once: the SQL had only been read
 * by eye. These tests are the runtime evidence - migrate, upsert, price
 * history, detail write-back, the contact queue's human-owned status, and the
 * ranking's dealer exclusion.
 *
 * They are SKIPPED unless TEST_DATABASE_URL is set, so `npm test` on a machine
 * without Postgres stays green. To run them:
 *
 *   docker run -d --name fbmp-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=fbmp \
 *     -p 55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:dev@localhost:55432/fbmp npm run test:integration
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const opts = DB ? {} : { skip: "TEST_DATABASE_URL is not set" };

let repo;
let pool;

before(async () => {
  if (!DB) return;
  process.env.DATABASE_URL = DB;
  repo = await import("../../src/db/repo.mjs");
  pool = repo.getPool();
  // A clean slate per run, so re-running never depends on the previous state.
  await pool.query(`DROP TABLE IF EXISTS contact_queue, listing_scores, reference_prices,
                    raw_snapshots, sellers, price_history, listings CASCADE`);
  await repo.migrate();
});

after(async () => {
  if (repo) await repo.closePool();
});

const listing = (over = {}) => ({
  id: "100000000000001",
  title: "Chevrolet Corsa 2008",
  price: 6500,
  priceLabel: "6500 US$",
  currency: "USD",
  currencyResolved: "USD",
  currencyConfidence: "high",
  oldPrice: null,
  city: "Montevideo",
  state: "Montevideo",
  url: "https://www.facebook.com/marketplace/item/100000000000001/",
  thumbnail: null,
  categoryId: "807311116002614",
  sellerId: "seller-a",
  createdAt: new Date("2026-08-01T12:00:00Z").toISOString(),
  isSold: false,
  ...over,
});

test("migrate is idempotent", opts, async () => {
  assert.equal(await repo.migrate(), true);
  assert.equal(await repo.migrate(), true, "re-running the schema must not throw");
});

test("upsertListings inserts, then updates without duplicating", opts, async () => {
  const first = await repo.upsertListings([listing()]);
  assert.deepEqual(first, { inserted: 1, updated: 0, priceChanges: 0 });

  const second = await repo.upsertListings([listing()]);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 1);

  const { rows } = await pool.query("SELECT count(*)::int n FROM listings");
  assert.equal(rows[0].n, 1);
});

test("price_history records a change only when the price actually moved", opts, async () => {
  const before = await pool.query("SELECT count(*)::int n FROM price_history WHERE listing_id = $1", ["100000000000001"]);
  await repo.upsertListings([listing()]);            // same price
  const same = await pool.query("SELECT count(*)::int n FROM price_history WHERE listing_id = $1", ["100000000000001"]);
  assert.equal(same.rows[0].n, before.rows[0].n, "an unchanged price must not add a row");

  const moved = await repo.upsertListings([listing({ price: 6200 })]);
  assert.equal(moved.priceChanges, 1);
  const after2 = await pool.query(
    "SELECT price, currency FROM price_history WHERE listing_id = $1 ORDER BY observed_at DESC LIMIT 1",
    ["100000000000001"]
  );
  assert.equal(Number(after2.rows[0].price), 6200);
  assert.equal(after2.rows[0].currency, "USD", "currency is stored alongside, never normalised away");
});

test("updateDetail writes back what the detail fetch cost us", opts, async () => {
  const ok = await repo.updateDetail("100000000000001", {
    description: "Único dueño, papeles al día",
    mileageKm: 143_000,
    mileageSource: "attribute",
    vehicleYear: 2008,
    make: "Chevrolet",
    model: "Corsa",
    sellerType: "PRIVATE_SELLER",
    sellerId: "seller-a",
    isDealer: false,
    dealerScore: 0,
    dealerReasons: [],
  });
  assert.equal(ok, true);

  const { rows } = await pool.query(
    "SELECT description, mileage_km, vehicle_year, make, model, is_dealer, detail_fetched_at FROM listings WHERE id = $1",
    ["100000000000001"]
  );
  assert.equal(rows[0].mileage_km, 143_000);
  assert.equal(rows[0].make, "Chevrolet");
  assert.equal(rows[0].is_dealer, false);
  assert.ok(rows[0].detail_fetched_at, "detail_fetched_at is what stops us re-opening the page");
});

test("a later grid upsert does not erase the detail we already paid for", opts, async () => {
  await repo.upsertListings([listing()]);
  const { rows } = await pool.query("SELECT description, mileage_km FROM listings WHERE id = $1", ["100000000000001"]);
  assert.equal(rows[0].mileage_km, 143_000);
  assert.ok(rows[0].description);
});

test("saveScore keeps one current score per listing, with its breakdown", opts, async () => {
  await repo.saveScore({ listingId: "100000000000001", score: 0.31, version: "v1", breakdown: { price: { value: 1 } } });
  await repo.saveScore({ listingId: "100000000000001", score: 0.47, version: "v2", breakdown: { price: { value: 1 }, seller: { value: 0.1 } } });
  const { rows } = await pool.query("SELECT score, version, breakdown FROM listing_scores WHERE listing_id = $1", ["100000000000001"]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].score), 0.47);
  assert.equal(rows[0].version, "v2");
  assert.ok(rows[0].breakdown.seller, "the breakdown survives the round trip as jsonb");
});

test("the contact queue is owned by a human: the worker cannot overwrite a decision", opts, async () => {
  const entry = {
    listingId: "100000000000001",
    facts: { price: 6200, currency: "USD", mileageKm: 143_000, declaredDebt: null },
    messageDraft: "Hola, buenas.",
  };
  const first = await repo.enqueueContact(entry);
  assert.deepEqual({ written: first.written, inserted: first.inserted }, { written: true, inserted: true });

  const refreshed = await repo.enqueueContact({ ...entry, facts: { ...entry.facts, price: 6000 } });
  assert.equal(refreshed.written, true, "a pending draft may be refreshed");

  const approved = await repo.setContactStatus(first.id, "approved");
  assert.equal(approved.status, "approved");

  const blocked = await repo.enqueueContact({ ...entry, facts: { ...entry.facts, price: 1 } });
  assert.equal(blocked.written, false, "an approved draft must not change under whoever is about to send it");

  const { rows } = await pool.query("SELECT facts, status FROM contact_queue WHERE listing_id = $1", ["100000000000001"]);
  assert.equal(rows[0].facts.price, 6000, "el refresh previo a la aprobación sí quedó");
  assert.equal(rows[0].status, "approved");
});

test("setContactStatus refuses a status outside the vocabulary", opts, async () => {
  await assert.rejects(() => repo.setContactStatus(1, "enviado"), /unknown contact status/);
});

test("markMissingInactive only touches what the run actually covered", opts, async () => {
  await repo.upsertListings([listing({ id: "100000000000002", sellerId: "seller-b", url: "https://x/2" })]);
  // Backdate both so they are older than the grace window.
  await pool.query("UPDATE listings SET last_seen_at = now() - interval '48 hours'");

  const n = await repo.markMissingInactive(["100000000000001"], { city: null });
  assert.equal(n, 1, "only the id missing from the run is deactivated");
  const { rows } = await pool.query("SELECT id, is_active FROM listings ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.id, r.is_active]), [
    ["100000000000001", true],
    ["100000000000002", false],
  ]);
});

test("countActiveBySeller is what the dealer heuristic reads", opts, async () => {
  await repo.upsertListings([
    listing({ id: "100000000000003", sellerId: "dealer-x", url: "https://x/3" }),
    listing({ id: "100000000000004", sellerId: "dealer-x", url: "https://x/4" }),
    listing({ id: "100000000000005", sellerId: "dealer-x", url: "https://x/5" }),
  ]);
  assert.equal(await repo.countActiveBySeller("dealer-x"), 3);
  assert.equal(await repo.countActiveBySeller(null), 0);
});

test("rankedOpportunities hides dealerships unless explicitly asked", opts, async () => {
  await repo.updateDetail("100000000000003", { isDealer: true, dealerScore: 2.55, dealerReasons: ["gestoría", "escribanía propia"] });
  await repo.saveScore({ listingId: "100000000000003", score: 0.9, version: "v2", breakdown: {} });

  const clean = await repo.rankedOpportunities({ limit: 10 });
  assert.ok(!clean.some((r) => r.id === "100000000000003"), "a dealership must not be served as an opportunity");

  const audited = await repo.rankedOpportunities({ limit: 10, includeDealers: true });
  const dealerRow = audited.find((r) => r.id === "100000000000003");
  assert.ok(dealerRow, "includeDealers=true is how the filter gets audited");
  assert.deepEqual(dealerRow.dealer_reasons, ["gestoría", "escribanía propia"]);
});

test("saveSnapshot stores the raw payload for re-parsing without re-scraping", opts, async () => {
  await repo.saveSnapshot({
    runId: "11111111-1111-4111-8111-111111111111",
    sourceUrl: "https://www.facebook.com/marketplace/montevideo/vehicles",
    filters: { minPrice: 5000 },
    payload: [{ id: "1", title: "x" }],
    itemCount: 1,
  });
  const { rows } = await pool.query("SELECT payload, item_count, filters FROM raw_snapshots");
  assert.equal(rows[0].item_count, 1);
  assert.equal(rows[0].payload[0].title, "x");
  assert.equal(rows[0].filters.minPrice, 5000);
});

// Supabase publishes every table in `public` through PostgREST, and the anon
// key is public by design. Tables created by SQL start with RLS OFF, so this is
// the check that the schema does not quietly ship an open contact_queue.
test("every table has RLS enabled, and none of them forces it on the owner", opts, async () => {
  const { rows } = await pool.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
      ORDER BY relname`
  );
  assert.ok(rows.length >= 6, `expected the pipeline's tables, got ${rows.length}`);
  for (const t of rows) {
    assert.equal(t.relrowsecurity, true, `${t.relname} is exposed: RLS is off`);
    // FORCE would subject the owner to the policies too - and there are none,
    // so the worker would lose its own write access.
    assert.equal(t.relforcerowsecurity, false, `${t.relname} forces RLS: the worker cannot write`);
  }
});

test("RLS with no policies denies a non-owner while the worker keeps writing", opts, async () => {
  // Stand in for Supabase's `anon`: a role that is not the table owner.
  await pool.query(`DROP ROLE IF EXISTS test_anon`);
  await pool.query(`CREATE ROLE test_anon NOLOGIN`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO test_anon`);
  await pool.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO test_anon`);

  const client = await pool.connect();
  try {
    await client.query("SET ROLE test_anon");
    const seen = await client.query("SELECT * FROM contact_queue");
    assert.equal(seen.rowCount, 0, "even with GRANT SELECT, RLS with no policy returns nothing");
    await assert.rejects(
      () => client.query("INSERT INTO sellers (seller_id) VALUES ('injected')"),
      /row-level security/i
    );
    await client.query("RESET ROLE");
  } finally {
    client.release();
  }

  // And the owner - the role the worker connects as - is unaffected.
  await repo.upsertListings([listing({ id: "100000000000009", url: "https://x/9" })]);
  const { rows } = await pool.query("SELECT count(*)::int n FROM listings WHERE id = $1", ["100000000000009"]);
  assert.equal(rows[0].n, 1);

  await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM test_anon`);
  await pool.query(`REVOKE USAGE ON SCHEMA public FROM test_anon`);
  await pool.query(`DROP ROLE IF EXISTS test_anon`);
});
