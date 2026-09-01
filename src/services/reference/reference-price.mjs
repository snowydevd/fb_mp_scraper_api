/**
 * Fase 3: market reference price for a make/model/year band.
 *
 * Two sources, in order:
 *   meli     - MercadoLibre comparables (needs credentials)
 *   internal - the median of our own active listings for the same band
 *
 * Outliers are trimmed to the p10-p90 band before the median: classifieds are
 * full of placeholder prices (1, 111111, 1000000 all appeared in a single
 * Facebook page) and a raw median is not robust to them. The sample size rides
 * along so a caller can refuse to lean on a thin comparable set.
 */
import { config } from "../../config.mjs";
import * as meli from "./meli.mjs";

export const MIN_RELIABLE_SAMPLE = 5;

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Trim to p10-p90, then take the median of what survives. */
export function robustMedian(values) {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!sorted.length) return { median: null, p10: null, p90: null, kept: 0, discarded: 0 };
  const p10 = percentile(sorted, 0.1);
  const p90 = percentile(sorted, 0.9);
  const kept = sorted.filter((v) => v >= p10 && v <= p90);
  const base = kept.length ? kept : sorted;
  return {
    median: percentile(base, 0.5),
    p10,
    p90,
    kept: base.length,
    discarded: sorted.length - base.length,
  };
}

function expiry() {
  return new Date(Date.now() + config.meli.cacheTtlHours * 3600 * 1000).toISOString();
}

/**
 * Compute a reference from MercadoLibre. Throws MeliUnavailableError when
 * credentials are missing or rejected, so the caller can fall back.
 */
export async function referenceFromMeli({ make, model, yearFrom, yearTo, currency = "USD" }) {
  const { prices } = await meli.searchComparables({ make, model, yearFrom, yearTo });
  const sameCurrency = prices.filter((p) => p.currency === currency).map((p) => p.price);
  const stats = robustMedian(sameCurrency);
  return {
    make, model, yearFrom, yearTo, currency,
    median: stats.median,
    p10: stats.p10,
    p90: stats.p90,
    sampleSize: stats.kept,
    discarded: stats.discarded,
    source: "meli",
    isReliable: stats.kept >= MIN_RELIABLE_SAMPLE && stats.median != null,
    expiresAt: expiry(),
  };
}

/**
 * Fallback reference built from our own active listings. Self-referential by
 * construction: it says how a listing compares to the rest of the Facebook
 * market, not to fair value. Marked as such so the scorer can down-weight it.
 */
export function referenceFromInternal({ make, model, yearFrom, yearTo, currency = "USD" }, rows) {
  const values = rows
    .filter((r) => (r.currency_resolved || r.currency) === currency)
    .map((r) => Number(r.price))
    .filter((v) => Number.isFinite(v) && v > 0);
  const stats = robustMedian(values);
  return {
    make, model, yearFrom, yearTo, currency,
    median: stats.median,
    p10: stats.p10,
    p90: stats.p90,
    sampleSize: stats.kept,
    discarded: stats.discarded,
    source: "internal",
    isReliable: stats.kept >= MIN_RELIABLE_SAMPLE && stats.median != null,
    expiresAt: expiry(),
  };
}
