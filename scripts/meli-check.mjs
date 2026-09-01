#!/usr/bin/env node
/**
 * ¿Las credenciales de MercadoLibre están y funcionan?
 *
 * Existe porque el resto del pipeline degrada en silencio cuando MELI no está
 * disponible —cae a la referencia interna y sigue— que es lo correcto en una
 * corrida, pero pésimo cuando lo que querés saber es justamente si quedó bien
 * configurado. Acá el fallo es ruidoso y dice qué falta.
 */
import { config } from "../src/config.mjs";
import { verifyCategory, checkCredentials, searchVehicles, MeliUnavailableError } from "../src/services/reference/meli.mjs";

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

console.log(`\nsite=${config.meli.siteId}  categoría=${config.meli.carsCategory}`);
console.log(`credenciales: ${
  config.meli.accessToken ? "MELI_ACCESS_TOKEN"
  : config.meli.clientId && config.meli.clientSecret ? "MELI_CLIENT_ID + MELI_CLIENT_SECRET"
  : "NINGUNA"
}\n`);

// 1. La categoría responde sin token: sirve para ver si la config básica está bien.
const cat = await verifyCategory();
if (cat.ok) ok(`categoría ${cat.id} = "${cat.name}"`);
else bad(`la categoría ${config.meli.carsCategory} no resolvió (HTTP ${cat.status})`);

// 2. El token y la búsqueda, que es lo que de verdad necesita credenciales.
try {
  const c = await checkCredentials();
  ok(`token válido (vía ${c.tokenSource}) — ${c.total ?? "?"} publicaciones en la categoría`);
} catch (err) {
  if (err instanceof MeliUnavailableError) {
    bad(err.message);
    console.log(`
  Para arreglarlo:
    1. Entrá a https://developers.mercadolibre.com.uy/devcenter con tu cuenta de MercadoLibre
    2. Creá una aplicación (te da App ID y Secret Key)
    3. Poné en el .env:
         MELI_CLIENT_ID=<App ID>
         MELI_CLIENT_SECRET=<Secret Key>
    4. Volvé a correr: npm run meli:check
`);
    process.exit(1);
  }
  throw err;
}

// 3. Una búsqueda de verdad con los filtros del pipeline.
const filtros = {
  minPrice: Number(process.env.TARGET_MIN_PRICE ?? 5000),
  maxPrice: Number(process.env.TARGET_MAX_PRICE ?? 12000),
  currency: "USD",
  limit: 5,
};
const { url, items, total } = await searchVehicles(filtros);
ok(`búsqueda con los filtros del pipeline: ${total} resultados`);
console.log(`  ${url}\n`);
for (const i of items) {
  console.log(`    ${String(i.price).padStart(7)} ${i.currency} | ${i.vehicleYear ?? "????"} | ${(i.title ?? "").slice(0, 44).padEnd(46)} | ${i.mileageKm ? `${Math.round(i.mileageKm / 1000)}k km` : ""}`);
}
console.log("");
