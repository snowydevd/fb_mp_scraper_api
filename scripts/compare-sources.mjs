#!/usr/bin/env node
/**
 * La misma búsqueda, con los mismos filtros, en las dos fuentes.
 *
 *   node scripts/compare-sources.mjs
 *
 * Facebook se scrapea (1 navegación, con su delay) y MercadoLibre se consulta
 * por API. Sirve para dos cosas: ver si el precio de Facebook está por debajo
 * del mercado formal, y sobre todo para calibrar — si las dos fuentes dan
 * medianas parecidas, la referencia interna no estaba tan mal.
 */
import { config } from "../src/config.mjs";
import { searchVehicles as searchFacebook } from "../src/services/marketplace/search.mjs";
import { closeBrowser } from "../src/services/marketplace/browser.mjs";
import { partitionVehicles } from "../src/services/marketplace/vehicle-filter.mjs";
import { searchVehicles as searchMeli, MeliUnavailableError } from "../src/services/reference/meli.mjs";
import { robustMedian } from "../src/services/reference/reference-price.mjs";
import { DEFAULT_FILTERS } from "../src/worker/sync.mjs";

const filtros = { ...DEFAULT_FILTERS };
const dry = process.argv.includes("--dry");
console.log("filtros:", JSON.stringify(filtros), "\n");

const stats = (items) => {
  const usd = items.filter((i) => (i.currencyResolved ?? i.currency) === "USD" && i.price > 0).map((i) => i.price);
  const s = robustMedian(usd);
  return { n: items.length, enUsd: usd.length, mediana: s.median == null ? null : Math.round(s.median) };
};

// --- Facebook -------------------------------------------------------------
const { items: crudos } = await searchFacebook(filtros, { skipDelay: dry });
const { vehicles: fb, notVehicles } = partitionVehicles(crudos);
const sFb = stats(fb);
console.log(`FACEBOOK    ${sFb.n} vehículos (${notVehicles.length} descartados por no serlo) | ${sFb.enUsd} en USD | mediana USD ${sFb.mediana ?? "?"}`);
await closeBrowser();

// --- MercadoLibre ---------------------------------------------------------
let ml = null;
try {
  const r = await searchMeli({ ...filtros, currency: "USD", limit: 50 });
  ml = r.items;
  const sMl = stats(ml);
  console.log(`MERCADOLIBRE ${r.total} resultados (${sMl.n} traídos) | ${sMl.enUsd} en USD | mediana USD ${sMl.mediana ?? "?"}`);
  if (sFb.mediana && sMl.mediana) {
    const d = ((sMl.mediana - sFb.mediana) / sMl.mediana) * 100;
    console.log(`\nFacebook está ${d >= 0 ? "por DEBAJO" : "por ENCIMA"} de MercadoLibre en ${Math.abs(d).toFixed(1)}%`);
    console.log(`(mediana FB ${sFb.mediana} vs ML ${sMl.mediana}, ambas en USD, sin convertir nada)`);
  }
} catch (err) {
  if (!(err instanceof MeliUnavailableError)) throw err;
  console.log(`MERCADOLIBRE no disponible: ${err.message}`);
  console.log(`\nCorré  npm run meli:check  para ver qué falta.`);
  process.exit(1);
}

// --- lo más barato de cada lado ------------------------------------------
const top = (arr, n = 6) => arr.filter((i) => i.price > 0 && (i.currencyResolved ?? i.currency) === "USD")
  .sort((a, b) => a.price - b.price).slice(0, n);
console.log("\nmás baratos en Facebook:");
for (const i of top(fb)) console.log(`  ${String(i.price).padStart(6)} USD | ${(i.title ?? "").slice(0, 48)}`);
console.log("\nmás baratos en MercadoLibre:");
for (const i of top(ml)) console.log(`  ${String(i.price).padStart(6)} USD | ${(i.title ?? "").slice(0, 48)}`);
console.log("");
