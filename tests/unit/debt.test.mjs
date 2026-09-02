import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDebtAmounts, totalDebt } from "../../src/services/scoring/debt.mjs";
import { buildContactEntry } from "../../src/services/scoring/offer.mjs";

const listing = (description) => ({ id: "1", price: 6_500, currencyResolved: "USD", title: "Citroën Picasso", description });

// --- parser ---------------------------------------------------------------

test("lee el monto en las formas en que se escribe acá", () => {
  const casos = [
    ["Debe 200 dólares de patente", 200, "USD"],
    ["tiene prenda con el banco, saldo 4000 usd", 4_000, "USD"],
    ["Debo U$S 3.500 de prenda al banco", 3_500, "USD"],
    ["deuda de patente 15.000 pesos", 15_000, "UYU"],
    ["multas por 1500 pesos", 1_500, "UYU"],
    ["deuda de 2.500 dólares", 2_500, "USD"],
  ];
  for (const [texto, monto, moneda] of casos) {
    const [d] = parseDebtAmounts(texto);
    assert.ok(d, `no encontró monto en "${texto}"`);
    assert.equal(d.amount, monto, texto);
    assert.equal(d.currency, moneda, texto);
  }
});

// La trampa: son los años que se adeudan, no 2024 dólares.
test("un año no es un monto", () => {
  assert.deepEqual(parseDebtAmounts("VW Gol 2012, deuda de patente 2024 y 2025."), []);
  assert.deepEqual(parseDebtAmounts("deuda de patente del 2023"), []);
  // Pero con moneda adelante sí es plata, aunque la cifra parezca un año.
  assert.equal(parseDebtAmounts("deuda de u$s 2000")[0].amount, 2_000);
  // Y formateado como monto también.
  assert.equal(parseDebtAmounts("deuda de 2.024 pesos")[0].amount, 2_024);
});

test("no inventa deuda donde no la hay", () => {
  assert.deepEqual(parseDebtAmounts("Nissan March 2015, libre de deuda, papeles al día"), []);
  assert.deepEqual(parseDebtAmounts("Impecable, único dueño"), []);
  assert.deepEqual(parseDebtAmounts(""), []);
  assert.deepEqual(parseDebtAmounts(null), []);
});

test("un $ pelado es ambiguo en Uruguay y se marca como tal", () => {
  const [d] = parseDebtAmounts("adeuda $ 12.000");
  assert.equal(d.amount, 12_000);
  assert.equal(d.currency, null);
  assert.equal(d.confidence, "low");
});

// --- total ----------------------------------------------------------------

test("sin moneda segura no se suma: vuelve para que lo mire una persona", () => {
  const t = totalDebt("adeuda $ 12.000", { currency: "USD" });
  assert.equal(t.total, 0);
  assert.equal(t.hasUnresolved, true);
  assert.match(t.unresolved[0].reason, /moneda no declarada/);
});

test("sin tipo de cambio configurado no se convierte", () => {
  const t = totalDebt("deuda de patente 15.000 pesos", { currency: "USD" });
  assert.equal(t.total, 0, "restar 15000 pesos a un precio en dólares daría una oferta negativa");
  assert.match(t.unresolved[0].reason, /no hay tipo de cambio/);
});

test("con tipo de cambio configurado sí, y deja el rate a la vista", () => {
  const t = totalDebt("deuda de patente 15.000 pesos", { currency: "USD", uyuPerUsd: 40 });
  assert.equal(t.total, 375);
  assert.equal(t.applied[0].rate, 40);
  assert.equal(t.applied[0].convertedAmount, 375);
});

// --- de dónde se lee en el pipeline ---------------------------------------
// El monto ya no se descuenta de una oferta —no hay oferta— pero sigue siendo
// la mitad de lo que decide si el auto vale la pena, así que va en los hechos.
test("el monto parseado llega a la entrada de la cola", () => {
  const { facts } = buildContactEntry(listing("Tiene prenda, saldo 2000 usd."));
  assert.equal(facts.declaredDebt.amount, 2_000);
  assert.equal(facts.declaredDebt.currency, "USD");
});

test("un año en la descripción no se cuela como deuda en la cola", () => {
  const { facts } = buildContactEntry(listing("Deuda de patente 2024 y 2025."));
  assert.equal(facts.declaredDebt, null);
});
