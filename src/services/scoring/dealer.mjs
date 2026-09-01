/**
 * Dealership / reseller detection.
 *
 * Why this exists: the pipeline's whole premise is buying from a private seller
 * with a reason to move the car. A dealership has margin to defend, prices at
 * market, and never accepts a cash offer under it - so a dealer listing at the
 * top of the ranking is not a near-miss, it is noise that costs an approach.
 *
 * Facebook's own `vehicle_seller_type` is authoritative WHEN PRESENT, and it
 * very often isn't: listing 1049705647676534 ("Fiat uno way divino con A/C
 * NOAHCARS") came back with vehicle_seller_type: null and dealership_name: null
 * while its description read "Noah Cars / Venta - Permuta - Financiación /
 * Contamos con servicio de escribania y gestoria". So three independent
 * families of signal are combined and none of them is trusted alone:
 *
 *   structured  vehicle_seller_type, dealership_name          (decisive)
 *   behavioural N distinct active listings from one seller_id (decisive at 3+)
 *   textual     the vocabulary of a car business                (accumulative)
 *
 * The textual signals are individually weak on purpose. "Permuta" alone is a
 * private seller open to a trade; "permuta" plus "financiación" plus
 * "escribanía" is a business. Weights accumulate to a threshold instead of any
 * single term flipping the verdict.
 */
import { normalizeText } from "./text.mjs";

/** Score at or above which a listing is treated as a dealership. */
export const DEALER_THRESHOLD = 0.6;
/** Score at or above which the verdict is strong enough to disqualify. */
export const DEALER_HIGH_CONFIDENCE = 1.0;

/**
 * Patterns run against the normalised (unaccented, lowercased) title +
 * description. Weights are per-term, tuned so that any two "business
 * operations" terms clear the threshold and one alone does not.
 */
export const DEALER_TERMS = [
  // --- trade names: a business identifying itself ------------------------
  { re: /\bautomotora?s?\b/, weight: 0.7, label: "automotora" },
  { re: /\bconcesionaria?\b/, weight: 0.7, label: "concesionaria" },
  { re: /\bmultimarcas?\b/, weight: 0.7, label: "multimarca" },
  { re: /\b(?:auto|car)s? ?(?:center|centre|house|shop|store)\b/, weight: 0.7, label: "car center" },
  { re: /\b\w+ ?(?:cars|motors|automotores|autos)\b/, weight: 0.5, label: "nombre comercial (cars/motors/autos)" },
  { re: /\b(?:s\.?a\.?s?|s\.?r\.?l\.?)\b/, weight: 0.4, label: "razón social" },

  // --- financing: the single strongest behavioural marker ----------------
  // Covers financiación / financiacion / financiamos / financiado / financia.
  { re: /\bfinanci\w*/, weight: 0.5, label: "ofrece financiación" },
  { re: /\bcuotas?\b/, weight: 0.3, label: "cuotas" },
  { re: /\bcr[e]dito\w*\b/, weight: 0.3, label: "crédito" },
  { re: /\b(?:plan|planes) de (?:pago|ahorro)\b/, weight: 0.4, label: "plan de pago" },
  { re: /\b(?:sin|con) (?:veraz|clearing|bps|dgi)\b/, weight: 0.5, label: "chequeo crediticio" },

  // --- back-office a private seller does not have ------------------------
  { re: /\bescriban[i]a\b/, weight: 0.5, label: "escribanía propia" },
  { re: /\bgestor[i]a\b/, weight: 0.5, label: "gestoría" },
  { re: /\btramites? (?:incluidos?|al d[i]a|de transferencia)\b/, weight: 0.35, label: "trámites" },
  { re: /\b(?:iva|factura) (?:incluido|discriminado|contado)\b|\bfacturamos\b/, weight: 0.4, label: "factura/IVA" },
  { re: /\bgarant[i]a (?:escrita|mecanica|de motor|por escrito|de \d)/, weight: 0.45, label: "garantía escrita" },

  // --- a place of business ----------------------------------------------
  { re: /\bshow ?room\b/, weight: 0.6, label: "showroom" },
  { re: /\bsucursal(?:es)?\b/, weight: 0.5, label: "sucursal" },
  { re: /\bnuestro (?:local|predio|stock|showroom)\b/, weight: 0.6, label: "local propio" },
  { re: /\bhorario\w* de atencion\b|\blunes a (?:viernes|sabado)\b/, weight: 0.4, label: "horario comercial" },
  { re: /\bstock\b/, weight: 0.3, label: "stock" },

  // --- trade-in intake: businesses buy, private sellers sell -------------
  { re: /\b(?:recibimos|tomamos|aceptamos) (?:tu |su )?(?:usado|auto|vehiculo|permuta)/, weight: 0.6, label: "recibe usados" },
  { re: /\bpermuta\w*\b/, weight: 0.25, label: "permuta" },
  { re: /\bentrega inmediata\b/, weight: 0.3, label: "entrega inmediata" },

  // --- first-person plural sales copy ------------------------------------
  { re: /\bconsult[ae]?\w* (?:por |sobre |la |el )?(?:financiacion|planes?|precio|stock|opciones)/, weight: 0.3, label: "consulte por…" },
  { re: /\bnos? (?:encontramos|ubicamos) en\b|\bvisitanos\b|\bven[i]? a ver\w*\b/, weight: 0.4, label: "visítanos" },
  { re: /\bwww\.|\.com\.uy\b|\bmercadolibre\b/, weight: 0.3, label: "sitio web" },
];

