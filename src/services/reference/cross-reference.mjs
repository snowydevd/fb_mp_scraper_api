/**
 * Cruce entre un aviso de Facebook y lo que el mismo auto vale en MercadoLibre.
 *
 * Es distinto de `referenceFromMeli`, que devuelve una mediana y nada más. Acá
 * interesa el detalle: CUÁLES son los comparables, para poder abrirlos y ver si
 * la comparación tiene sentido. Un ranking que dice "18% bajo mercado" sin
 * poder mostrar contra qué no se puede auditar, y la mediana de MercadoLibre
 * tiene sus propios problemas (publicaciones fantasma, autos de agencia con
 * garantía, versiones full contra base).
 *
 * Dos reglas heredadas del resto del pipeline:
 *   - **Nunca se convierte moneda.** Un comparable en UYU no compara contra un
 *     aviso en USD; se descarta y se dice cuántos se descartaron.
 *   - **Se falla explícito.** Sin comparables suficientes se devuelve
 *     `reliable: false` con el motivo, nunca un número que parezca sólido.
 */
import { normalizeText } from "../scoring/text.mjs";
import { robustMedian, MIN_RELIABLE_SAMPLE } from "./reference-price.mjs";

/** Tolerancia de año a cada lado. Un 2010 compara contra 2008-2012. */
export const YEAR_TOLERANCE = 2;

const norm = (v) => normalizeText(v).replace(/\s+/g, " ").trim();

/**
 * ¿Este item de MELI es comparable con este aviso?
 *
 * El modelo se compara por inclusión en los dos sentidos porque las dos fuentes
 * lo escriben distinto: Facebook manda "Gol" y MELI "Gol Trend", o al revés.
 * Exigir igualdad exacta dejaría casi todo afuera.
 */
export function isComparable(listing, item, { yearTolerance = YEAR_TOLERANCE } = {}) {
  const wantMake = norm(listing.make);
  const wantModel = norm(listing.model);
  if (!wantMake || !wantModel) return { ok: false, reason: "el aviso no tiene marca y modelo" };

  const gotMake = norm(item.make);
  const gotModel = norm(item.model);
  if (!gotMake || !gotModel) return { ok: false, reason: "el comparable no tiene marca y modelo" };
  if (gotMake !== wantMake) return { ok: false, reason: "otra marca" };
  if (!gotModel.includes(wantModel) && !wantModel.includes(gotModel)) {
    return { ok: false, reason: "otro modelo" };
  }

  const year = listing.vehicleYear ?? listing.vehicle_year ?? null;
  if (year && item.vehicleYear && Math.abs(item.vehicleYear - year) > yearTolerance) {
    return { ok: false, reason: `año fuera de ±${yearTolerance}` };
  }
  if (item.price == null || !(item.price > 0)) return { ok: false, reason: "sin precio" };
  return { ok: true };
}

/**
 * @param {object} listing  aviso de Facebook (con make/model/vehicleYear/price)
 * @param {object[]} meliItems  items ya mapeados por mapMeliItem
 */
export function crossReference(listing, meliItems, { yearTolerance = YEAR_TOLERANCE } = {}) {
  const currency = listing.currencyResolved ?? listing.currency_resolved ?? null;
  const price = listing.price == null ? null : Number(listing.price);

  const comparables = [];
  const rejected = { otherCurrency: 0, notComparable: 0 };

  for (const item of meliItems ?? []) {
    const verdict = isComparable(listing, item, { yearTolerance });
    if (!verdict.ok) { rejected.notComparable++; continue; }
    // Nunca se convierte: un comparable en pesos no dice nada sobre un aviso en
    // dólares, y mezclarlos hace inservible cualquier mediana.
    if (currency && item.currency !== currency) { rejected.otherCurrency++; continue; }
    comparables.push(item);
  }

  const stats = robustMedian(comparables.map((c) => c.price));

  // Dos números distintos, y confundirlos hacía que 6 comparables genuinos se
  // reportaran como "sólo 4": `matched` es cuántos comparables hay, `kept` es
  // cuántos sobrevivieron al recorte p10-p90 que protege a la MEDIANA de las
  // publicaciones fantasma. La confiabilidad se juzga sobre los comparables
  // encontrados —ya pasaron marca, modelo, año y moneda—, no sobre lo que quedó
  // después de podar; si no, harían falta ~8 para que alguna vez diga que sí.
  const matched = comparables.length;
  const reliable = matched >= MIN_RELIABLE_SAMPLE && stats.median != null;

  const base = {
    source: "meli_cross_reference",
    currency,
    matched,
    sampleSize: stats.kept,
    trimmed: matched - stats.kept,
    median: stats.median,
    p10: stats.p10,
    p90: stats.p90,
    reliable,
    rejected,
    // Ordenados por precio: los primeros son con los que hay que competir.
    comparables: comparables
      .slice()
      .sort((a, b) => a.price - b.price)
      .map((c) => ({ id: c.id, title: c.title, price: c.price, currency: c.currency, vehicleYear: c.vehicleYear, mileageKm: c.mileageKm, url: c.url })),
  };

  if (!reliable) {
    return { ...base, reason: stats.median == null ? "sin comparables" : `sólo ${matched} comparables (mínimo ${MIN_RELIABLE_SAMPLE})` };
  }
  if (price == null) return { ...base, reason: "el aviso no tiene precio" };

  const deltaPct = (stats.median - price) / stats.median;
  const cheaperOnMeli = comparables.filter((c) => c.price < price).length;

  return {
    ...base,
    price,
    deltaPct: Number((deltaPct * 100).toFixed(1)),
    // Cuántos comparables de MELI están MÁS baratos que este aviso. Es la
    // pregunta práctica: si hay seis más baratos en MercadoLibre, el "chollo"
    // de Facebook no lo es.
    cheaperOnMeli,
    positionPct: Number(((cheaperOnMeli / comparables.length) * 100).toFixed(0)),
    verdict:
      deltaPct >= 0.15 ? "muy por debajo de MercadoLibre"
      : deltaPct >= 0.05 ? "por debajo de MercadoLibre"
      : deltaPct > -0.05 ? "en línea con MercadoLibre"
      : "por encima de MercadoLibre",
  };
}
