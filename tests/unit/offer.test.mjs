import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContactEntry, draftMessage } from "../../src/services/scoring/offer.mjs";

const aviso = (over = {}) => ({
  id: "1734174691163250",
  title: "2008 CITROEN PICASSO 2.0 ",
  description: "Impecable, único dueño",
  price: 6_500, currencyResolved: "USD", url: "https://fb/1",
  mileageKm: 210_000, vehicleYear: 2008, make: "Citroën", model: "C4 Picasso",
  ...over,
});

// La decisión de diseño: el sistema no propone un número.
test("la entrada no trae monto sugerido: el precio lo decide una persona", () => {
  const e = buildContactEntry(aviso());
  assert.equal(e.suggestedOffer, undefined);
  assert.equal(e.rationale, undefined);
  // El título puede traer números legítimos ("2008 CITROEN PICASSO 2.0"); lo
  // que no puede aparecer es un MONTO ni el precio pedido.
  assert.ok(!/USD|U\$S|\$/.test(e.messageDraft), `el borrador nombra una moneda: "${e.messageDraft}"`);
  assert.ok(!e.messageDraft.includes("6.500") && !e.messageDraft.includes("6500"),
    "el borrador no puede devolverle el precio pedido como si fuera una oferta");
});

test("trae los hechos que hacen falta para decidir", () => {
  const { facts } = buildContactEntry(aviso({ listedAt: "2026-07-01T00:00:00Z", priceChangeCount: 2 }));
  assert.equal(facts.price, 6_500);
  assert.equal(facts.currency, "USD");
  assert.equal(facts.mileageKm, 210_000);
  assert.equal(facts.kmPerYear, 11_667, "km/año calculado, que es lo que se mira");
  assert.equal(facts.vehicleYear, 2008);
  assert.equal(facts.priceChangeCount, 2);
  assert.ok(facts.daysListed > 0);
  assert.equal(facts.url, "https://fb/1");
});

test("la deuda declarada va al frente de los hechos", () => {
  const { facts } = buildContactEntry(aviso({ description: "Impecable. Debe 200 dólares de patente." }));
  assert.equal(facts.declaredDebt.amount, 200);
  assert.equal(facts.declaredDebt.currency, "USD");
});

test("sin deuda declarada el campo es null, no cero", () => {
  const { facts } = buildContactEntry(aviso());
  assert.equal(facts.declaredDebt, null, "null distingue 'no debe' de 'debe cero'");
});

// No se descuenta de ningún lado, pero tampoco se pierde.
test("una deuda sin moneda clara queda marcada para revisión", () => {
  const { facts } = buildContactEntry(aviso({ description: "Adeuda $ 12.000" }));
  assert.equal(facts.declaredDebt, null, "no se puede sumar lo que no se sabe en qué moneda está");
  assert.equal(facts.debtNeedsReview.length, 1);
  assert.equal(facts.debtNeedsReview[0].amount, 12_000);
});

test("la mediana del lote viaja como contexto, no como score", () => {
  const { facts } = buildContactEntry(aviso(), { batchMedian: { value: 7_500, currency: "USD", sampleSize: 12 } });
  assert.equal(facts.batchMedian.value, 7_500);
  assert.equal(facts.batchMedian.sampleSize, 12);
});

// --- el borrador ----------------------------------------------------------

test("el borrador abre la conversación sin comprometer un número", () => {
  const msg = draftMessage(aviso());
  assert.match(msg, /Me interesa 2008 CITROEN PICASSO 2\.0\./, "sin espacio antes del punto");
  assert.match(msg, /Pago al contado/);
  assert.ok(!msg.includes("  "), "nada de espacios dobles en algo que vas a mandar");
});

test("menciona la antigüedad sólo cuando es real", () => {
  const viejo = draftMessage(aviso({ listedAt: new Date(Date.now() - 60 * 86_400_000).toISOString() }));
  const nuevo = draftMessage(aviso({ listedAt: new Date(Date.now() - 86_400_000).toISOString() }));
  assert.match(viejo, /lleva un tiempo/);
  assert.match(nuevo, /¿Sigue disponible\?/);
  assert.ok(!nuevo.includes("lleva un tiempo"), "decir eso de una publicación de ayer es peor que no decir nada");
});

test("menciona las bajadas de precio sólo con dos o más", () => {
  assert.match(draftMessage(aviso({ priceChangeCount: 2 })), /ajustaste el precio/);
  assert.ok(!draftMessage(aviso({ priceChangeCount: 1 })).includes("ajustaste"));
});

test("un título vacío no produce un mensaje roto", () => {
  assert.match(draftMessage({ title: "   " }), /Me interesa el vehículo\./);
  assert.match(draftMessage({}), /Me interesa el vehículo\./);
});

test("la entrada nace pendiente: la aprueba una persona", () => {
  assert.equal(buildContactEntry(aviso()).status, "pending");
});
