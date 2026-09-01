import { test } from "node:test";
import assert from "node:assert/strict";
import { mapMeliItem } from "../../src/services/reference/meli.mjs";
import { crossReference, isComparable } from "../../src/services/reference/cross-reference.mjs";
import { meliResult, golComparables } from "../fixtures/meli.mjs";

const items = golComparables.map(mapMeliItem);
const gol2012 = { make: "Volkswagen", model: "Gol", vehicleYear: 2012, price: 6_900, currencyResolved: "USD" };

// --- mapeo ----------------------------------------------------------------

test("un item de MELI queda con la misma forma que uno de Facebook", () => {
  const m = mapMeliItem(meliResult());
  assert.equal(m.source, "meli");
  assert.equal(m.price, 8_200);
  assert.equal(m.make, "Volkswagen");
  assert.equal(m.model, "Gol");
  assert.equal(m.vehicleYear, 2012);
  assert.equal(m.mileageKm, 145_000, "'145.000 km' tiene que llegar como número");
  assert.equal(m.city, "Montevideo");
});

test("la moneda de MELI se cree, a diferencia de la de Facebook", () => {
  const m = mapMeliItem(meliResult({ currency_id: "UYU", price: 350_000 }));
  assert.equal(m.currency, "UYU");
  assert.equal(m.currencyResolved, "UYU", "MELI declara la moneda de verdad; no hay que adivinarla por magnitud");
  assert.equal(m.currencyConfidence, "high");
});

test("del vendedor sólo se guarda el id (Ley 18.331)", () => {
  const m = mapMeliItem(meliResult());
  assert.equal(m.sellerId, "987654321");
  assert.ok(!JSON.stringify(m).includes("NO_DEBE_PERSISTIRSE"), "el nickname no puede viajar");
});

test("un item sin id no rompe el mapeo, se descarta", () => {
  assert.equal(mapMeliItem({}), null);
  assert.equal(mapMeliItem(null), null);
});

test("un item sin atributos no inventa datos", () => {
  const m = mapMeliItem(meliResult({ attributes: [] }));
  assert.equal(m.vehicleYear, null);
  assert.equal(m.mileageKm, null);
  assert.equal(m.make, null);
});

// --- comparabilidad -------------------------------------------------------

test("el modelo compara por inclusión: las dos fuentes lo escriben distinto", () => {
  // Facebook manda "Gol", MELI "Gol Trend".
  assert.equal(isComparable({ make: "Volkswagen", model: "Gol", vehicleYear: 2012 },
    { make: "Volkswagen", model: "Gol Trend", vehicleYear: 2012, price: 8_000 }).ok, true);
  // Y al revés.
  assert.equal(isComparable({ make: "Volkswagen", model: "Gol Trend", vehicleYear: 2012 },
    { make: "Volkswagen", model: "Gol", vehicleYear: 2012, price: 8_000 }).ok, true);
});

test("otra marca, otro modelo o año fuera de banda no comparan", () => {
  const base = { make: "Volkswagen", model: "Gol", vehicleYear: 2012 };
  assert.match(isComparable(base, { make: "Fiat", model: "Gol", vehicleYear: 2012, price: 1 }).reason, /marca/);
  assert.match(isComparable(base, { make: "Volkswagen", model: "Polo", vehicleYear: 2012, price: 1 }).reason, /modelo/);
  assert.match(isComparable(base, { make: "Volkswagen", model: "Gol", vehicleYear: 2021, price: 1 }).reason, /año/);
});

test("sin marca y modelo no se compara nada: mejor nada que un número inventado", () => {
  assert.equal(isComparable({ make: null, model: null }, { make: "Volkswagen", model: "Gol", price: 1 }).ok, false);
});

// --- cruce ----------------------------------------------------------------

test("el cruce descarta otra moneda y lo dice, en vez de convertir", () => {
  const x = crossReference(gol2012, items);
  assert.equal(x.rejected.otherCurrency, 1, "el comparable en UYU se descarta");
  assert.ok(x.comparables.every((c) => c.currency === "USD"));
});

