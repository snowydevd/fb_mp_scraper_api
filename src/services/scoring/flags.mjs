/**
 * Term flags over title + description.
 *
 * Weights are per-term, not per-category: "prenda" (a lien on the car) and
 * "permuto" (open to a trade) are both negatives but nowhere near equal.
 * Each hit is returned with the term that fired it so a score can be explained.
 *
 * Every pattern runs against `normalizeText` output - unaccented, lowercased,
 * emoji folded to spaces. Written against raw text these patterns silently
 * missed most of the corpus: /\bfinanciad[oa]\b/ never matched "Financiación",
 * /\bpermuto\b/ never matched "Permuta", and a description reading
 * "☑️Venta - Permuta -Financiación☑️" scored a clean zero. Patterns here must
 * therefore be written WITHOUT accents.
 */
import { normalizeText } from "./text.mjs";

export const FLAG_TERMS = [
  // Legal / financial encumbrance - the deal-killers
  { re: /\bdeuda[s]?\b/, weight: -0.35, label: "deuda" },
  { re: /\bdebe\b/, weight: -0.30, label: "debe" },
  { re: /\bprenda(?:d[oa])?\b/, weight: -0.40, label: "prenda" },
  { re: /\bgravamen\b/, weight: -0.40, label: "gravamen" },
  { re: /\bembargo\b/, weight: -0.45, label: "embargo" },
  { re: /\bsaldo\b/, weight: -0.25, label: "saldo" },
  // financiado / financiacion / financiamos / financia: all of them mean the
  // advertised number may not be the sale price.
  { re: /\bfinanci\w*/, weight: -0.25, label: "financiación" },
  { re: /\bcuotas?\b/, weight: -0.20, label: "cuotas" },
  // Financed listings advertise the DOWN PAYMENT as the price. Observed live:
  // a 2017 EcoSport listed at "USD 5000" whose description read "Financiación
  // de la casa U$S 5000 y cuotas" - the car costs far more. These rank top of
  // any price-based ranking and are never real opportunities, so they are
  // disqualified outright rather than merely penalised.
  { re: /\bfinanciacion de la casa\b/, weight: -1, label: "financiación de la casa", disqualifies: true },
  { re: /\bentrega\s+(?:de\s+)?(?:u\$s|usd|\$)?\s*[\d.,]+/, weight: -1, label: "entrega + cuotas", disqualifies: true },
  { re: /\banticipo\b/, weight: -0.6, label: "anticipo", disqualifies: true },

  // Condition / paperwork
  { re: /\bchocad[oa]\b/, weight: -0.45, label: "chocado" },
  { re: /\bpara repuestos?\b/, weight: -0.50, label: "para repuestos" },
  { re: /\bno anda\b/, weight: -0.50, label: "no anda" },
  { re: /\bmotor fundido\b/, weight: -0.50, label: "motor fundido" },
  { re: /\bsin empadronar\b/, weight: -0.35, label: "sin empadronar" },
  { re: /\ba nombre de\b/, weight: -0.30, label: "a nombre de" },

  // Mild
  { re: /\bpermut\w*/, weight: -0.08, label: "permuto" },
  { re: /\bescucho ofertas\b/, weight: -0.05, label: "escucho ofertas" },

  // Positives
  { re: /\bunico dueno\b/, weight: +0.15, label: "único dueño" },
  { re: /\bpapeles al dia\b/, weight: +0.12, label: "papeles al día" },
  { re: /\blibre de deuda[s]?\b/, weight: +0.20, label: "libre de deuda" },
];

/**
 * @returns {{score:number, hits:object[], disqualified:boolean}} score clamped to [-1, 1]
 */
export function evaluateFlags(text) {
  const t = normalizeText(text);
  if (!t) return { score: 0, hits: [], disqualified: false };
  const hits = [];
  let sum = 0;
  for (const term of FLAG_TERMS) {
    if (term.re.test(t)) {
      hits.push({ label: term.label, weight: term.weight, disqualifies: !!term.disqualifies });
      sum += term.weight;
    }
  }
  // "libre de deuda" also matches /deuda/; keep both hits visible but don't let
  // the pair read as a net negative when the explicit positive is present.
  if (hits.some((h) => h.label === "libre de deuda")) {
    const d = hits.find((h) => h.label === "deuda");
    if (d) sum -= d.weight; // cancel the generic negative
  }
  return {
    score: Math.max(-1, Math.min(1, sum)),
    hits,
    disqualified: hits.some((h) => h.disqualifies),
  };
}
