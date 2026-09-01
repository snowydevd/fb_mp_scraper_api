import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVehicleUrl, normalizeVehicleFilters, FilterError, KNOWN_LOCATIONS,
} from "../../src/services/marketplace/url.mjs";

test("the default path is the cars category, not the keyword search", () => {
  const { url } = buildVehicleUrl({ location: "montevideo" });
  assert.equal(url, "https://www.facebook.com/marketplace/montevideo/cars");
  assert.ok(!url.includes("query="), "Fase 1: the keyword path returns toys, not cars");
});

test("every bound is pushed into the query string so Facebook filters server-side", () => {
  const { url } = buildVehicleUrl({
    location: "canelones", category: "cars",
    minPrice: 5000, maxPrice: 12000, minYear: 2008, maxYear: 2018,
    maxMileage: 200_000, radiusKm: 60, make: "Chevrolet", model: "Corsa",
    sortBy: "creation_time_descend",
  });
  const q = new URL(url).searchParams;
  assert.equal(new URL(url).pathname, "/marketplace/canelones/cars");
  assert.equal(q.get("minPrice"), "5000");
  assert.equal(q.get("maxPrice"), "12000");
  assert.equal(q.get("minYear"), "2008");
  assert.equal(q.get("maxYear"), "2018");
  assert.equal(q.get("maxMileage"), "200000");
  assert.equal(q.get("radius"), "60");
  assert.equal(q.get("make"), "Chevrolet");
  assert.equal(q.get("sortBy"), "creation_time_descend");
});

// Facebook serves another city's listings for an unknown slug instead of
// erroring, so a typo would quietly produce San Jose, CA inventory.
test("an unknown location is rejected locally rather than served as Montevideo", () => {
  assert.throws(() => buildVehicleUrl({ location: "noexisteestaciudad999" }), FilterError);
  for (const loc of KNOWN_LOCATIONS) {
    assert.doesNotThrow(() => buildVehicleUrl({ location: loc }), `${loc} should be accepted`);
  }
});

test("contradictory bounds are rejected", () => {
  assert.throws(() => normalizeVehicleFilters({ minPrice: 9000, maxPrice: 5000 }), FilterError);
  assert.throws(() => normalizeVehicleFilters({ minYear: 2020, maxYear: 2010 }), FilterError);
});

test("non-integer and out-of-range bounds are rejected", () => {
  assert.throws(() => normalizeVehicleFilters({ minPrice: "cheap" }), FilterError);
  assert.throws(() => normalizeVehicleFilters({ minYear: 1500 }), FilterError);
  assert.throws(() => normalizeVehicleFilters({ radiusKm: 5000 }), FilterError);
});

test("an unknown sort is dropped, not passed through", () => {
  const { url } = buildVehicleUrl({ location: "montevideo", sortBy: "'; DROP TABLE" });
  assert.ok(!url.includes("sortBy"), "only the known sorts reach Facebook");
});

test("empty strings mean 'unset', not 'invalid'", () => {
  const f = normalizeVehicleFilters({ location: "montevideo", minPrice: "", make: "" });
  assert.equal(f.minPrice, undefined);
  assert.equal(f.make, undefined);
});