test("el cruce ubica el aviso contra los comparables reales", () => {
  const x = crossReference(gol2012, items);
  assert.equal(x.matched, 6, "seis comparables genuinos");
  assert.equal(x.sampleSize, 4, "cuatro sobreviven al recorte p10-p90 que protege la mediana");
  assert.equal(x.reliable, true, "la confiabilidad se juzga sobre los comparables, no sobre lo podado");
  assert.ok(x.deltaPct > 15, `un Gol a 6900 contra mediana ~8700 está muy por debajo, dio ${x.deltaPct}%`);
  assert.equal(x.cheaperOnMeli, 0);
  assert.equal(x.verdict, "muy por debajo de MercadoLibre");
});

// La pregunta práctica: si hay varios más baratos en MELI, no es un chollo.
test("un aviso caro se ve caro, con cuántos hay más baratos", () => {
  const caro = { ...gol2012, price: 9_500 };
  const x = crossReference(caro, items);
  assert.ok(x.deltaPct < 0);
  assert.equal(x.cheaperOnMeli, 5, "cinco comparables de MELI están más baratos");
  assert.equal(x.verdict, "por encima de MercadoLibre");
});

test("los comparables vienen ordenados por precio y con su link", () => {
  const x = crossReference(gol2012, items);
  const precios = x.comparables.map((c) => c.price);
  assert.deepEqual(precios, [...precios].sort((a, b) => a - b));
  assert.match(x.comparables[0].url, /mercadolibre/, "hay que poder abrirlo para auditar la comparación");
});

test("pocos comparables se reportan como no confiables, con el motivo", () => {
  const x = crossReference(gol2012, items.slice(0, 3));
  assert.equal(x.reliable, false);
  assert.match(x.reason, /sólo 3 comparables/);
  assert.equal(x.deltaPct, undefined, "sin muestra no se emite un número que parezca sólido");
});

test("sin comparables no explota", () => {
  const x = crossReference(gol2012, []);
  assert.equal(x.reliable, false);
  assert.match(x.reason, /sin comparables/);
  assert.deepEqual(crossReference(gol2012, null).comparables, []);
});

// --- resiliencia de red ---------------------------------------------------
// Un corte de red da `TypeError: fetch failed`, que NO es MeliUnavailableError:
// se propagaba hasta arriba y volteaba la corrida entera del worker, después de
// haber gastado las navegaciones a Facebook, que son el recurso caro.
test("un fallo de red sale como MeliUnavailableError, no como TypeError", async () => {
  const { meliFetch, MeliUnavailableError, MELI_RETRIES } = await import("../../src/services/reference/meli.mjs");
  const original = globalThis.fetch;
  let intentos = 0;
  globalThis.fetch = async () => {
    intentos++;
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
  };
  try {
    await assert.rejects(
      () => meliFetch("https://api.mercadolibre.com/categories/MLU1744", { retries: 1 }),
      (err) => {
        assert.ok(err instanceof MeliUnavailableError, `salió ${err.constructor.name}, el worker no lo atrapa`);
        assert.match(err.message, /UND_ERR_CONNECT_TIMEOUT/, "el motivo real tiene que sobrevivir");
        return true;
      }
    );
    assert.equal(intentos, 2, "reintenta antes de rendirse: el fallo observado fue un timeout aislado");
    assert.ok(MELI_RETRIES >= 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("un reintento que funciona no molesta a nadie", async () => {
  const { meliFetch } = await import("../../src/services/reference/meli.mjs");
  const original = globalThis.fetch;
  let intentos = 0;
  globalThis.fetch = async () => {
    if (++intentos === 1) throw new TypeError("fetch failed");
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const res = await meliFetch("https://api.mercadolibre.com/x");
    assert.equal(res.status, 200);
    assert.equal(intentos, 2);
  } finally {
    globalThis.fetch = original;
  }
});

// Un 4xx/5xx NO es un fallo de red: la respuesta vuelve y la decide el llamador,
// que es quien puede leer el cuerpo y decir qué política bloqueó.
test("un 403 vuelve como respuesta, no como excepción de red", async () => {
  const { meliFetch } = await import("../../src/services/reference/meli.mjs");
  const original = globalThis.fetch;
  let intentos = 0;
  globalThis.fetch = async () => { intentos++; return new Response('{"error":"forbidden"}', { status: 403 }); };
  try {
    const res = await meliFetch("https://api.mercadolibre.com/x");
    assert.equal(res.status, 403);
    assert.equal(intentos, 1, "reintentar un 403 es gastar llamadas: no va a cambiar");
  } finally {
    globalThis.fetch = original;
  }
});
