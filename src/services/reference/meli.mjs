/**
 * MercadoLibre client.
 *
 * The public search endpoint is no longer public: as of this build
 * GET /sites/MLU/search returns 403 PA_UNAUTHORIZED_RESULT_FROM_POLICIES
 * without a token, so an app credential pair is required. /categories/<id>
 * still answers anonymously, which is enough to validate the category id.
 *
 * Set MELI_CLIENT_ID + MELI_CLIENT_SECRET (client-credentials grant), or paste
 * a ready token in MELI_ACCESS_TOKEN. With neither, callers fall back to the
 * internal reference source.
 */
import { config } from "../../config.mjs";

const API = "https://api.mercadolibre.com";

export class MeliUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "MeliUnavailableError";
    this.code = "MELI_UNAVAILABLE";
  }
}

let cachedToken = null; // { value, expiresAt }

async function getToken() {
  if (config.meli.accessToken) return config.meli.accessToken;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  if (!config.meli.clientId || !config.meli.clientSecret) {
    throw new MeliUnavailableError(
      "no MercadoLibre credentials: set MELI_ACCESS_TOKEN, or MELI_CLIENT_ID + MELI_CLIENT_SECRET"
    );
  }

  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.meli.clientId,
      client_secret: config.meli.clientSecret,
    }),
  });
  if (!res.ok) {
    throw new MeliUnavailableError(`token request failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 21600) * 1000 };
  return cachedToken.value;
}

/** True when the configured category id resolves - callable without a token. */
export async function verifyCategory(categoryId = config.meli.carsCategory) {
  const res = await fetch(`${API}/categories/${categoryId}`, { headers: { accept: "application/json" } });
  if (!res.ok) return { ok: false, status: res.status };
  const json = await res.json();
  return { ok: true, id: json.id, name: json.name };
}

/** ¿Están las credenciales y funcionan? Para `npm run meli:check`. */
export async function checkCredentials() {
  const token = await getToken();          // tira MeliUnavailableError si falta
  const res = await fetch(`${API}/sites/${config.meli.siteId}/search?category=${config.meli.carsCategory}&limit=1`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw new MeliUnavailableError(`la búsqueda respondió HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  return { ok: true, total: json.paging?.total ?? null, tokenSource: config.meli.accessToken ? "MELI_ACCESS_TOKEN" : "client_credentials" };
}

/** Un atributo estructurado del item, por id. */
function attr(item, ...ids) {
  for (const a of item.attributes ?? []) if (ids.includes(a.id)) return a;
  return null;
}

const intFrom = (v) => {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * Un item de MercadoLibre en la MISMA forma que un item de Facebook, para que
 * el resto del pipeline no tenga que saber de dónde vino. Puro: testeable con
 * fixtures, sin red.
 *
 * La moneda se respeta tal cual la reporta MELI (`currency_id`) y NO se
 * convierte, igual que del lado de Facebook. Acá sí es confiable: MELI declara
 * la moneda de verdad, no estampa el símbolo de la sesión encima.
 */
export function mapMeliItem(item) {
  if (!item?.id) return null;
  const year = intFrom(attr(item, "VEHICLE_YEAR", "YEAR")?.value_name);
  const km = intFrom(attr(item, "KILOMETERS", "VEHICLE_MILEAGE")?.value_name);
  return {
    source: "meli",
    id: String(item.id),
    title: item.title ?? null,
    price: typeof item.price === "number" ? item.price : null,
    currency: item.currency_id ?? null,
    currencyResolved: item.currency_id ?? null,   // MELI sí dice la verdad
    currencyConfidence: item.currency_id ? "high" : "none",
    vehicleYear: year,
    mileageKm: km,
    make: attr(item, "BRAND")?.value_name ?? null,
    model: attr(item, "MODEL")?.value_name ?? null,
    trim: attr(item, "TRIM", "VERSION")?.value_name ?? null,
    fuelType: attr(item, "FUEL_TYPE")?.value_name ?? null,
    transmission: attr(item, "TRANSMISSION")?.value_name ?? null,
    condition: item.condition ?? null,
    city: item.address?.city_name ?? item.location?.city?.name ?? null,
    state: item.address?.state_name ?? item.location?.state?.name ?? null,
    url: item.permalink ?? `https://articulo.mercadolibre.com.uy/${item.id}`,
    thumbnail: item.thumbnail ?? null,
    // Ley 18.331: del vendedor sólo el id, igual que del lado de Facebook.
    sellerId: item.seller?.id != null ? String(item.seller.id) : null,
  };
}

/**
 * La MISMA búsqueda que se hace en Facebook, con los mismos filtros, contra
 * MercadoLibre. Toma la forma de filtros de `marketplace/url.mjs` para que las
 * dos fuentes se pidan igual.
 *
 * El precio se filtra del lado de MELI (`price=MIN-MAX`), pero ojo: ese rango
 * se aplica sobre el número publicado, y en MLU conviven autos en UYU y en USD.
 * Por eso, si se pide una moneda, se filtra otra vez acá — nunca convirtiendo,
 * sólo descartando lo que está en otra moneda.
 */
export async function searchVehicles({
  minPrice, maxPrice, minYear, maxYear, make, model, currency = null, limit = 50, offset = 0, sort = null,
} = {}) {
  const token = await getToken();
  const params = new URLSearchParams({
    category: config.meli.carsCategory,
    limit: String(Math.min(limit, 50)),
    offset: String(offset),
  });
  const q = [make, model].filter(Boolean).join(" ").trim();
  if (q) params.set("q", q);
  if (minPrice != null || maxPrice != null) {
    params.set("price", `${minPrice ?? "*"}-${maxPrice ?? "*"}`);
  }
  if (minYear != null || maxYear != null) {
    params.set("VEHICLE_YEAR", `${minYear ?? "*"}-${maxYear ?? "*"}`);
  }
  if (sort) params.set("sort", sort);

  const url = `${API}/sites/${config.meli.siteId}/search?${params}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (res.status === 401 || res.status === 403) {
    throw new MeliUnavailableError(`MercadoLibre rechazó el token: HTTP ${res.status}`);
  }
  if (!res.ok) throw new MeliUnavailableError(`la búsqueda falló: HTTP ${res.status}`);

  const json = await res.json();
  let items = (json.results ?? []).map(mapMeliItem).filter(Boolean);

  // Filtros que MELI no aplica o aplica sobre el número sin mirar la moneda.
  if (currency) items = items.filter((i) => i.currency === currency);
  if (minYear != null) items = items.filter((i) => i.vehicleYear == null || i.vehicleYear >= minYear);
  if (maxYear != null) items = items.filter((i) => i.vehicleYear == null || i.vehicleYear <= maxYear);

  return { url, items, total: json.paging?.total ?? items.length };
}

/**
 * Search car listings comparable to a make/model/year band.
 * @returns {Promise<{prices:{price:number,currency:string}[], total:number}>}
 */
export async function searchComparables({ make, model, yearFrom, yearTo, limit = 50 }) {
  const token = await getToken();
  const q = [make, model].filter(Boolean).join(" ");
  const params = new URLSearchParams({
    category: config.meli.carsCategory,
    q,
    limit: String(Math.min(limit, 50)),
  });
  if (yearFrom && yearTo) params.set("ITEM_CONDITION", "2230581"); // usados

  const res = await fetch(`${API}/sites/${config.meli.siteId}/search?${params}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new MeliUnavailableError(`MercadoLibre rejected the token: HTTP ${res.status}`);
  }
  if (!res.ok) throw new MeliUnavailableError(`search failed: HTTP ${res.status}`);

  const json = await res.json();
  const prices = [];
  for (const r of json.results ?? []) {
    // Year lives in the structured attributes; drop anything outside the band
    // so a "Gol 2020" comparable never anchors a 2008 listing.
    const yearAttr = (r.attributes ?? []).find((a) => a.id === "VEHICLE_YEAR" || a.id === "YEAR");
    const year = yearAttr ? parseInt(yearAttr.value_name, 10) : null;
    if (yearFrom && yearTo && year && (year < yearFrom || year > yearTo)) continue;
    if (typeof r.price === "number" && r.price > 0) {
      prices.push({ price: r.price, currency: r.currency_id || "UYU", year });
    }
  }
  return { prices, total: json.paging?.total ?? prices.length };
}
