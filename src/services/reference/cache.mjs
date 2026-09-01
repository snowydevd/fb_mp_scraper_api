/**
 * TTL cache in front of the MercadoLibre reference lookup.
 *
 * Fase 3 asked for this explicitly ("no pegarle a la API por cada listing").
 * Without it a 24-listing run makes up to 24 MercadoLibre calls, most of them
 * for the same make/model/year band, every single run - and `reference_prices`
 * stays empty forever while its rows are exactly what makes a ranking
 * reproducible after the fact.
 *
 * Two tiers, on purpose:
 *   memo - per process, so one run never asks twice for the same band
 *   db   - across runs, honouring reference_prices.expires_at (MELI_CACHE_TTL_HOURS)
 *
 * Internal (batch-derived) references are deliberately NOT cached: they are a
 * property of one run's batch, not of the market, and persisting them would let
 * one afternoon's Facebook page define "market price" for days.
 */
const keyOf = ({ make, model, yearFrom, yearTo, currency, source = "meli" }) =>
  [source, make, model, yearFrom, yearTo, currency].map((p) => String(p ?? "")).join("|");

/**
 * @param {object} opts
 * @param {object|null} opts.repo   the db repo module, or null for dry runs
 * @param {function}    opts.log
 */
export function createReferenceCache({ repo = null, log = () => {} } = {}) {
  const memo = new Map();
  const stats = { memoHits: 0, dbHits: 0, misses: 0, stored: 0, upstreamSkipped: 0 };
  // Circuit breaker. With no credentials MercadoLibre fails before any network
  // call, but with WRONG ones it costs a token POST per listing - once per run
  // is enough to learn that.
  let upstreamDown = null;

  /** Shape a reference_prices row back into what the scorer expects. */
  const fromRow = (row) => ({
    make: row.make,
    model: row.model,
    yearFrom: row.year_from,
    yearTo: row.year_to,
    currency: row.currency,
    median: Number(row.median_price),
    p10: row.p10_price == null ? null : Number(row.p10_price),
    p90: row.p90_price == null ? null : Number(row.p90_price),
    sampleSize: row.sample_size,
    source: row.source,
    isReliable: row.is_reliable,
    expiresAt: row.expires_at,
    cached: true,
  });

  return {
    stats,

    /** Called after an upstream failure: stop retrying for the rest of the run. */
    markUpstreamUnavailable(reason) {
      if (!upstreamDown) log("info", `MercadoLibre unavailable for this run: ${reason}`);
      upstreamDown = reason;
    },
    get upstreamUnavailable() {
      return upstreamDown;
    },

    /**
     * @param {object} band  { make, model, yearFrom, yearTo, currency }
     * @param {function} compute  called only on a miss; must return a reference
     */
    async lookup(band, compute) {
      const key = keyOf(band);
      if (memo.has(key)) {
        stats.memoHits++;
        return memo.get(key);
      }
      if (upstreamDown) {
        stats.upstreamSkipped++;
        return null;
      }

      if (repo) {
        try {
          const row = await repo.getFreshReference({ ...band, source: "meli" });
          if (row) {
            stats.dbHits++;
            const ref = fromRow(row);
            memo.set(key, ref);
            return ref;
          }
        } catch (err) {
          // A cache is never allowed to fail the run.
          log("error", `reference cache read failed: ${err.message}`);
        }
      }

      stats.misses++;
      const ref = await compute();
      memo.set(key, ref);

      if (repo && ref?.median != null && ref.source === "meli") {
        try {
          await repo.saveReference(ref);
          stats.stored++;
        } catch (err) {
          log("error", `reference cache write failed: ${err.message}`);
        }
      }
      return ref;
    },
  };
}
