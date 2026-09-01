import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDebtAmounts, totalDebt } from "../../src/services/scoring/debt.mjs";
import { suggestOffer, draftMessage } from "../../src/services/scoring/offer.mjs";

const ref = { median: 7_495, isReliable: true, sampleSize: 14, currency: "USD" };
const listing = (description) => ({ price: 6_500, currencyResolved: "USD", title: "Citroën Picasso", description });

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

// --- oferta ---------------------------------------------------------------

test("la deuda declarada sale de la oferta", () => {
  const limpio = suggestOffer(listing("Impecable, único dueño."), ref);
  const conDeuda = suggestOffer(listing("Impecable. Debe 200 dólares de patente."), ref);
  assert.equal(limpio.offer, 6_150);
  assert.equal(conDeuda.offer, 5_950);
  assert.equal(conDeuda.debt.deducted, 200);
  assert.equal(conDeuda.debt.offerBeforeDebt, 6_150);
});

test("el redondeo al netear va siempre para abajo", () => {
  // 6150 - 175 = 5975; redondear a 6000 devolvería parte de la deuda.
  const r = suggestOffer(listing("Debe 175 dólares de patente."), ref);
  assert.ok(r.offer <= 5_975, `dio ${r.offer}`);
});

test("una deuda que se come la oferta entera no produce borrador", () => {
  const r = suggestOffer(listing("Debo 8000 usd de prenda."), ref);
  assert.equal(r.ok, false);
  assert.match(r.reason, /se come la oferta/);
});

test("una deuda que domina el negocio se marca para revisión humana", () => {
  const r = suggestOffer(listing("Tiene prenda, saldo 3000 usd."), ref);
  assert.equal(r.ok, true);
  assert.equal(r.debt.dominates, true, "una persona tiene que mirar esto antes de mandarlo");
});

test("lo que no se pudo descontar viaja con la oferta, no se pierde", () => {
  const r = suggestOffer(listing("Deuda de patente 15.000 pesos."), ref);
  assert.equal(r.offer, 6_150, "la oferta no se toca si no se sabe la moneda");
  assert.equal(r.debt.needsReview.length, 1);
  assert.equal(r.debt.needsReview[0].amount, 15_000);
});

test("el borrador dice de frente por qué la oferta bajó", () => {
  const r = suggestOffer(listing("Impecable. Debe 200 dólares de patente."), ref);
  const msg = draftMessage({ title: "Citroën Picasso 2008" }, r);
  assert.match(msg, /deuda de USD 200/);
  assert.match(msg, /5\.950/);
});

test("sin deuda, el borrador no habla de deuda", () => {
  const r = suggestOffer(listing("Impecable, único dueño."), ref);
  assert.ok(!draftMessage({ title: "x" }, r).includes("deuda"));
});
