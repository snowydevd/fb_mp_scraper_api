import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestOffer, draftMessage } from "../../src/services/scoring/offer.mjs";
import { mapDetail } from "../../src/services/marketplace/detail.mjs";

const ref = { median: 12_000, isReliable: true, sampleSize: 14, currency: "USD", source: "meli" };

test("offer is anchored to the market median, not a cut of the asking price", () => {
  const cheap = suggestOffer({ price: 10_000, currencyResolved: "USD" }, ref);
  const dear = suggestOffer({ price: 14_000, currencyResolved: "USD" }, ref);
  assert.equal(cheap.offer, dear.offer, "same car, same market -> same anchor");
  assert.equal(cheap.anchoredTo, "market_median");
});

test("offer never exceeds the asking price, even after rounding", () => {
  // 5 990 rounds to 6 000 on a 50 grid; the result must still be <= asking
  const r = suggestOffer({ price: 5_990, currencyResolved: "USD" }, { ...ref, median: 8_000 });
  assert.ok(r.offer <= 5_990, `offered ${r.offer} against an asking price of 5990`);
});

test("a listing already under market gets a respectful gap and a high outlook", () => {
  const r = suggestOffer({ price: 10_000, currencyResolved: "USD" }, ref);
  assert.ok(r.gapFromAskingPct < 5);
  assert.equal(r.acceptanceOutlook, "alta");
});

test("an overpriced listing is flagged as a long shot rather than silently offered", () => {
  const r = suggestOffer({ price: 14_000, currencyResolved: "USD" }, ref);
  assert.equal(r.acceptanceOutlook, "baja");
  assert.ok(r.gapFromAskingPct > 20);
});

test("no offer is produced from a thin reference", () => {
  const r = suggestOffer({ price: 10_000 }, { median: 12_000, isReliable: false, sampleSize: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /too thin/);
});

test("the draft mentions the listing being old only when it actually is", () => {
  const old = draftMessage(
    { title: "Gol", listedAt: new Date(Date.now() - 45 * 864e5).toISOString() },
    suggestOffer({ price: 10_000, currencyResolved: "USD" }, ref)
  );
  const fresh = draftMessage(
    { title: "Gol", listedAt: new Date().toISOString() },
    suggestOffer({ price: 10_000, currencyResolved: "USD" }, ref)
  );
  assert.match(old, /lleva un tiempo/);
  assert.doesNotMatch(fresh, /lleva un tiempo/);
});

test("mapDetail prefers the description when the odometer attribute contradicts it", () => {
  // Observed live: a financed EcoSport with odometer 5000 and "98000km" in prose
  const d = mapDetail({
    id: "1",
    marketplace_listing_title: "Ford Ecosport Titanium",
    redacted_description: "Motor 2.0 Año 2017 98000km Extrafull",
    vehicle_odometer_data: { unit: "KILOMETERS", value: 5000 },
    listing_price: { amount: "5000.00", currency: "UYU" },
  });
  assert.equal(d.mileageKm, 98_000);
  assert.equal(d.mileageSource, "description_over_conflicting_attribute");
  assert.deepEqual(d.mileageConflict, { attribute: 5000, description: 98000 });
});

test("mapDetail trusts the odometer when the description agrees", () => {
  const d = mapDetail({
    id: "2",
    marketplace_listing_title: "Nissan March",
    redacted_description: "57.000 km reales",
    vehicle_odometer_data: { unit: "KILOMETERS", value: 57_000 },
    listing_price: { amount: "8000.00", currency: "UYU" },
  });
  assert.equal(d.mileageSource, "attribute");
  assert.equal(d.mileageConflict, null);
});

test("mapDetail converts miles to kilometres", () => {
  const d = mapDetail({
    id: "3", marketplace_listing_title: "x", redacted_description: null,
    vehicle_odometer_data: { unit: "MILES", value: 62_137 },
    listing_price: { amount: "9000.00", currency: "UYU" },
  });
  assert.ok(Math.abs(d.mileageKm - 100_000) < 50);
});

// Regression from the live run of 2026-09-01: the single draft produced read
// "oferta USD 5990 (pide 5990)" - an offer to pay exactly the asking price.
test("a car already under market gets a real offer, never the asking price back", () => {
  const r = suggestOffer({ price: 5_990, currencyResolved: "USD" }, { median: 7_495, isReliable: true, sampleSize: 14, currency: "USD" });
  assert.ok(r.ok);
  assert.ok(r.offer < 5_990, `offered ${r.offer} against an asking price of 5990 - that is not an offer`);
  assert.equal(r.anchoredTo, "asking_cash_discount");
  assert.ok(r.gapFromAskingPct >= 2, "the discount has to be worth writing a message about");
});

test("the fallback discount does not override a genuine median anchor", () => {
  const r = suggestOffer({ price: 14_000, currencyResolved: "USD" }, { median: 12_000, isReliable: true, sampleSize: 14, currency: "USD" });
  assert.equal(r.anchoredTo, "market_median");
  assert.equal(r.offer, 9_850);
});

test("the draft admits the price is fair instead of lowballing", () => {
  const r = suggestOffer({ price: 5_990, currencyResolved: "USD" }, { median: 7_495, isReliable: true, sampleSize: 14, currency: "USD" });
  const msg = draftMessage({ title: "Fiat Uno Way" }, r);
  assert.match(msg, /razonable/);
  assert.ok(!msg.includes("5.990"), "the draft must not quote the asking price back as the offer");
});
