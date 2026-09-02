/**
 * Mediana del propio lote de Facebook, como CONTEXTO para que una persona mire
 * el precio — ya no puntúa.
 *
 * Antes esto alimentaba el subscore de precio, con MercadoLibre como fuente
 * primaria. MercadoLibre bloqueó /sites/{site}/search (403 con token de usuario
 * válido y todo lo demás respondiendo), y la mediana del lote de Facebook se
 * compara contra sí misma, así que ninguna de las dos servía para decidir un
 * ranking. Quien juzga el precio sos vos; esto sólo te dice contra qué.
 *
 * Los outliers se recortan al rango p10-p90 antes de la mediana: en una sola
 * página de Facebook aparecieron precios de 1, 111111 y 1000000.
 */

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

/** Autorreferencial por construcción: dice cómo se compara un aviso contra el
 * resto de Facebook, no contra valor de mercado. Por eso es contexto y no score. */
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
  };
}
