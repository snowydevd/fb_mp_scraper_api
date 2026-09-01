import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDealer, countBySellerInBatch, DEALER_THRESHOLD } from "../../src/services/scoring/dealer.mjs";
import { scoreV2 } from "../../src/services/scoring/scorer.mjs";
import { noahCarsDetailNode, privateSaleDetailNode } from "../fixtures/listings.mjs";
import { mapDetail } from "../../src/services/marketplace/detail.mjs";

const reliableRef = { median: 7495, isReliable: true, sampleSize: 14, currency: "USD" };

// The regression this whole module exists for. On 2026-09-01 this listing was
// the ONLY entry that reached the contact queue, and it is a dealership.
test("the NOAHCARS listing is caught even though Facebook called it nothing", () => {
  const detail = mapDetail(noahCarsDetailNode);
  assert.equal(detail.sellerType, null, "the structured field really is empty");
  assert.equal(detail.isDealer, false, "…so the structured-only flag really does miss it");

  const verdict = detectDealer({ title: detail.title, description: detail.description, sellerType: detail.sellerType });
  assert.equal(verdict.isDealer, true);
  assert.equal(verdict.confidence, "high");
  assert.ok(verdict.reasons.length >= 3, `expected several signals, got ${JSON.stringify(verdict.reasons)}`);
});

test("an ordinary private sale is not mistaken for a dealership", () => {
  const detail = mapDetail(privateSaleDetailNode);
  const verdict = detectDealer({ title: detail.title, description: detail.description, sellerType: detail.sellerType });
  assert.equal(verdict.isDealer, false, `false positive on: ${JSON.stringify(verdict.reasons)}`);
});

test("no single soft term is enough on its own", () => {
  // A private seller open to a trade, and nothing else.
  const one = detectDealer({ title: "Vendo Gol", description: "Acepto permuta por moto." });
  assert.equal(one.isDealer, false);
  assert.ok(one.score < DEALER_THRESHOLD);

  // The same seller who also finances and has an escribanía is a business.
  const several = detectDealer({
    title: "Vendo Gol",
    description: "Acepto permuta. Financiación propia. Escribanía y gestoría incluidas.",
  });
  assert.equal(several.isDealer, true);
});

test("Facebook's own DEALER flag is decisive on its own", () => {
  const v = detectDealer({ title: "Fiat Cronos", description: "Impecable", sellerType: "DEALER" });
  assert.equal(v.isDealer, true);
  assert.equal(v.confidence, "high");
});

test("a dealership listing under a personal profile is still caught by listing count", () => {
  const v = detectDealer({ title: "Peugeot 208", description: "Impecable", sellerActiveCount: 4 });
  assert.equal(v.isDealer, true);
  assert.ok(v.signals.some((s) => s.source === "behavioural"));
});

test("accented and unaccented spelling are treated the same", () => {
  const a = detectDealer({ title: "x", description: "Financiación y gestoría" });
  const b = detectDealer({ title: "x", description: "FINANCIACION Y GESTORIA" });
  assert.equal(a.isDealer, b.isDealer);
  assert.deepEqual(a.reasons, b.reasons);
});

test("emoji glued to words do not break the match", () => {
  // "☑️Venta - Permuta -Financiación☑️" - no spaces around the emoji.
  const v = detectDealer({ title: "x", description: "☑️Venta - Permuta -Financiación☑️Consulte financiacion" });
  assert.ok(v.reasons.includes("ofrece financiación"));
});

test("scoreV2 disqualifies a dealership outright, not by weight", () => {
  const base = {
    price: 5990, currencyResolved: "USD", sellerActiveCount: 1,
    title: noahCarsDetailNode.marketplace_listing_title,
    description: noahCarsDetailNode.redacted_description,
  };
  const dealer = scoreV2(base, reliableRef);
  assert.equal(dealer.disqualified, true);
  assert.equal(dealer.score, -1);
  assert.ok(dealer.disqualifiedBy.some((r) => r.startsWith("automotora")));

  // Same price, same market, clean description: must NOT be disqualified.
  const clean = scoreV2({ ...base, title: "Fiat Uno Way", description: "Impecable, único dueño" }, reliableRef);
  assert.notEqual(clean.disqualified, true);
  assert.ok(clean.score > dealer.score);
});

test("the seller subscore carries the verdict so a ranking can explain itself", () => {
  const r = scoreV2(
    { price: 6000, currencyResolved: "USD", title: "Gol", description: "Automotora Los Pinos. Financiamos.", sellerActiveCount: 1 },
    reliableRef
  );
  assert.equal(r.breakdown.seller.value, -1);
  assert.equal(r.breakdown.seller.reason, "likely dealer");
  assert.ok(r.breakdown.seller.dealer.reasons.includes("automotora"));
});

test("countBySellerInBatch groups a batch by seller_id", () => {
  const counts = countBySellerInBatch([
    { id: "1", sellerId: "a" }, { id: "2", sellerId: "a" },
    { id: "3", sellerId: "b" }, { id: "4", sellerId: null },
  ]);
  assert.equal(counts.get("a"), 2);
  assert.equal(counts.get("b"), 1);
  assert.equal(counts.size, 2, "listings without a seller id are not a group");
});
