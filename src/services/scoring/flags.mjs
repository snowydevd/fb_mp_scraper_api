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

/**
 * Contextos que ANULAN un término de gravamen que aparece justo después.
 *
 * Sin esto, el sistema penalizaba al vendedor por decir que el auto NO debe
 * nada: "sin deuda" daba -0.20 y "no debe nada" -0.30, o sea que la señal de
 * vendedor honesto que más queremos era exactamente la que restaba.
 *
 * El caso más caro es "sin embargo": la conjunción adversativa más común del
 * español matcheaba /\bembargo\b/ y valía -0.45. Cualquier vendedor que
 * escribiera "tiene detalles de pintura, sin embargo el motor está impecable"
 * quedaba marcado como auto embargado.
 */
const NEGATOR_BEFORE =
  /(?:\bsin|\bno(?:\s+(?:tiene|debe|adeuda|posee|registra|paga))?|\blibre\s+de|\bcero|\bninguna?)\s+(?:\w+\s+){0,2}$/;

/** Y contextos que lo anulan apareciendo justo después. */
const CANCELLED_AFTER =
  /^\s*(?:ya\s+)?(?:cancelad|levantad|saldad|pagad?|liberad|abonad)[ao]s?\b/;

export const FLAG_TERMS = [
  // Legal / financial encumbrance - the deal-killers
  { re: /\bdeuda[s]?\b/, weight: -0.35, label: "deuda" },
  { re: /\bdebe\b/, weight: -0.30, label: "debe" },
  { re: /\bprenda(?:d[oa])?\b/, weight: -0.40, label: "prenda" },
  { re: /\bgravamen\b/, weight: -0.40, label: "gravamen" },
  { re: /\bembargo\b/, weight: -0.45, label: "embargo" },
  { re: /\bsaldo\b/, weight: -0.25, label: "saldo" },
  { re: /\bmultas?\b/, weight: -0.15, label: "multas" },
  // Una deuda de patente es chica, conocida y se descuenta del precio: no es
  // lo mismo que una prenda, que bloquea la transferencia hasta cancelarla.
  { re: /\bdeuda\s+(?:de\s+)?(?:patente|rodados|empadronamiento)\b/, weight: -0.15, label: "deuda de patente", supersedes: "deuda" },
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
  { re: /\bsin deuda[s]?\b/, weight: +0.18, label: "sin deuda" },
  { re: /\bno (?:debe|adeuda)(?: nada)?\b/, weight: +0.18, label: "no debe nada" },
  { re: /\bsin prenda[s]?\b|\blibre de prenda[s]?\b/, weight: +0.15, label: "sin prenda" },
  { re: /\bal dia (?:con|de) (?:la )?(?:patente|todo)\b|\bpatente al dia\b/, weight: +0.12, label: "patente al día" },
  // Una prenda ya levantada no es un gravamen, es un trámite terminado.
  { re: /\bprenda (?:cancelada|levantada|saldada|liberada)\b/, weight: +0.10, label: "prenda cancelada" },
];

/**
 * ¿Esta aparición del término está negada o cancelada por su contexto?
 *
 * Se mira una ventana chica a cada lado en vez de la frase entera: con una
 * ventana grande, un "sin" de cualquier parte del aviso anularía una deuda
 * mencionada tres oraciones después.
 */
function isNeutralised(text, start, end) {
  return (
    NEGATOR_BEFORE.test(text.slice(Math.max(0, start - 28), start)) ||
    CANCELLED_AFTER.test(text.slice(end, end + 30))
  );
}

/**
 * @returns {{score:number, hits:object[], disqualified:boolean, neutralised:object[]}}
 *   score clamped to [-1, 1]
 */
export function evaluateFlags(text) {
  const t = normalizeText(text);
  if (!t) return { score: 0, hits: [], disqualified: false, neutralised: [] };

  const hits = [];
  const neutralised = [];
  for (const term of FLAG_TERMS) {
    // Cada aparición se evalúa por separado: "sin deuda de patente pero debe
    // multas" tiene una negada y una real, y la real tiene que contar.
    const scan = new RegExp(term.re.source, "g");
    let live = false;
    let suppressed = 0;
    for (let m = scan.exec(t); m; m = scan.exec(t)) {
      if (term.weight < 0 && isNeutralised(t, m.index, m.index + m[0].length)) suppressed++;
      else live = true;
      if (m[0] === "") break; // guard against a zero-width pattern looping forever
    }
    if (live) hits.push({ label: term.label, weight: term.weight, disqualifies: !!term.disqualifies });
    else if (suppressed) neutralised.push({ label: term.label, occurrences: suppressed });
  }

  // Un término específico reemplaza al genérico que lo contiene: "deuda de
  // patente" ya dice cuánto pesa, y sumarle encima el -0.35 de "deuda" a secas
  // contaría la misma deuda dos veces.
  const superseded = new Set(hits.map((h) => FLAG_TERMS.find((t2) => t2.label === h.label)?.supersedes).filter(Boolean));
  // El hit reemplazado queda visible pero marcado: todo el diseño del scorer es
  // que el desglose explique el score, y un hit con peso que no está sumado
  // hace que los números no cierren para quien los lea.
  for (const h of hits) h.counted = !superseded.has(h.label);

  const sum = hits.reduce((acc, h) => acc + (h.counted ? h.weight : 0), 0);
  return {
    score: Math.max(-1, Math.min(1, sum)),
    hits,
    disqualified: hits.some((h) => h.disqualifies),
    neutralised,
  };
}
