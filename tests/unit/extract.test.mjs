import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapListing, mapListings, resolveVehicleCurrency, currencyFromLabel,
  parseMileageHint, ExtractionError, CURRENCY_BOUNDS,
} from "../../src/services/marketplace/extract.mjs";

const gridNode = (over = {}) => ({
  id: "1487450843409462",
  marketplace_listing_title: "Auto Lifan 320 1.3 Gris",
  listing_price: { amount: "125000", formatted_amount: "125 000 $U" },
  strikethrough_price: { amount: "140000", formatted_amount: "140 000 $U" },
  creation_time: 1_756_000_000,
  location: { reverse_geocode: { city: "Colonia Nicolich", state: "Canelones" } },
  marketplace_listing_category_id: "807311116002614",
  marketplace_listing_seller: { id: "6155000000" },
  primary_listing_photo: { image: { uri: "https://scontent/x.jpg" } },
  is_sold: false,
  ...over,
});

test("mapListing keeps price and currency apart and never converts", () => {
  const m = mapListing(gridNode());
  assert.equal(m.price, 125_000);
  assert.equal(m.currency, "UYU", "what Facebook's label said");
  assert.equal(m.currencyResolved, "UYU", "what we believe it is");
  assert.equal(m.priceLabel, "125 000 $U");
});

test("mapListing surfaces a schema change instead of returning a half-empty row", () => {
  assert.throws(() => mapListing({ marketplace_listing_title: "no id" }), ExtractionError);
  assert.throws(() => mapListing(null), ExtractionError);
});

test("mapListing turns creation_time into a real timestamp", () => {
  const m = mapListing(gridNode());
  assert.equal(m.createdAt, new Date(1_756_000_000_000).toISOString());
  assert.equal(mapListing(gridNode({ creation_time: null })).createdAt, null);
});

test("mapListing carries the strikethrough price - a free motivated-seller signal", () => {
  const m = mapListing(gridNode());
  assert.equal(m.oldPrice, 140_000);
  assert.equal(mapListing(gridNode({ strikethrough_price: null })).oldPrice, null);
});

test("mapListings reports failures rather than dropping them silently", () => {
  const { items, failures } = mapListings([gridNode(), { no: "id" }, gridNode({ id: "2" })]);
  assert.equal(items.length, 2);
  assert.equal(failures.length, 1);
});

test("currencyFromLabel reads the Uruguayan symbols, and leaves a bare $ alone", () => {
  assert.equal(currencyFromLabel("7 500 US$"), "USD");
  assert.equal(currencyFromLabel("U$S 7.500"), "USD");
  assert.equal(currencyFromLabel("125 000 $U"), "UYU");
  assert.equal(currencyFromLabel("$ 7500"), null, "a bare $ is genuinely ambiguous here");
  assert.equal(currencyFromLabel(null), null);
});

test("resolveVehicleCurrency overrides an implausible UYU label", () => {
  // Facebook stamps USD-priced cars with the session's UYU symbol.
  const r = resolveVehicleCurrency(7_500, "UYU");
  assert.equal(r.currency, "USD");
  assert.equal(r.confidence, "high");
});

test("resolveVehicleCurrency keeps a genuinely UYU-sized amount in pesos", () => {
  const r = resolveVehicleCurrency(390_000, "UYU");
  assert.equal(r.currency, "UYU");
  assert.equal(r.confidence, "high");
});

test("resolveVehicleCurrency admits when the amount is plausible in either", () => {
  const between = (CURRENCY_BOUNDS.maxPlausibleUsdAmount + CURRENCY_BOUNDS.minPlausibleUyuAmount) / 2;
  const r = resolveVehicleCurrency(between, "UYU");
  assert.equal(r.confidence, "low", "a low-confidence reading must be labelled, not guessed");
});

test("parseMileageHint reads the grid subtitle formats", () => {
  assert.equal(parseMileageHint([{ subtitle: "90 mil km" }]), 90_000);
  assert.equal(parseMileageHint([{ subtitle: "165.000 km" }]), 165_000);
  assert.equal(parseMileageHint([{ subtitle: "Nafta" }]), null);
  assert.equal(parseMileageHint([]), null);
  assert.equal(parseMileageHint(null), null);
});
