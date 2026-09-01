/**
 * Term flags over title + description.
 *
 * Weights are per-term, not per-category: "prenda" (a lien on the car) and
 * "permuto" (open to a trade) are both negatives but nowhere near equal.
 * Each hit is returned with the term that fired it so a score can be explained.
 */
export const FLAG_TERMS = [
  // Legal / financial encumbrance - the deal-killers
  { re: /\bdeuda[s]?\b/i, weight: -0.35, label: "deuda" },
  { re: /\bdebe\b/i, weight: -0.30, label: "debe" },
  { re: /\bprenda(?:d[oa])?\b/i, weight: -0.40, label: "prenda" },
  { re: /\bgravamen\b/i, weight: -0.40, label: "gravamen" },
  { re: /\bembargo\b/i, weight: -0.45, label: "embargo" },
  { re: /\bsaldo\b/i, weight: -0.25, label: "saldo" },
  { re: /\bfinanciad[oa]\b/i, weight: -0.25, label: "financiado" },
  { re: /\bcuotas\b/i, weight: -0.20, label: "cuotas" },
  // Financed listings advertise the DOWN PAYMENT as the price. Observed live:
  // a 2017 EcoSport listed at "USD 5000" whose description read "Financiación
  // de la casa U$S 5000 y cuotas" - the car costs far more. These rank top of
  // any price-based ranking and are never real opportunities, so they are
  // disqualified outright rather than merely penalised.
  { re: /\bfinanciaci[oó]n de la casa\b/i, weight: -1, label: "financiación de la casa", disqualifies: true },
  { re: /\bentrega\s+(?:de\s+)?(?:U\$S|USD|\$)?\s*[\d.,]+/i, weight: -1, label: "entrega + cuotas", disqualifies: true },
  { re: /\banticipo\b/i, weight: -0.6, label: "anticipo", disqualifies: true },

  // Condition / paperwork
  { re: /\bchocad[oa]\b/i, weight: -0.45, label: "chocado" },
  { re: /\bpara repuestos?\b/i, weight: -0.50, label: "para repuestos" },
  { re: /\bno anda\b/i, weight: -0.50, label: "no anda" },
  { re: /\bmotor fundido\b/i, weight: -0.50, label: "motor fundido" },
  { re: /\bsin empadronar\b/i, weight: -0.35, label: "sin empadronar" },
  { re: /\ba nombre de\b/i, weight: -0.30, label: "a nombre de" },

  // Mild
  { re: /\bpermuto\b/i, weight: -0.08, label: "permuto" },
  { re: /\bescucho ofertas\b/i, weight: -0.05, label: "escucho ofertas" },

  // Positives
  { re: /\b[uú]nico due[nñ]o\b/i, weight: +0.15, label: "único dueño" },
  { re: /\bpapeles al d[ií]a\b/i, weight: +0.12, label: "papeles al día" },
  { re: /\blibre de deuda\b/i, weight: +0.20, label: "libre de deuda" },
];

/**
 * @returns {{score:number, hits:object[], disqualified:boolean}} score clamped to [-1, 1]
 */
export function evaluateFlags(text) {
  const t = String(text ?? "");
  if (!t.trim()) return { score: 0, hits: [], disqualified: false };
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
