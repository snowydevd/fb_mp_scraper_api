import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreV1, scoreV2, priceDropScore, stalenessScore, priceChangeScore,
  kmScore, sellerScore, sellerSubscore, SCALES, WEIGHTS_V1, WEIGHTS_V2,
} from "../../src/services/scoring/scorer.mjs";

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const limpio = (over = {}) => ({
  title: "Volkswagen Gol", description: "Impecable", currencyResolved: "USD",
  price: 7_000, sellerActiveCount: 1, ...over,
});

// --- los pesos ------------------------------------------------------------

test("los pesos suman 1 en las dos versiones", () => {
  const suma = (w) => Number(Object.values(w).reduce((a, b) => a + b, 0).toFixed(6));
  assert.equal(suma(WEIGHTS_V1), 1);
  assert.equal(suma(WEIGHTS_V2), 1);
});

// Lo que el sistema prioriza, escrito como test para que no se erosione.
test("km y deuda se llevan la mayor parte del peso de v2", () => {
  assert.ok(WEIGHTS_V2.km + WEIGHTS_V2.deuda >= 0.6,
    `km+deuda son ${WEIGHTS_V2.km + WEIGHTS_V2.deuda}, deberían dominar`);
  assert.ok(WEIGHTS_V2.km > WEIGHTS_V2.seller);
  assert.ok(WEIGHTS_V2.deuda > WEIGHTS_V2.condicion);
});

test("el precio no puntúa: lo evalúa una persona", () => {
  assert.equal(WEIGHTS_V2.price, undefined);
  assert.equal(WEIGHTS_V1.price, undefined);
  const barato = scoreV2(limpio({ price: 5_000 }));
  const caro = scoreV2(limpio({ price: 11_000 }));
  assert.equal(barato.score, caro.score, "el mismo auto a distinto precio puntúa igual");
  assert.equal(barato.breakdown.price, undefined);
});

// --- kilometraje ----------------------------------------------------------

test("km: se combinan el absoluto y el por año, y manda el peor", () => {
  // 210.000 km en un 2008 son 11.6k/año (uso normal) pero 210.000 km igual.
  const viejoMuchoKm = kmScore({ mileageKm: 210_000, vehicleYear: 2008 });
  const nuevoPocoKm = kmScore({ mileageKm: 57_000, vehicleYear: 2015 });
  assert.ok(nuevoPocoKm.value > viejoMuchoKm.value,
    "medir sólo km/año los empataba, y para comprar y revender no son parecidos");
  assert.equal(viejoMuchoKm.manda, "km absoluto");
  assert.equal(nuevoPocoKm.manda, "km por año");
});

test("km: un uso intenso en un auto nuevo también penaliza", () => {
  const intenso = kmScore({ mileageKm: 120_000, vehicleYear: 2023 });
  assert.equal(intenso.manda, "km por año");
  assert.ok(intenso.value < 0.5);
});

test("km: el sospechosamente bajo para el año es un riesgo, no una ganga", () => {
  const r = kmScore({ mileageKm: 20_000, vehicleYear: 2010 });
  assert.ok(r.value < 0, "un tablero corregido no puede puntuar como km bajo");
  assert.match(r.reason, /implausiblemente bajo/);
  assert.ok(r.perYear < SCALES.kmPerYearSuspiciouslyLow);
});

test("km: sin año se usa el absoluto solo; sin km no aplica", () => {
  const sinAnio = kmScore({ mileageKm: 95_000, vehicleYear: null });
  assert.equal(sinAnio.applicable, true);
  assert.ok(sinAnio.value > 0.5);
  assert.equal(kmScore({ mileageKm: null, vehicleYear: 2015 }).applicable, false);
});

test("km desconocido no es km malo: aporta 0, no negativo", () => {
  const desconocido = scoreV2(limpio());
  const malo = scoreV2(limpio({ mileageKm: 300_000, vehicleYear: 2012 }));
  const bueno = scoreV2(limpio({ mileageKm: 60_000, vehicleYear: 2018 }));
  assert.equal(desconocido.breakdown.km.contribution, 0);
  assert.ok(bueno.score > desconocido.score);
  assert.ok(desconocido.score > malo.score);
});

// --- deuda ----------------------------------------------------------------

test("la deuda es un subscore propio y trazable", () => {
  const conPrenda = scoreV2(limpio({ description: "Tiene prenda con el banco, saldo 4000 usd" }));
  const sinDeuda = scoreV2(limpio({ description: "Libre de deuda, papeles al día" }));
  assert.ok(conPrenda.breakdown.deuda.value < 0);
  assert.ok(sinDeuda.breakdown.deuda.value > 0);
  assert.ok(sinDeuda.score > conPrenda.score);
  assert.ok(conPrenda.breakdown.deuda.hits.some((h) => h.label === "prenda"));
});

// El desglose tiene que separar "debe plata" de "está chocado": son las dos
// preguntas que decide el ranking y mezclarlas no explica nada.
test("deuda y condición no se mezclan", () => {
  const chocado = scoreV2(limpio({ description: "Chocado de atrás, libre de deuda" }));
  assert.ok(chocado.breakdown.condicion.value < 0, "chocado es condición");
  assert.ok(chocado.breakdown.deuda.value > 0, "y a la vez está libre de deuda");
});

test("un auto con km bueno pero con prenda cae debajo de uno con km peor y limpio", () => {
  const conPrenda = scoreV2(limpio({ mileageKm: 60_000, vehicleYear: 2018, description: "Tiene prenda, saldo 4000 usd" }));
  const limpioPeorKm = scoreV2(limpio({ mileageKm: 140_000, vehicleYear: 2012, description: "Libre de deuda" }));
  assert.ok(limpioPeorKm.score > conPrenda.score, "la deuda pesa lo suficiente para dar vuelta el km");
});

