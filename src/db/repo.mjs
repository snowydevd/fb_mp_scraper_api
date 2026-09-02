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

/**
 * Write back what a detail fetch found. The worker used to open detail pages -
 * paying the rate-limit cost for each one - and then drop everything it read,
 * so `/api/opportunities` served null mileage and null make forever.
 *
 * COALESCE on every field: a later run that fails to re-read the description
 * must not erase the one we already have. `detail_fetched_at` is what tells the
 * scheduler this listing does not need opening again.
 */
export async function updateDetail(listingId, detail) {
  const res = await getPool().query(
    `UPDATE listings SET
       title             = COALESCE($2, title),
       description       = COALESCE($3, description),
       mileage_km        = COALESCE($4, mileage_km),
       mileage_source    = COALESCE($5, mileage_source),
       vehicle_year      = COALESCE($6, vehicle_year),
       make              = COALESCE($7, make),
       model             = COALESCE($8, model),
       trim              = COALESCE($9, trim),
       title_status      = COALESCE($10, title_status),
       is_paid_off       = COALESCE($11, is_paid_off),
       number_of_owners  = COALESCE($12, number_of_owners),
       transmission      = COALESCE($13, transmission),
       fuel_type         = COALESCE($14, fuel_type),
       seller_type       = COALESCE($15, seller_type),
       seller_id         = COALESCE($16, seller_id),
       listed_at         = COALESCE($17, listed_at),
       is_sold           = COALESCE($18, is_sold),
       is_dealer         = COALESCE($19, is_dealer),
       dealer_score      = COALESCE($20, dealer_score),
       dealer_reasons    = COALESCE($21::jsonb, dealer_reasons),
       detail_fetched_at = now()
     WHERE id = $1
     RETURNING id`,
    [
      listingId,
      detail.title ?? null, detail.description ?? null,
      detail.mileageKm ?? null, detail.mileageSource ?? null,
      detail.vehicleYear ?? null, detail.make ?? null, detail.model ?? null,
      detail.trim ?? null, detail.titleStatus ?? null, detail.isPaidOff ?? null,
      detail.numberOfOwners ?? null, detail.transmission ?? null, detail.fuelType ?? null,
      detail.sellerType ?? null, detail.sellerId ?? null, detail.listedAt ?? null,
      detail.isSold ?? null,
      detail.isDealer ?? null,
      detail.dealerScore ?? null,
      detail.dealerReasons ? JSON.stringify(detail.dealerReasons) : null,
    ]
  );
  return res.rowCount > 0;
}

// --- contact queue (Fase 6) ----------------------------------------------

/**
 * Put a draft in the queue, or refresh one nobody has acted on yet.
 *
 * A human owns this table: once a row leaves 'pending' the worker must not
 * touch it again, or an approved draft would silently change under whoever is
 * about to send it. Nothing here sends anything.
 */
export async function enqueueContact(entry) {
  const res = await getPool().query(
    `INSERT INTO contact_queue (listing_id, facts, message_draft, status)
     VALUES ($1,$2,$3,'pending')
     ON CONFLICT (listing_id) DO UPDATE SET
       facts         = EXCLUDED.facts,
       message_draft = EXCLUDED.message_draft,
       updated_at    = now()
     WHERE contact_queue.status = 'pending'
     RETURNING id, (xmax = 0) AS is_insert`,
    [entry.listingId, JSON.stringify(entry.facts ?? {}), entry.messageDraft ?? ""]
  );
  // No row back means the conflict target existed but the WHERE blocked the
  // update: a human already approved, discarded or sent it. Leave it alone.
  if (!res.rows[0]) return { written: false, reason: "already actioned by a human" };
  return { written: true, inserted: !!res.rows[0].is_insert, id: res.rows[0].id };
}

export const CONTACT_STATUSES = ["pending", "approved", "discarded", "sent"];

export async function listContactQueue({ status = "pending", limit = 50 } = {}) {
  const res = await getPool().query(
    `SELECT q.id, q.listing_id, q.facts, q.message_draft, q.status, q.created_at, q.updated_at,
            l.title, l.price, l.currency_resolved, l.url, l.city,
            l.make, l.model, l.vehicle_year, l.mileage_km, l.is_dealer
       FROM contact_queue q
       JOIN listings l ON l.id = q.listing_id
      WHERE ($1::text IS NULL OR q.status = $1)
      ORDER BY q.created_at DESC
      LIMIT $2`,
    [status, limit]
  );
  return res.rows;
}

/** Manual approval / discard. The only writer of a non-pending status. */
export async function setContactStatus(id, status) {
  if (!CONTACT_STATUSES.includes(status)) {
    throw new Error(`unknown contact status "${status}"`);
  }
  const res = await getPool().query(
    "UPDATE contact_queue SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, status]
  );
  return res.rows[0] ?? null;
}

// --- scoring / reads -----------------------------------------------------

export async function saveScore({ listingId, score, version, breakdown }) {
  await getPool().query(
    `INSERT INTO listing_scores (listing_id, score, version, breakdown)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (listing_id) DO UPDATE SET
       score=EXCLUDED.score, version=EXCLUDED.version, breakdown=EXCLUDED.breakdown,
       scored_at=now()`,
    [listingId, score, version, JSON.stringify(breakdown)]
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

/**
 * The ranking. Dealerships are excluded by default: they are priced at retail
 * and there is no margin to negotiate, so serving them as "opportunities" only
 * costs the reader an approach. `includeDealers` exists to audit the filter,
 * not for day-to-day use.
 */
export async function rankedOpportunities({ limit = 50, minScore = null, includeDealers = false } = {}) {
  const res = await getPool().query(
    `SELECT l.id, l.title, l.price, l.currency_resolved, l.city, l.url, l.listed_at,
            l.mileage_km, l.vehicle_year, l.make, l.model, l.trim,
            l.seller_type, l.is_dealer, l.dealer_score, l.dealer_reasons,
            l.detail_fetched_at, l.first_seen_at,
            s.score, s.version, s.breakdown, s.scored_at,
            q.status AS contact_status
       FROM listing_scores s
       JOIN listings l ON l.id = s.listing_id
       LEFT JOIN contact_queue q ON q.listing_id = l.id
      WHERE l.is_active = true
        AND ($2::numeric IS NULL OR s.score >= $2)
        AND ($3::boolean OR l.is_dealer IS NOT TRUE)
      ORDER BY s.score DESC
      LIMIT $1`,
    [limit, minScore, includeDealers]
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
