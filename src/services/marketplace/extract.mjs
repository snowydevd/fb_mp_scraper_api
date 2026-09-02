/**
 * Listing extraction from Facebook's embedded Relay payload.
 *
 * Replaces the DOM/aria-label parser. Facebook ships the full search result set
 * as JSON inside <script type="application/json"> tags
 * (CometMarketplaceSearchRootQueryRelayPreloader), which carries fields the
 * rendered card never shows: creation_time, a numeric price amount,
 * strikethrough_price, is_sold and the category id. Reading it removes every
 * price-parsing workaround the DOM path needed, and survives Facebook rotating
 * its CSS class names.
 */

export class ExtractionError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "ExtractionError";
    this.meta = meta;
  }
}

/** Facebook's node type for a Marketplace listing card. */
const LISTING_TYPENAME = "GroupCommerceProductItem";

/**
 * Pull every listing node out of the page's embedded JSON.
 * Returns raw Facebook nodes; mapping happens in `mapListing` so it can be
 * unit-tested against fixtures without a browser.
 */
/**
 * Camina cualquier objeto buscando nodos de listing. Mismo criterio que el
 * lector de `<script>`: se identifica por `__typename`, no por posición.
 */
function recolectarNodos(raiz, destino) {
  const visit = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const v of o) visit(v); return; }
    if (o.__typename === LISTING_TYPENAME && o.id) destino.set(String(o.id), o);
    for (const k in o) visit(o[k]);
  };
  visit(raiz);
}

/**
 * Junta los avisos que llegan por GraphQL mientras se scrollea.
 *
 * El payload embebido en `<script>` sólo trae la primera página, la que
 * renderizó el servidor: medido en vivo, se queda en 24 por más que se
 * scrollee. Y leer el DOM tampoco sirve, porque la grilla está VIRTUALIZADA —
 * los nodos subieron de 21 a 42 con el primer scroll y volvieron a 22 con el
 * segundo, porque Facebook recicla los que salen de pantalla—.
 *
 * Lo único que persiste es la respuesta: cada scroll dispara una consulta
 * GraphQL con la página siguiente. Es el mismo JSON de Relay, sólo que por la
 * red, así que sigue valiendo la regla de preferirlo antes que los selectores.
 */
export function collectGraphqlListings(page) {
  const nodos = new Map();
  const pendientes = new Set();

  const onResponse = (res) => {
    if (!res.url().includes("/api/graphql")) return;
    const p = (async () => {
      try {
        const texto = await res.text();
        // Facebook manda varios objetos JSON separados por salto de línea en
        // una misma respuesta; parsear el cuerpo entero de una falla.
        for (const linea of texto.split("\n")) {
          const t = linea.trim();
          if (!t.startsWith("{")) continue;
          try { recolectarNodos(JSON.parse(t), nodos); } catch { /* trozo parcial */ }
        }
      } catch {
        // Respuesta abortada o sin cuerpo: no es un error del scrapeo.
      }
    })();
    pendientes.add(p);
    p.finally(() => pendientes.delete(p));
  };

  page.on("response", onResponse);

  return {
    /** Espera a que terminen las lecturas en curso y devuelve lo juntado. */
    async nodes() {
      await Promise.allSettled([...pendientes]);
      return [...nodos.values()];
    },
    stop() {
      page.off("response", onResponse);
    },
  };
}

export async function extractRelayNodes(page) {
  const result = await page.evaluate((typeName) => {
    const nodes = [];
    let scripts = 0;
    let parsed = 0;
    const visit = (o) => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) {
        for (const v of o) visit(v);
        return;
      }
      if (o.__typename === typeName) nodes.push(o);
      for (const k in o) visit(o[k]);
    };
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      scripts++;
      try {
        visit(JSON.parse(s.textContent || "{}"));
        parsed++;
      } catch {
        // A malformed island is normal; other scripts still carry the payload.
      }
    }
    return { nodes, scripts, parsed };
  }, LISTING_TYPENAME);

  if (result.scripts === 0) {
    throw new ExtractionError("no <script type=application/json> found - page shape changed", result);
  }
  // De-duplicate: the same listing appears in several Relay islands.
  const seen = new Set();
  return result.nodes.filter((n) => n?.id && !seen.has(n.id) && seen.add(n.id));
}

/**
 * Uruguayan vehicle listings are quoted in USD but Facebook stamps them with
 * the session currency (UYU): a card reading "11 500 $U" is a car whose own
 * description says "PRECIO: USD 11.500" (verified on listing 783062974741884).
 * `amount` is therefore a bare number whose currency label cannot be trusted
 * for vehicles, so it is resolved by magnitude instead of taken at face value.
 *
 * Nothing is converted or overwritten here - the reported label is preserved
 * and the resolution is returned alongside it with its confidence, so a caller
 * can refuse to score on a low-confidence guess.
 */
export const CURRENCY_BOUNDS = {
  // Below this, a UYU-labelled car price is implausible (USD 2 000 ~ UYU 80 000)
  maxPlausibleUsdAmount: 80_000,
  // Above this it really is pesos (USD 6 250 at ~40 UYU/USD)
  minPlausibleUyuAmount: 250_000,
};