// --- descalificaciones ----------------------------------------------------

test("una automotora queda fuera, no apenas más abajo", () => {
  const r = scoreV2(limpio({ description: "Automotora Los Pinos. Financiamos y recibimos tu usado.", mileageKm: 50_000, vehicleYear: 2019 }));
  assert.equal(r.disqualified, true);
  assert.equal(r.score, -1);
  assert.ok(r.disqualifiedBy[0].startsWith("automotora"));
});

test("un financiado queda fuera: publica la entrega, no el precio", () => {
  const r = scoreV2(limpio({ description: "Financiación de la casa U$S 5000 y cuotas", mileageKm: 50_000, vehicleYear: 2019 }));
  assert.equal(r.disqualified, true);
  assert.equal(r.score, -1);
});

test("un auto normal no se descalifica por tener km alto", () => {
  const r = scoreV2(limpio({ mileageKm: 320_000, vehicleYear: 2010 }));
  assert.notEqual(r.disqualified, true);
  assert.ok(r.score > -1, "malo no es lo mismo que descalificado");
});

// --- v1 -------------------------------------------------------------------

test("v1 no puede descalificar: sin descripción no hay evidencia", () => {
  const r = scoreV1({ title: "Fiat uno NOAHCARS", price: 5_990, listedAt: daysAgo(5) });
  assert.notEqual(r.disqualified, true);
  assert.ok(r.dealer.score > 0, "pero la sospecha lo baja igual");
});

test("v1 no tiene subscore de deuda, y v2 sí", () => {
  assert.deepEqual(Object.keys(scoreV1(limpio())).includes("breakdown"), true);
  assert.equal(scoreV1(limpio()).breakdown.deuda, undefined);
  assert.ok(scoreV2(limpio()).breakdown.deuda);
});

test("v1 usa las pistas de la grilla para el km", () => {
  const conPista = scoreV1({ title: "VW Gol", mileageHint: 60_000, vehicleYearHint: 2018, listedAt: daysAgo(5) });
  const sinPista = scoreV1({ title: "VW Gol", listedAt: daysAgo(5) });
  assert.equal(conPista.breakdown.km.applicable, true);
  assert.ok(conPista.score > sinPista.score);
});

// --- señales de vendedor motivado (peso chico, pero presentes) ------------

test("las señales de historial suman poco pero suman", () => {
  const base = { title: "VW Gol", price: 7_000, mileageHint: 100_000, vehicleYearHint: 2015 };
  const fresco = scoreV1({ ...base, listedAt: daysAgo(1) });
  const viejo = scoreV1({ ...base, listedAt: daysAgo(70), oldPrice: 8_000, priceChangeCount: 2 });
  assert.ok(viejo.score > fresco.score);
  assert.ok(viejo.score - fresco.score < 0.3, "pero no pueden dominar el ranking");
});

test("priceDropScore sólo aplica cuando hubo una baja real", () => {
  assert.equal(priceDropScore(7_000, null).applicable, false);
  assert.equal(priceDropScore(7_000, 6_000).applicable, false, "un precio que subió no es una baja");
  assert.ok(priceDropScore(7_000, 8_000).value > 0);
});

test("stalenessScore prefiere la fecha real de Facebook", () => {
  const r = stalenessScore({ listedAt: daysAgo(40), firstSeenAt: daysAgo(2) });
  assert.equal(r.source, "facebook_creation_time");
  assert.equal(r.days, 40);
  assert.equal(stalenessScore({}).applicable, false);
});

test("priceChangeScore cuenta las bajadas acumuladas", () => {
  assert.equal(priceChangeScore(0).applicable, false);
  assert.ok(priceChangeScore(3).value >= priceChangeScore(1).value);
});

// --- vendedor -------------------------------------------------------------

test("sellerScore lee 3+ publicaciones activas como automotora", () => {
  assert.equal(sellerScore(3).value, -1);
  assert.ok(sellerScore(2).value < 0);
  assert.ok(sellerScore(1).value > 0);
  assert.equal(sellerScore(0).applicable, false);
});

test("sellerSubscore grada la sospecha en vez de tratarla como sí/no", () => {
  const sospecha = sellerSubscore({ title: "Fiat uno NOAHCARS", description: null });
  assert.equal(sospecha.dealer.isDealer, false);
  assert.ok(sospecha.value < 0, "0.5 contra un umbral de 0.6 no es cero");
  assert.equal(sospecha.reason, "possible dealer");
});

// --- trazabilidad ---------------------------------------------------------

test("el desglose explica el score: la suma de contribuciones ES el score", () => {
  const r = scoreV2(limpio({ mileageKm: 140_000, vehicleYear: 2012, description: "Debe patente, único dueño", listedAt: daysAgo(40) }));
  const suma = Object.values(r.breakdown).reduce((a, b) => a + b.contribution, 0);
  assert.ok(Math.abs(suma - r.score) < 0.001, `suma ${suma} vs score ${r.score}`);
  for (const sub of Object.values(r.breakdown)) {
    assert.ok("weight" in sub && "contribution" in sub);
  }
});

test("el score queda acotado a [-1, 1]", () => {
  const pesimo = scoreV2(limpio({ mileageKm: 400_000, vehicleYear: 2005, description: "Chocado, embargo, prenda, debe patente y multas" }));
  const optimo = scoreV2(limpio({ mileageKm: 40_000, vehicleYear: 2020, description: "Único dueño, papeles al día, libre de deuda", listedAt: daysAgo(90), oldPrice: 9_000, priceChangeCount: 3 }));
  assert.ok(pesimo.score >= -1 && optimo.score <= 1);
});
