import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreV1, scoreV2, priceScore, priceDropScore, stalenessScore,
  priceChangeScore, kmScore, sellerScore, SCALES,
} from "../../src/services/scoring/scorer.mjs";
import { evaluateFlags } from "../../src/services/scoring/flags.mjs";

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const reliableRef = { median: 10_000, sampleSize: 12, isReliable: true, currency: "USD" };

test("priceScore: 25% under market is full strength", () => {
  const r = priceScore(7_500, reliableRef);
  assert.equal(r.applicable, true);
  assert.equal(r.value, 1);
  assert.equal(Math.round(r.discount * 100), 25);
});

test("priceScore: above market goes negative", () => {
  assert.ok(priceScore(12_000, reliableRef).value < 0);
});

test("priceScore: not applicable without a reference", () => {
  assert.equal(priceScore(7_500, null).applicable, false);
  assert.equal(priceScore(null, reliableRef).applicable, false);
});

test("priceDropScore: a 15% cut is full strength, no drop scores zero", () => {
  assert.equal(priceDropScore(8_500, 10_000).value, 1);
  assert.equal(priceDropScore(10_000, null).applicable, false);
  assert.equal(priceDropScore(10_000, 9_000).applicable, false, "a price rise is not a drop");
});

test("stalenessScore prefers Facebook's creation_time over first_seen_at", () => {
  const r = stalenessScore({ listedAt: daysAgo(30), firstSeenAt: daysAgo(2) });
  assert.equal(r.source, "facebook_creation_time");
  assert.equal(r.days, 30);
  assert.ok(Math.abs(r.value - 0.5) < 0.02);
});

test("stalenessScore falls back to first_seen_at", () => {
  assert.equal(stalenessScore({ listedAt: null, firstSeenAt: daysAgo(60) }).source, "first_seen_at");
});

test("priceChangeScore counts drops", () => {
  assert.equal(priceChangeScore(0).applicable, false);
  assert.ok(priceChangeScore(2).value > priceChangeScore(1).value);
  assert.equal(priceChangeScore(5).value, 1, "caps at full strength");
});

test("kmScore judges km per year, not absolute km", () => {
  const now = new Date("2026-01-01");
  const old = kmScore({ mileageKm: 150_000, vehicleYear: 2010, now });   // ~9.4k/yr
  const recent = kmScore({ mileageKm: 150_000, vehicleYear: 2022, now }); // ~37k/yr
  assert.ok(old.value > recent.value, "same km is worse on a newer car");
  assert.ok(recent.value < 0);
});

test("kmScore penalises implausibly low mileage for the age", () => {
  const r = kmScore({ mileageKm: 20_000, vehicleYear: 2005, now: new Date("2026-01-01") });
  assert.ok(r.value < 0);
  assert.match(r.reason, /implausibly low/);
});

test("sellerScore treats 3+ active listings as a dealer", () => {
  assert.equal(sellerScore(3).value, -1);
  assert.ok(sellerScore(2).value < 0);
  assert.ok(sellerScore(1).value > 0);
  assert.equal(sellerScore(0).applicable, false);
});

test("flags: encumbrance outweighs a mild negative", () => {
  const prenda = evaluateFlags("Vendo auto con prenda");
  const permuto = evaluateFlags("Vendo auto, permuto");
  assert.ok(prenda.score < permuto.score);
  assert.deepEqual(prenda.hits.map((h) => h.label), ["prenda"]);
});

test("flags: 'libre de deuda' is not read as a debt", () => {
  const r = evaluateFlags("Impecable, libre de deuda, único dueño");
  assert.ok(r.score > 0, `expected positive, got ${r.score}`);
});

test("flags: clean text scores neutral", () => {
  assert.equal(evaluateFlags("Volkswagen Gol 1.6 nafta").score, 0);
});

test("scoreV1: a cheap, stale, twice-reduced listing outranks a fresh full-price one", () => {
  const bargain = scoreV1(
    { price: 7_500, oldPrice: 9_000, listedAt: daysAgo(45), priceChangeCount: 2, currencyResolved: "USD" },
    reliableRef
  );
  const plain = scoreV1(
    { price: 10_000, oldPrice: null, listedAt: daysAgo(1), priceChangeCount: 0, currencyResolved: "USD" },
    reliableRef
  );
  assert.ok(bargain.score > plain.score);
  assert.equal(bargain.version, "v1");
});

test("scoreV1: breakdown explains every subscore with its weight and contribution", () => {
  const r = scoreV1({ price: 8_000, listedAt: daysAgo(10), currencyResolved: "USD" }, reliableRef);
  // km and seller are here because v1 is what spends the detail-fetch budget:
  // ranking on price alone sent all five of a run's fetches to listings that
  // v2 then disqualified.
  assert.deepEqual(Object.keys(r.breakdown).sort(), ["km", "price", "priceChanges", "priceDrop", "seller", "staleness"]);
  for (const sub of Object.values(r.breakdown)) {
    assert.ok("weight" in sub && "contribution" in sub);
  }
  const sum = Object.values(r.breakdown).reduce((s, b) => s + b.contribution, 0);
  assert.ok(Math.abs(sum - r.score) < 0.001, "score is the sum of contributions");
});

