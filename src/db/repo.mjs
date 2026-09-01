/**
 * Postgres access layer. Every write is idempotent so the worker can re-run a
 * window without duplicating rows.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.mjs";

let pool = null;

export function getPool() {
  if (!config.db.url) {
    throw new Error("DATABASE_URL is not set - persistence is disabled");
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.db.url,
      max: 8,
      idleTimeoutMillis: 30_000,
      // Supabase's pooled endpoint requires TLS but serves a non-local CA.
      ssl: /supabase|neon|render/i.test(config.db.url) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
}

export async function migrate() {
  const sql = await readFile(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  await getPool().query(sql);
  return true;
}

/**
 * Upsert a batch of listings.
 *
 * `price` and `currency` are written apart and never converted. A row is added
 * to price_history only when the price actually moved since the last recorded
 * observation, so "two price drops" stays a meaningful count.
 */
export async function upsertListings(items) {
  if (!items.length) return { inserted: 0, updated: 0, priceChanges: 0 };
  const client = await getPool().connect();
  let inserted = 0;
  let updated = 0;
  let priceChanges = 0;

  try {
    await client.query("BEGIN");
    for (const it of items) {
      const prev = await client.query(
        "SELECT price, currency_resolved FROM listings WHERE id = $1",
        [it.id]
      );

      const res = await client.query(
        `INSERT INTO listings (
           id, title, price, price_label, currency_reported, currency_resolved,
           currency_confidence, old_price, city, state, url, thumbnail,
           category_id, seller_id, listed_at, is_active, is_sold, last_seen_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,$16,now())
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           price = EXCLUDED.price,
           price_label = EXCLUDED.price_label,
           currency_reported = EXCLUDED.currency_reported,
           currency_resolved = EXCLUDED.currency_resolved,
           currency_confidence = EXCLUDED.currency_confidence,
           old_price = EXCLUDED.old_price,
           thumbnail = EXCLUDED.thumbnail,
           seller_id = COALESCE(EXCLUDED.seller_id, listings.seller_id),
           is_active = true,
           is_sold = EXCLUDED.is_sold,
           last_seen_at = now()
         RETURNING (xmax = 0) AS is_insert`,
        [
          it.id, it.title, it.price, it.priceLabel, it.currency, it.currencyResolved,
          it.currencyConfidence, it.oldPrice, it.city, it.state, it.url, it.thumbnail,
          it.categoryId, it.sellerId, it.createdAt, it.isSold,
        ]
      );
      if (res.rows[0]?.is_insert) inserted++;
      else updated++;

      const prevPrice = prev.rows[0] ? Number(prev.rows[0].price) : null;
      if (it.price != null && prevPrice !== Number(it.price)) {
        await client.query(
          "INSERT INTO price_history (listing_id, price, currency) VALUES ($1,$2,$3)",
          [it.id, it.price, it.currencyResolved]
        );
        if (prevPrice != null) priceChanges++;
      }

      if (it.sellerId) {
        await client.query(
          `INSERT INTO sellers (seller_id) VALUES ($1)
           ON CONFLICT (seller_id) DO UPDATE SET last_seen_at = now()`,
          [it.sellerId]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { inserted, updated, priceChanges };
}

/**
 * Mark listings that stopped appearing as inactive. Scoped to the ids the run
 * actually covered, so a Montevideo run never deactivates Canelones rows.
 */
export async function markMissingInactive(seenIds, { city = null, olderThanHours = 24 } = {}) {
  const res = await getPool().query(
    `UPDATE listings SET is_active = false
      WHERE is_active = true
        AND NOT (id = ANY($1::text[]))
        AND last_seen_at < now() - ($2 || ' hours')::interval
        AND ($3::text IS NULL OR city = $3)
      RETURNING id`,
    [seenIds, String(olderThanHours), city]
  );
  return res.rowCount;
}

export async function saveSnapshot({ runId, sourceUrl, filters, payload, itemCount }) {
  await getPool().query(
    `INSERT INTO raw_snapshots (run_id, source_url, filters, payload, item_count)
     VALUES ($1,$2,$3,$4,$5)`,
    [runId, sourceUrl, JSON.stringify(filters ?? {}), JSON.stringify(payload), itemCount]
  );
}

// --- reference prices ----------------------------------------------------

export async function getFreshReference({ make, model, yearFrom, yearTo, currency, source }) {
  const res = await getPool().query(
    `SELECT * FROM reference_prices
      WHERE make=$1 AND model=$2 AND year_from=$3 AND year_to=$4 AND currency=$5 AND source=$6
        AND expires_at > now()`,
    [make, model, yearFrom, yearTo, currency, source]
  );
  return res.rows[0] ?? null;
}

export async function saveReference(ref) {
  const res = await getPool().query(
    `INSERT INTO reference_prices
       (make, model, year_from, year_to, currency, median_price, p10_price, p90_price,
        sample_size, source, is_reliable, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (make, model, year_from, year_to, currency, source) DO UPDATE SET
       median_price=EXCLUDED.median_price, p10_price=EXCLUDED.p10_price,
       p90_price=EXCLUDED.p90_price, sample_size=EXCLUDED.sample_size,
       is_reliable=EXCLUDED.is_reliable, computed_at=now(), expires_at=EXCLUDED.expires_at
     RETURNING *`,
    [ref.make, ref.model, ref.yearFrom, ref.yearTo, ref.currency, ref.median,
     ref.p10, ref.p90, ref.sampleSize, ref.source, ref.isReliable, ref.expiresAt]
  );
  return res.rows[0];
}

// --- scoring / reads -----------------------------------------------------

export async function saveScore({ listingId, score, version, breakdown, referenceId = null }) {
  await getPool().query(
    `INSERT INTO listing_scores (listing_id, score, version, breakdown, reference_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (listing_id) DO UPDATE SET
       score=EXCLUDED.score, version=EXCLUDED.version, breakdown=EXCLUDED.breakdown,
       reference_id=EXCLUDED.reference_id, scored_at=now()`,
    [listingId, score, version, JSON.stringify(breakdown), referenceId]
  );
}

/** Listings enriched with everything the scorer needs, for a scoring pass. */
export async function listActiveForScoring({ limit = 500 } = {}) {
  const res = await getPool().query(
    `SELECT l.*,
            (SELECT count(*) FROM price_history p
              WHERE p.listing_id = l.id) - 1            AS price_change_count,
            (SELECT count(*) FROM listings s
              WHERE s.seller_id = l.seller_id AND s.is_active) AS seller_active_count
       FROM listings l
      WHERE l.is_active = true
      ORDER BY l.last_seen_at DESC
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function rankedOpportunities({ limit = 50, minScore = null } = {}) {
  const res = await getPool().query(
    `SELECT l.id, l.title, l.price, l.currency_resolved, l.city, l.url, l.listed_at,
            l.mileage_km, l.vehicle_year, l.make, l.model,
            s.score, s.version, s.breakdown, s.scored_at
       FROM listing_scores s
       JOIN listings l ON l.id = s.listing_id
      WHERE l.is_active = true AND ($2::numeric IS NULL OR s.score >= $2)
      ORDER BY s.score DESC
      LIMIT $1`,
    [limit, minScore]
  );
  return res.rows;
}

export async function countActiveBySeller(sellerId) {
  if (!sellerId) return 0;
  const res = await getPool().query(
    "SELECT count(*)::int AS n FROM listings WHERE seller_id = $1 AND is_active = true",
    [sellerId]
  );
  return res.rows[0].n;
}
