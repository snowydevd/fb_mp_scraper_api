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