test("scoreV1: a thin reference cannot dominate the score", () => {
  const thin = { median: 10_000, sampleSize: 2, isReliable: false, currency: "USD" };
  const listing = { price: 5_000, listedAt: daysAgo(5), currencyResolved: "USD" };
  const withThin = scoreV1(listing, thin);
  const withSolid = scoreV1(listing, reliableRef);
  assert.equal(withThin.weightsAdjustedForThinReference, true);
  assert.ok(withThin.breakdown.price.weight < withSolid.breakdown.price.weight);
  assert.ok(withThin.score < withSolid.score);
});

test("scoreV2: a dealer listing is pushed below an equivalent private one", () => {
  const base = {
    price: 7_500, oldPrice: 9_000, listedAt: daysAgo(40), priceChangeCount: 1,
    mileageKm: 120_000, vehicleYear: 2012, currencyResolved: "USD",
    title: "Volkswagen Gol", description: "Único dueño, papeles al día",
  };
  const priv = scoreV2({ ...base, sellerActiveCount: 1 }, reliableRef);
  const dealer = scoreV2({ ...base, sellerActiveCount: 7 }, reliableRef);
  assert.ok(priv.score > dealer.score);
  assert.equal(dealer.breakdown.seller.reason, "likely dealer");
});

test("scoreV2: an encumbered car scores below a clean one, all else equal", () => {
  const base = {
    price: 7_500, listedAt: daysAgo(30), mileageKm: 120_000, vehicleYear: 2012,
    sellerActiveCount: 1, currencyResolved: "USD", title: "Gol",
  };
  const clean = scoreV2({ ...base, description: "Impecable" }, reliableRef);
  const dirty = scoreV2({ ...base, description: "Tiene prenda y saldo a pagar" }, reliableRef);
  assert.ok(clean.score > dirty.score);
  assert.ok(dirty.breakdown.flags.hits.length >= 2);
});

test("flags: a financed listing is disqualified, not merely penalised", () => {
  const r = evaluateFlags("Ford Ecosport. Financiación de la casa U$S 5000 y cuotas");
  assert.equal(r.disqualified, true);
  assert.ok(r.hits.some((h) => h.disqualifies));
});

test("flags: 'Entrega de 5000 Usd y cuotas' is disqualifying", () => {
  assert.equal(evaluateFlags("Vendo - permuto - financio. Entrega de 5000 Usd y cuotas").disqualified, true);
});

test("flags: an ordinary listing is not disqualified", () => {
  assert.equal(evaluateFlags("Nissan March 2015, 57.000 km, único dueño").disqualified, false);
});

test("scoreV2: a disqualified listing is forced to the bottom despite a great price", () => {
  const base = {
    price: 5_000, listedAt: daysAgo(40), mileageKm: 98_000, vehicleYear: 2017,
    sellerActiveCount: 1, currencyResolved: "USD", title: "Ford Ecosport Titanium",
  };
  const financed = scoreV2({ ...base, description: "Financiación de la casa U$S 5000 y cuotas" }, reliableRef);
  const normal = scoreV2({ ...base, description: "Impecable, papeles al día" }, reliableRef);
  assert.equal(financed.disqualified, true);
  assert.equal(financed.score, -1);
  assert.ok(normal.score > financed.score);
});

// The detail budget is the scarce resource: opening a listing costs a
// rate-limited navigation, and in the run of 2026-09-01 all five went to
// listings that v2 then threw away.
test("scoreV1: a listing that names its dealership in the title loses its place in the queue", () => {
  const base = { price: 5_990, listedAt: daysAgo(5), currencyResolved: "USD" };
  const priv = scoreV1({ ...base, title: "Fiat uno way divino con A/C" }, reliableRef);
  const dealer = scoreV1({ ...base, title: "Fiat uno way divino con A/C NOAHCARS" }, reliableRef);
  assert.ok(priv.score > dealer.score, "the dealership must rank below an identical private listing");
  // A title alone is suspicion, not a verdict: "NOAHCARS" scores 0.5 against a
  // threshold of 0.6. It demotes the listing without claiming to be sure, and
  // the real call is made in v2 once the description is in hand.
  assert.equal(dealer.dealer.isDealer, false);
  assert.ok(dealer.dealer.score > 0);
  assert.equal(dealer.breakdown.seller.reason, "possible dealer");
  assert.equal(priv.dealer.score, 0);
});

test("scoreV1: the grid's own hints feed the km subscore", () => {
  const fresh = scoreV1(
    { price: 8_000, listedAt: daysAgo(5), currencyResolved: "USD", mileageHint: 60_000, vehicleYearHint: 2015 },
    reliableRef
  );
  const worn = scoreV1(
    { price: 8_000, listedAt: daysAgo(5), currencyResolved: "USD", mileageHint: 330_000, vehicleYearHint: 2015 },
    reliableRef
  );
  assert.equal(fresh.breakdown.km.applicable, true, "the hints must actually be read");
  assert.ok(fresh.score > worn.score);
});

test("scoreV1: a listing with no hints simply does not get a km subscore", () => {
  const r = scoreV1({ price: 8_000, listedAt: daysAgo(5), currencyResolved: "USD" }, reliableRef);
  assert.equal(r.breakdown.km.applicable, false);
  assert.equal(r.breakdown.km.contribution, 0, "an inapplicable subscore contributes nothing");
});

test("scoreV1 never disqualifies: that needs the description, which the grid lacks", () => {
  const r = scoreV1({ price: 5_990, listedAt: daysAgo(5), currencyResolved: "USD", title: "Fiat uno NOAHCARS" }, reliableRef);
  assert.notEqual(r.disqualified, true, "a grid-only verdict must demote, not decide");
  assert.ok(r.score > -1);
});
