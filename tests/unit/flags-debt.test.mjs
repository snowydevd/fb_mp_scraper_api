import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFlags } from "../../src/services/scoring/flags.mjs";

const score = (t) => evaluateFlags(t).score;
const labels = (t) => evaluateFlags(t).hits.filter((h) => h.counted !== false).map((h) => h.label);

// El bug más caro: "sin embargo" es la conjunción adversativa más común del
// español y matcheaba /\bembargo\b/. Cualquier vendedor escribiendo prosa
// normal quedaba marcado como auto embargado, -0.45.
test("'sin embargo' es una conjunción, no un gravamen judicial", () => {
  const r = evaluateFlags("Tiene detalles de pintura, sin embargo el motor está impecable.");
  assert.equal(r.score, 0);
  assert.deepEqual(labels("Sin embargo anda perfecto"), []);
  assert.ok(r.neutralised.some((n) => n.label === "embargo"), "queda registrado que se anuló, no se ignora en silencio");
});

// El sistema penalizaba al vendedor por decir que el auto NO debe nada: la
// señal de vendedor honesto que más queremos era la que restaba.
test("decir que no hay deuda suma, no resta", () => {
  for (const t of [
    "Peugeot 208, sin deuda, único dueño.",
    "Vendo Corsa, no debe nada, todo al día.",
    "Toyota Etios, sin prenda, listo para transferir.",
    "Nissan March, libre de deuda, papeles al día.",
    "Suzuki Celerio, patente al día y seguro.",
  ]) {
    assert.ok(score(t) > 0, `"${t}" debería sumar, dio ${score(t)}`);
  }
});

test("una prenda ya levantada es un trámite terminado, no un gravamen", () => {
  assert.ok(score("Fiat Cronos, prenda cancelada, libre para transferir.") > 0);
  assert.ok(score("Hyundai i10, prenda levantada el mes pasado.") > 0);
  assert.equal(score("Renault Sandero, deuda cancelada, escritura lista."), 0);
});

test("una prenda viva sí penaliza, y fuerte", () => {
  const r = evaluateFlags("Chevrolet Onix 2018, tiene prenda con el banco, saldo 4000 usd.");
  assert.ok(r.score <= -0.6, `dio ${r.score}`);
  assert.ok(labels("tiene prenda con el banco").includes("prenda"));
});

test("las multas se detectan: antes no existían como término", () => {
  assert.ok(labels("Ford Fiesta, tiene multas impagas de tránsito.").includes("multas"));
  assert.ok(score("tiene multas impagas") < 0);
});

// Una deuda de patente es chica, conocida y se descuenta del precio; una prenda
// bloquea la transferencia. Tratarlas igual sobrepenalizaba la primera.
test("una deuda de patente pesa menos que una deuda a secas", () => {
  const patente = score("VW Gol 2012, deuda de patente 2024 y 2025.");
  const generica = score("VW Gol 2012, tiene deuda.");
  assert.ok(patente > generica, `patente ${patente} debería pesar menos que genérica ${generica}`);
  assert.equal(patente, -0.15);
});

test("el término específico reemplaza al genérico en vez de sumarse", () => {
  const r = evaluateFlags("deuda de patente 2025");
  const visibles = r.hits.map((h) => h.label);
  assert.ok(visibles.includes("deuda"), "el genérico sigue visible para poder auditar");
  assert.equal(r.hits.find((h) => h.label === "deuda").counted, false, "pero no suma: sería contar la misma deuda dos veces");
  const suma = r.hits.reduce((a, h) => a + (h.counted ? h.weight : 0), 0);
  assert.ok(Math.abs(suma - r.score) < 1e-9, "el desglose tiene que explicar el score");
});

// Una ventana grande haría que un "sin" de cualquier parte del aviso anulara
// una deuda mencionada mucho después.
test("la negación no se estira por todo el aviso", () => {
  const lejos = "Sin detalles de chapa. El motor fue reparado el año pasado y anda impecable. Tiene prenda.";
  assert.ok(labels(lejos).includes("prenda"), "una prenda tres oraciones después del 'sin' sigue contando");
});

test("una negada y una real conviven: sólo cuenta la real", () => {
  const r = evaluateFlags("Sin deuda de patente, pero debe multas.");
  assert.ok(r.hits.some((h) => h.label === "multas"));
  assert.ok(r.neutralised.some((n) => n.label === "deuda de patente"));
  assert.ok(r.score < 0, "la deuda real manda");
});

test("los descalificadores no se ven afectados por todo esto", () => {
  assert.equal(evaluateFlags("Financiación de la casa U$S 5000 y cuotas").disqualified, true);
  assert.equal(evaluateFlags("Nissan March 2015, único dueño, sin deuda").disqualified, false);
});