export function resolveVehicleCurrency(amount, reported) {
  if (amount == null || !Number.isFinite(amount)) {
    return { currency: null, confidence: "none", reason: "no amount" };
  }
  if (reported && reported !== "UYU") {
    return { currency: reported, confidence: "high", reason: "explicit non-UYU label" };
  }
  if (amount < CURRENCY_BOUNDS.maxPlausibleUsdAmount) {
    return { currency: "USD", confidence: "high", reason: "too low to be a car priced in UYU" };
  }
  if (amount > CURRENCY_BOUNDS.minPlausibleUyuAmount) {
    return { currency: "UYU", confidence: "high", reason: "too high to be a car priced in USD" };
  }
  return { currency: reported || null, confidence: "low", reason: "amount is plausible in either currency" };
}

/** "$U" / "US$" / "USD" -> ISO code. A bare "$" stays null: genuinely ambiguous. */
export function currencyFromLabel(label) {
  if (!label) return null;
  const t = String(label).replace(/[   ]/g, " ");
  if (/U\$S|US\$|USD/i.test(t)) return "USD";
  if (/UYU|\$U/i.test(t)) return "UYU";
  if (/R\$/.test(t)) return "BRL";
  if (/€/.test(t)) return "EUR";
  return null;
}

import { parseYear } from "./parse.mjs";

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Un kilometraje de grilla que coincide con el precio no es un kilometraje.
 *
 * Los avisos financiados publican la entrega en el campo del odómetro, y en la
 * grilla eso sale como "5.000 km" en un auto que pide USD 5.000. Sin
 * descripción no hay con qué contrastarlo —el detalle sí puede, la grilla no— y
 * el scorer lo lee como un auto impecable de 5.000 km. Medido en una corrida
 * real: 4 de los 6 kilometrajes de grilla eran el precio, y los cuatro eran
 * avisos financiados que se llevaron todo el presupuesto de navegación.
 *
 * La coincidencia exacta entre precio y "kilometraje" no pasa por azar.
 */
export function kilometrajePlausible(km, precio) {
  if (km == null) return null;
  if (precio != null && km === precio) return null;
  return km;
}

/** Grid subtitles sometimes carry mileage ("90 mil km", "165 mil km"). */
export function parseMileageHint(subtitles) {
  const text = (subtitles || []).map((s) => s?.subtitle || "").join(" ");
  if (!text.trim()) return null;
  const mil = text.match(/([\d.,]+)\s*mil\s*(?:km|kms|kil[oó]metros)/i);
  if (mil) return Math.round(parseFloat(mil[1].replace(/[.,]/g, ".")) * 1000);
  const plain = text.match(/([\d][\d.,\s]*)\s*(?:km|kms|kil[oó]metros)/i);
  if (plain) {
    const digits = plain[1].replace(/\D/g, "");
    return digits ? parseInt(digits, 10) : null;
  }
  return null;
}

/**
 * Map one Facebook node to our listing shape. Pure - unit-testable on fixtures.
 * Throws rather than returning a half-empty object when the node has no id,
 * so a Facebook schema change surfaces as a logged failure, never a silent null.
 */
export function mapListing(node) {
  if (!node || !node.id) throw new ExtractionError("listing node has no id", { node });

  const amount = num(node.listing_price?.amount);
  const label = node.listing_price?.formatted_amount ?? null;
  const reported = currencyFromLabel(label);
  const resolved = resolveVehicleCurrency(amount, reported);

  const oldAmount = num(node.strikethrough_price?.amount);
  const geo = node.location?.reverse_geocode ?? null;

  return {
    id: String(node.id),
    title: node.marketplace_listing_title ?? node.custom_title ?? null,

    // Price is stored raw. `currency` is Facebook's own label; `currencyResolved`
    // is our reading of it. Neither is converted - see Fase 2 notes.
    price: amount,
    priceLabel: label,
    currency: reported,
    currencyResolved: resolved.currency,
    currencyConfidence: resolved.confidence,

    oldPrice: oldAmount,
    oldPriceLabel: node.strikethrough_price?.formatted_amount ?? null,

    // Real publication timestamp, straight from Facebook - no "hace 3 semanas"
    // to normalise, and available on the grid rather than the detail page.
    createdAt: node.creation_time ? new Date(node.creation_time * 1000).toISOString() : null,

    city: geo?.city ?? null,
    state: geo?.state || null,
    categoryId: node.marketplace_listing_category_id ?? null,
    sellerId: node.marketplace_listing_seller?.id ?? null,

    // Mileage and year are cheap guesses off the grid - the subtitle and the
    // title. They are not as good as the detail page's structured fields, but
    // they are what decides WHICH listings are worth opening at all, and
    // opening one costs a rate-limited navigation.
    mileageHint: kilometrajePlausible(parseMileageHint(node.custom_sub_titles_with_rendering_flags), amount),
    vehicleYearHint: parseYear(node.marketplace_listing_title ?? node.custom_title, null),

    isSold: node.is_sold ?? null,
    isLive: node.is_live ?? null,
    isPending: node.is_pending ?? null,

    thumbnail: node.primary_listing_photo?.image?.uri ?? null,
    url: `https://www.facebook.com/marketplace/item/${node.id}/`,
  };
}

export function mapListings(nodes) {
  const items = [];
  const failures = [];
  for (const n of nodes) {
    try {
      items.push(mapListing(n));
    } catch (err) {
      failures.push({ id: n?.id ?? null, message: err.message });
    }
  }
  return { items, failures };
}
