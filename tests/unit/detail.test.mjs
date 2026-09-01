import { test } from "node:test";
import assert from "node:assert/strict";
import { mapDetail, parseMileageFromText, parseYear } from "../../src/services/marketplace/detail.mjs";
import { noahCarsDetailNode, privateSaleDetailNode } from "../fixtures/listings.mjs";

test("mapDetail reads the full description, not the collapsed one", () => {
  const d = mapDetail(noahCarsDetailNode);
  assert.ok(d.description.includes("Consulte financiacion"),
    "the last line is exactly what 'Ver más' hides, and exactly what matters");
});

test("mapDetail prefers the structured odometer when it agrees with the prose", () => {
  const d = mapDetail(noahCarsDetailNode);
  assert.equal(d.mileageKm, 118_000);
  assert.equal(d.mileageSource, "attribute");
  assert.equal(d.mileageConflict, null);
});

// Observed live: a financed 2017 EcoSport whose odometer field held the down
// payment (5000) while the description said 98 000 km.
test("mapDetail distrusts an odometer that contradicts the description", () => {
  const d = mapDetail({
    ...noahCarsDetailNode,
    vehicle_odometer_data: { unit: "KILOMETERS", value: 5000 },
    redacted_description: "Ford Ecosport 2017, 98000 km, financiación de la casa",
  });
  assert.equal(d.mileageKm, 98_000, "the prose is what the seller actually wrote");
  assert.equal(d.mileageSource, "description_over_conflicting_attribute");
  assert.deepEqual(d.mileageConflict, { attribute: 5000, description: 98_000 });
});

test("mapDetail converts miles to kilometres", () => {
  const d = mapDetail({ ...noahCarsDetailNode, vehicle_odometer_data: { unit: "MILES", value: 60_000 }, redacted_description: "sin datos" });
  assert.equal(d.mileageKm, 96_560);
});

test("mapDetail does not read the seller's phone or name (Ley 18.331)", () => {
  const d = mapDetail({ ...noahCarsDetailNode, seller_phone_number: "099123456", marketplace_listing_seller: { name: "Juan Pérez" } });
  const serialised = JSON.stringify(d);
  assert.ok(!serialised.includes("099123456"));
  assert.ok(!serialised.includes("Juan"));
  assert.deepEqual(Object.keys(d).filter((k) => /phone|name/i.test(k)), [],
    "the only seller field kept is the id");
});

test("mapDetail resolves the currency without normalising the amount", () => {
  const d = mapDetail(privateSaleDetailNode);
  assert.equal(d.price, 7200);
  assert.equal(d.currencyReported, "USD");
  assert.equal(d.currencyResolved, "USD");
});

test("mapDetail turns creation_time into the real publication date", () => {
  const d = mapDetail(privateSaleDetailNode);
  assert.equal(d.listedAt, new Date(1_755_000_000_000).toISOString());
});

test("isDealer stays false when Facebook says nothing - which is why the text pass exists", () => {
  assert.equal(mapDetail(noahCarsDetailNode).isDealer, false);
  assert.equal(mapDetail({ ...noahCarsDetailNode, dealership_name: "Noah Cars" }).isDealer, true);
  assert.equal(mapDetail({ ...noahCarsDetailNode, vehicle_seller_type: "DEALER" }).isDealer, true);
});

test("parseMileageFromText handles the ways Uruguayans write mileage", () => {
  assert.equal(parseMileageFromText("140.000 km").km, 140_000);
  assert.equal(parseMileageFromText("140 000 km").km, 140_000);
  assert.equal(parseMileageFromText("140mil kms").km, 140_000);
  assert.equal(parseMileageFromText("140 mil kilómetros").km, 140_000);
  assert.equal(parseMileageFromText("57000km").km, 57_000);
});

// A looser span would swallow the model year and read 201 798 000 km.
test("parseMileageFromText does not swallow the year preceding the figure", () => {
  assert.equal(parseMileageFromText("Año 2017 98000km").km, 98_000);
});

test("parseMileageFromText rejects implausible figures rather than guessing", () => {
  assert.equal(parseMileageFromText("500 km"), null, "under 1 000 km on a used car is a typo, not a reading");
  assert.equal(parseMileageFromText("motor 1.6, full"), null);
  assert.equal(parseMileageFromText(""), null);
  assert.equal(parseMileageFromText(null), null);
});

test("parseYear prefers the title and stays inside a plausible range", () => {
  assert.equal(parseYear("Nissan March 2015", "comprado en 2019"), 2015);
  assert.equal(parseYear("Nissan March", "modelo 2015"), 2015);
  assert.equal(parseYear("Nissan March", "1970 algo"), null);
  assert.equal(parseYear(null, null), null);
});
