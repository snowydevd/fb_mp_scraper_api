import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFlags } from "../../src/services/scoring/flags.mjs";
import { normalizeText } from "../../src/services/scoring/text.mjs";

// Regression: every one of these scored a clean zero before the patterns were
// moved onto normalised text. The live run of 2026-09-01 produced
// hits: [] for a description reading "☑️Venta - Permuta -Financiación☑️".
test("accented spelling no longer slips past the flags", () => {
  assert.ok(evaluateFlags("Financiación propia").hits.some((h) => h.label === "financiación"));
  assert.ok(evaluateFlags("financiacion propia").hits.some((h) => h.label === "financiación"));
  assert.ok(evaluateFlags("FINANCIAMOS").hits.some((h) => h.label === "financiación"));
  assert.ok(evaluateFlags("Permuta").hits.some((h) => h.label === "permuto"));
  assert.ok(evaluateFlags("Único dueño").hits.some((h) => h.label === "único dueño"));
  assert.ok(evaluateFlags("unico dueno").hits.some((h) => h.label === "único dueño"));
  assert.ok(evaluateFlags("papeles al dia").hits.some((h) => h.label === "papeles al día"));
});

test("the exact NOAHCARS description now produces hits instead of silence", () => {
  const r = evaluateFlags("☑️Venta - Permuta -Financiación☑️\nContamos con servicio de escribania y gestoria");
  assert.ok(r.hits.length > 0, "this returned [] before normalisation");
  assert.ok(r.score < 0);
});

test("the disqualifiers survive accents and emoji", () => {
  assert.equal(evaluateFlags("💰Financiación de la casa U$S 5000 y cuotas💰").disqualified, true);
  assert.equal(evaluateFlags("Entrega U$S 3.000 y 24 cuotas").disqualified, true);
  assert.equal(evaluateFlags("Anticipo y cuotas fijas").disqualified, true);
});

test("normalizeText separates rather than deletes, so word boundaries survive", () => {
  // Deleting the emoji outright would weld "Permuta" to "Financiación".
  assert.equal(normalizeText("☑️Venta - Permuta -Financiación☑️"), "venta - permuta -financiacion");
  assert.equal(normalizeText("140 000 km"), "140 000 km", "the no-break space FB emits becomes a plain one");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText("   "), "");
});

test("normalizeText keeps the characters the price patterns need", () => {
  assert.equal(normalizeText("Entrega U$S 3.000"), "entrega u$s 3.000");
});
