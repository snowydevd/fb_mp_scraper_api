/**
 * Marketplace URL building for the vehicles category.
 *
 * Fase 1: the keyword path ("?query=auto") is unusable for cars - it returns
 * ride-on toys, child seats and Hot Wheels. Facebook exposes a real vehicles
 * category whose filters run server-side, which is what this builds.
 *
 * Verified against facebook.com (anonymous, es-ES, Montevideo):
 *   /marketplace/<loc>/cars      -> only cars & light trucks   (category 807311116002614)
 *   /marketplace/<loc>/vehicles  -> broader: motorcycles, ATVs, karts, parts
 * so `cars` is the default path for this pipeline.
 */

export const VEHICLE_CATEGORY_ID = "807311116002614";

/** Marketplace category slugs we build URLs for. */
export const CATEGORY_PATHS = {
  cars: "cars", // autos y camionetas - the one this pipeline targets
  vehicles: "vehicles", // everything with wheels, incl. parts
};

/**
 * Location slugs are NOT validated by Facebook: an unknown slug silently
 * serves another city's results (verified - "noexisteestaciudad999" returned
 * listings from San Jose, CA). Anything not on this list is rejected locally
 * so a typo can never masquerade as real Montevideo inventory.
 */
export const KNOWN_LOCATIONS = new Set([
  "montevideo",
  "canelones",
  "maldonado",
  "salto",
  "paysandu",
  "rivera",
  // Lowercase only: normalizeVehicleFilters folds the caller's input to
  // lowercase before this lookup, so a camelCase entry here ("lasPiedras")
  // could never be matched and silently rejected a valid location.
  "laspiedras",
  "ciudaddelacosta",
]);

export class FilterError extends Error {
  constructor(message) {
    super(message);
    this.name = "FilterError";
  }
}

const CURRENT_YEAR = new Date().getFullYear();

function int(value, name, { min, max }) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new FilterError(`${name} must be an integer`);
  if (n < min || n > max) throw new FilterError(`${name} must be between ${min} and ${max}`);
  return n;
}

function str(value, name, maxLen = 60) {
  if (value == null || value === "") return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  if (s.length > maxLen) throw new FilterError(`${name} is too long`);
  if (!/^[\p{L}\p{N} .\-_/]+$/u.test(s)) throw new FilterError(`${name} has invalid characters`);
  return s;
}

/**
 * Normalise and validate a vehicle filter set.
 *
 * @param {object} raw
 * @param {string} [raw.location]   location slug, default "montevideo"
 * @param {number} [raw.minPrice]   price bounds, in the listing's own currency
 * @param {number} [raw.maxPrice]
 * @param {number} [raw.minYear]    model year bounds
 * @param {number} [raw.maxYear]
 * @param {number} [raw.maxMileage] kilometres
 * @param {string} [raw.make]
 * @param {string} [raw.model]
 * @param {number} [raw.radiusKm]
 * @param {string} [raw.sortBy]
 * @param {string} [raw.category]   "cars" (default) or "vehicles"
 * @returns {object} validated filters
 */
export function normalizeVehicleFilters(raw = {}) {
  const location = String(raw.location || "montevideo").trim().toLowerCase();
  if (!KNOWN_LOCATIONS.has(location)) {
    throw new FilterError(
      `unknown location "${location}" - Facebook silently serves another city for unknown slugs. Known: ${[...KNOWN_LOCATIONS].join(", ")}`
    );
  }

  const category = String(raw.category || "cars");
  if (!CATEGORY_PATHS[category]) {
    throw new FilterError(`category must be one of: ${Object.keys(CATEGORY_PATHS).join(", ")}`);
  }

  const f = {
    location,
    category,
    minPrice: int(raw.minPrice, "minPrice", { min: 0, max: 100_000_000 }),
    maxPrice: int(raw.maxPrice, "maxPrice", { min: 0, max: 100_000_000 }),
    minYear: int(raw.minYear, "minYear", { min: 1900, max: CURRENT_YEAR + 1 }),
    maxYear: int(raw.maxYear, "maxYear", { min: 1900, max: CURRENT_YEAR + 1 }),
    maxMileage: int(raw.maxMileage, "maxMileage", { min: 0, max: 2_000_000 }),
    radiusKm: int(raw.radiusKm, "radiusKm", { min: 1, max: 500 }),
    make: str(raw.make, "make"),
    model: str(raw.model, "model"),
    sortBy: raw.sortBy ? String(raw.sortBy) : undefined,
  };

  if (f.minPrice != null && f.maxPrice != null && f.minPrice > f.maxPrice) {
    throw new FilterError("minPrice cannot be greater than maxPrice");
  }
  if (f.minYear != null && f.maxYear != null && f.minYear > f.maxYear) {
    throw new FilterError("minYear cannot be greater than maxYear");
  }
  return f;
}

const SORTS = new Set(["creation_time_descend", "price_ascend", "price_descend", "distance_ascend"]);

/**
 * Build the category URL. Every bound goes into the query string so Facebook
 * filters server-side; nothing here is re-filtered afterwards.
 */
export function buildVehicleUrl(filters) {
  const f = normalizeVehicleFilters(filters);
  const base = `https://www.facebook.com/marketplace/${f.location}/${CATEGORY_PATHS[f.category]}`;
  const p = new URLSearchParams();

  if (f.minPrice != null) p.set("minPrice", String(f.minPrice));
  if (f.maxPrice != null) p.set("maxPrice", String(f.maxPrice));
  if (f.minYear != null) p.set("minYear", String(f.minYear));
  if (f.maxYear != null) p.set("maxYear", String(f.maxYear));
  if (f.maxMileage != null) p.set("maxMileage", String(f.maxMileage));
  if (f.radiusKm != null) p.set("radius", String(f.radiusKm));
  if (f.make) p.set("make", f.make);
  if (f.model) p.set("model", f.model);
  if (f.sortBy && SORTS.has(f.sortBy)) p.set("sortBy", f.sortBy);

  const qs = p.toString();
  return { url: qs ? `${base}?${qs}` : base, filters: f };
}
