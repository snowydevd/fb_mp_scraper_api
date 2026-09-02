#!/usr/bin/env node
/**
 * ¿La sesión de Facebook está puesta y sirve?
 *
 *   npm run fb:check
 *
 * Hace UNA búsqueda con los filtros del pipeline y reporta si entró con sesión,
 * cuántos avisos trajo y —lo que más importa— si se levantó el tope de 24 que
 * tiene el Marketplace anónimo. Medido sin sesión: 24 resultados con el rango
 * 5000-12000, 24 con 0-100000 y 24 subiendo el scroll a 10 pasadas. Ese tope es
 * el techo real del caudal, no el filtro de precio.
 *
 * Gasta una navegación con su delay, como cualquier otra: no lo corras en loop.
 */
import { config } from "../src/config.mjs";
import { searchVehicles } from "../src/services/marketplace/search.mjs";
import { closeBrowser } from "../src/services/marketplace/browser.mjs";
import { partitionVehicles } from "../src/services/marketplace/vehicle-filter.mjs";
import { ScraperError } from "../src/services/scraper.mjs";
import { DEFAULT_FILTERS } from "../src/worker/sync.mjs";

const fuente = config.session.storageStatePath ? `FB_STORAGE_STATE (${config.session.storageStatePath})`
  : config.session.cookies ? "FB_COOKIES"
  : null;

console.log(`\nsesión configurada: ${fuente ?? "NINGUNA (anónimo)"}`);
if (!fuente) {
  console.log(`
  Sin sesión funciona, pero con tope: el Marketplace anónimo corta en 24
  resultados y no lo levanta ni subiendo el scroll. Para configurarla:

    npm run fb:login        abre un navegador y captura la sesión
    (o) FB_COOKIES="c_user=...; xs=..."   en el .env
`);
}
if (config.session.persistStatePath) {
  console.log(`re-persistencia: ${config.session.persistStatePath}`);
} else if (fuente) {
  console.log(`re-persistencia: NO configurada — poné FB_STORAGE_STATE_OUT para no perder una rotación`);
}
console.log(`filtros: ${JSON.stringify(DEFAULT_FILTERS)}\n`);

try {
  const { url, items: crudos } = await searchVehicles(DEFAULT_FILTERS, { skipDelay: true });
  const { vehicles, notVehicles } = partitionVehicles(crudos);
  console.log(`✓ la búsqueda funcionó`);
  console.log(`  ${url}`);
  console.log(`  ${crudos.length} avisos (${vehicles.length} vehículos, ${notVehicles.length} repuestos descartados)`);
  const conKm = vehicles.filter((v) => v.mileageHint).length;
  const conAnio = vehicles.filter((v) => v.vehicleYearHint).length;
  console.log(`  con km en la grilla: ${conKm}   con año en el título: ${conAnio}`);

  if (crudos.length > 24) {
    console.log(`\n  El tope de 24 se levantó: la sesión está sirviendo de verdad.`);
  } else if (crudos.length === 24) {
    console.log(`\n  Siguen siendo 24, que es el tope del Marketplace anónimo.`);
    console.log(`  ${fuente ? "Puede que la sesión no se esté aplicando, o que 24 sea el tope igual con sesión." : "Configurá la sesión y volvé a correr esto para comparar."}`);
  }
} catch (err) {
  if (err instanceof ScraperError) {
    console.error(`\n✗ [${err.code}] ${err.message}`);
    if (err.code === "LOGIN_REQUIRED") {
      console.error(`\n  La sesión está vencida o no se aplicó. Volvé a correr: npm run fb:login`);
    }
    await closeBrowser().catch(() => {});
    process.exit(1);
  }
  throw err;
}
await closeBrowser();
console.log("");