/**
 * @param {object} input
 * @param {string|null} input.title
 * @param {string|null} input.description
 * @param {string|null} input.sellerType      Facebook's vehicle_seller_type
 * @param {string|null} input.dealershipName  Facebook's dealership_name
 * @param {number|null} input.sellerActiveCount  distinct active listings by this seller
 * @returns {{isDealer:boolean, score:number, confidence:string, signals:object[], reasons:string[]}}
 */
export function detectDealer({
  title = null,
  description = null,
  sellerType = null,
  dealershipName = null,
  sellerActiveCount = null,
} = {}) {
  const signals = [];

  // --- structured: decisive when Facebook actually fills it in -----------
  const declared = String(sellerType ?? "").toUpperCase();
  if (declared === "DEALER" || declared === "DEALERSHIP") {
    signals.push({ source: "structured", label: "vehicle_seller_type=DEALER", weight: 1.5, decisive: true });
  }
  if (dealershipName) {
    signals.push({ source: "structured", label: `dealership_name=${dealershipName}`, weight: 1.5, decisive: true });
  }
  // A seller Facebook explicitly calls private still gets the text pass: the
  // field is self-declared and dealers routinely list under a personal profile.

  // --- behavioural: one seller, many active cars -------------------------
  const n = Number(sellerActiveCount) || 0;
  if (n >= 3) {
    signals.push({ source: "behavioural", label: `${n} publicaciones activas del mismo vendedor`, weight: 1.2, decisive: true });
  } else if (n === 2) {
    signals.push({ source: "behavioural", label: "2 publicaciones activas del mismo vendedor", weight: 0.4 });
  }

  // --- textual -----------------------------------------------------------
  const text = normalizeText(`${title ?? ""} ${description ?? ""}`);
  if (text) {
    for (const term of DEALER_TERMS) {
      if (term.re.test(text)) signals.push({ source: "text", label: term.label, weight: term.weight });
    }
  }

  const score = Number(signals.reduce((s, x) => s + x.weight, 0).toFixed(3));
  const decisive = signals.some((s) => s.decisive);
  const isDealer = decisive || score >= DEALER_THRESHOLD;
  const confidence =
    !isDealer ? (score > 0 ? "low" : "none")
    : decisive || score >= DEALER_HIGH_CONFIDENCE ? "high"
    : "medium";

  return {
    isDealer,
    score,
    confidence,
    signals,
    reasons: signals.map((s) => s.label),
  };
}

/**
 * Grid-only pass. The search grid has no description, so this is deliberately
 * weaker: it exists to keep obvious dealer listings out of the internal price
 * reference, not to make a final verdict. The real call happens after the
 * detail fetch, with the description in hand.
 */
export function looksLikeDealerFromGrid(listing, { sellerActiveCount = null } = {}) {
  return detectDealer({
    title: listing.title,
    description: null,
    sellerActiveCount: sellerActiveCount ?? listing.sellerActiveCount ?? null,
  });
}

/**
 * Distinct active listings per seller_id within one batch. Used in dry runs and
 * as a floor in full runs: the database count can only ever be larger, never
 * smaller, so a dealer caught here is a dealer either way.
 */
export function countBySellerInBatch(items) {
  const counts = new Map();
  for (const it of items) {
    const id = it.sellerId ?? it.seller_id;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
