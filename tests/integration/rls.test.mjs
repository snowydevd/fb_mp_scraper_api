/**
 * Que la base no quede publicada.
 *
 * Supabase publica por PostgREST toda tabla del schema `public`, con la anon
 * key pública por diseño. El schema pone dos candados independientes:
 *
 *   1. RLS activado sin políticas  -> PostgREST no devuelve filas
 *   2. Sin GRANT a anon/authenticated -> corta antes, con permission denied
 *
 * Este archivo simula los roles de Supabase en un Postgres común y comprueba
 * los dos, más lo único que no puede romperse: que el dueño siga escribiendo.
 *
 * Tiene su propio setup y su propio teardown porque crea roles y toca DEFAULT
 * PRIVILEGES; corre en serie con el resto (--test-concurrency=1).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SUPABASE_ROLES = ["anon", "authenticated"];

let repo;
let pool;
let skip = DB ? false : "TEST_DATABASE_URL is not set";

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = DB;
  repo = await import("../../src/db/repo.mjs");
  pool = repo.getPool();
  await pool.query(`DROP TABLE IF EXISTS contact_queue, listing_scores, reference_prices,
                    raw_snapshots, sellers, price_history, listings CASCADE`);
  try {
    for (const r of SUPABASE_ROLES) {
      await pool.query(`DROP ROLE IF EXISTS ${r}`);
      await pool.query(`CREATE ROLE ${r} NOLOGIN`);
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${r}`);
      // Exactamente lo que hace Supabase con "expose new tables" prendido: las
      // tablas que cree migrate() nacerían con permiso para PostgREST.
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${r}`);
    }
  } catch (err) {
    // Sin permiso para crear roles no se puede simular Supabase.
    skip = `no se pudieron crear los roles de Supabase: ${err.message}`;
    return;
  }
  await repo.migrate();
});

after(async () => {
  if (!pool) return;
  for (const r of SUPABASE_ROLES) {
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${r}`).catch(() => {});
    await pool.query(`REVOKE USAGE ON SCHEMA public FROM ${r}`).catch(() => {});
    await pool.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
  }
  await repo.closePool();
});

const opts = () => (skip ? { skip } : {});

test("migrate le saca a anon/authenticated el permiso que Supabase les da solo", opts(), async () => {
  const { rows } = await pool.query(
    `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee = ANY($1::text[])`,
    [SUPABASE_ROLES]
  );
  assert.deepEqual(rows, [], `la Data API todavía ve: ${JSON.stringify(rows.slice(0, 5))}`);
});

test("las tablas futuras tampoco nacen con permiso", opts(), async () => {
  await pool.query("CREATE TABLE IF NOT EXISTS tabla_nueva (id int)");
  try {
    const { rows } = await pool.query(
      `SELECT grantee FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'tabla_nueva' AND grantee = ANY($1::text[])`,
      [SUPABASE_ROLES]
    );
    assert.deepEqual(rows, [], "ALTER DEFAULT PRIVILEGES no quedó revocado");
  } finally {
    await pool.query("DROP TABLE IF EXISTS tabla_nueva");
  }
});

test("un cliente de la Data API no puede leer la cola de contacto", opts(), async () => {
  const client = await pool.connect();
  try {
    await client.query("SET ROLE anon");
    await assert.rejects(
      () => client.query("SELECT * FROM contact_queue"),
      /permission denied/i,
      "corta en el GRANT, sin llegar a RLS"
    );
    await assert.rejects(() => client.query("SELECT * FROM listings"), /permission denied/i);
    await client.query("RESET ROLE");
  } finally {
    client.release();
  }
});

test("y aunque alguien le devuelva el GRANT, RLS lo sigue frenando", opts(), async () => {
  // El segundo candado, probado solo: es lo que queda si alguien prende
  // "expose new tables" a mano después de un migrate.
  await pool.query("GRANT SELECT, INSERT ON contact_queue, sellers TO anon");
  const client = await pool.connect();
  try {
    await client.query("SET ROLE anon");
    const res = await client.query("SELECT * FROM contact_queue");
    assert.equal(res.rowCount, 0, "RLS sin políticas no devuelve filas");
    await assert.rejects(
      () => client.query("INSERT INTO sellers (seller_id) VALUES ('inyectado')"),
      /row-level security/i
    );
    await client.query("RESET ROLE");
  } finally {
    client.release();
    await pool.query("REVOKE ALL ON contact_queue, sellers FROM anon");
  }
});

test("el worker, que es el dueño, no se ve afectado por nada de esto", opts(), async () => {
  const stats = await repo.upsertListings([{
    id: "400000000000001", title: "Nissan March 2015", price: 7200, priceLabel: "US$7200",
    currency: "USD", currencyResolved: "USD", currencyConfidence: "high", oldPrice: null,
    city: "Montevideo", state: "Montevideo", url: "https://fb/1", thumbnail: null,
    categoryId: null, sellerId: "s1", createdAt: null, isSold: false,
  }]);
  assert.equal(stats.inserted, 1);
  await repo.updateDetail("400000000000001", { make: "Nissan", isDealer: false });
  await repo.saveScore({ listingId: "400000000000001", score: 0.4, version: "v2", breakdown: {} });
  const written = await repo.enqueueContact({
    listingId: "400000000000001", suggestedOffer: 6900, currency: "USD",
    rationale: {}, messageDraft: "Hola",
  });
  assert.equal(written.written, true);
  assert.equal((await repo.rankedOpportunities({ limit: 5 })).length, 1);
});
