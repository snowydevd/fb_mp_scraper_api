/**
 * Cuánto debe el auto, en plata.
 *
 * Una deuda conocida no es motivo para descartar una publicación: es motivo
 * para ofrecer menos. `flags.mjs` ya la penaliza en el RANKING, que es otra
 * cosa —ahí mide riesgo—; esto la lleva al PRECIO, que es donde se resuelve.
 *
 * Dos reglas que mandan sobre todo lo demás:
 *
 * 1. **Sin moneda segura, no se descuenta.** Esta plata entra en una oferta que
 *    una persona va a mandar. Restarle 15.000 pesos a un precio en dólares
 *    convierte una oferta de USD 6.150 en una de USD -8.850. Cuando la moneda
 *    no es clara, el monto se reporta para que lo mire un humano y no se toca
 *    la oferta.
 *
 * 2. **Un número no es un monto por estar cerca de la palabra "deuda".**
 *    "deuda de patente 2024 y 2025" son los AÑOS que se adeudan, no 2024
 *    dólares. Un número de cuatro cifras en rango de año y sin símbolo de
 *    moneda se descarta.
 */
import { normalizeText } from "./text.mjs";

/** Palabras que abren un contexto de deuda. La cifra se busca cerca de una. */
const DEBT_CONTEXT = /\b(deuda|deudas|debe|debo|adeuda|adeudo|saldo|prenda|prendado|multas?|gravamen)\b/g;

/** Hasta dónde se busca la cifra después de la palabra. */
const WINDOW = 46;

const USD_MARKER = /u\$s|us\$|usd|dolares|dolar/;
const UYU_MARKER = /\$u|\bpesos?\b|\buyu\b/;

/**
 * Una cifra con su moneda, si la declara. El símbolo puede ir antes
 * ("U$S 3.500") o después ("3500 usd"), que es como se escribe en la práctica.
 */
const AMOUNT_RE =
  /(u\$s|us\$|usd|\$u|\$)?\s*(\d{1,3}(?:\.\d{3})+|\d{1,3}(?:\s\d{3})+|\d+)(?:,(\d{1,2}))?\s*(mil\b)?\s*(u\$s|us\$|usd|dolares|dolar|pesos|peso|\$u|uyu)?/g;

const CURRENT_YEAR = new Date().getFullYear();

/** ¿Es un año disfrazado de monto? */
function looksLikeYear(raw, digits, hasCurrency) {
  if (hasCurrency) return false;                 // "u$s 2024" es plata
  if (/[.\s,]/.test(raw)) return false;          // "2.024" está formateado como monto
  return digits >= 1980 && digits <= CURRENT_YEAR + 1;
}

/**
 * @returns {{amount:number, currency:string|null, confidence:string, context:string}[]}
 */
export function parseDebtAmounts(input) {
  const t = normalizeText(input);
  if (!t) return [];

  const found = [];
  const seen = new Set();
  DEBT_CONTEXT.lastIndex = 0;

  for (let ctx = DEBT_CONTEXT.exec(t); ctx; ctx = DEBT_CONTEXT.exec(t)) {
    const from = ctx.index;
    const slice = t.slice(from, from + WINDOW);
    AMOUNT_RE.lastIndex = 0;

    for (let m = AMOUNT_RE.exec(slice); m; m = AMOUNT_RE.exec(slice)) {
      const [whole, pre, intPart, cents, mil, post] = m;
      if (!intPart) continue;

      const absolute = from + m.index;
      if (seen.has(absolute)) continue;

      const marker = `${pre ?? ""} ${post ?? ""}`;
      const hasCurrency = /[a-z$]/.test(marker.trim());
      const digits = parseInt(intPart.replace(/[.\s]/g, ""), 10);
      if (!Number.isFinite(digits) || digits <= 0) continue;
      if (looksLikeYear(intPart, digits, hasCurrency)) continue;

      let amount = digits + (cents ? Number(`0.${cents}`) : 0);
      if (mil) amount *= 1000;

      // La moneda sólo se da por sabida cuando el aviso la dice. Un "$" pelado
      // es ambiguo en Uruguay y no alcanza para tocar una oferta.
      let currency = null;
      let confidence = "none";
      if (USD_MARKER.test(marker)) { currency = "USD"; confidence = "high"; }
      else if (UYU_MARKER.test(marker)) { currency = "UYU"; confidence = "high"; }
      else if (/\$/.test(marker)) { currency = null; confidence = "low"; }

      seen.add(absolute);
      found.push({
        amount,
        currency,
        confidence,
        kind: ctx[1],
        context: t.slice(Math.max(0, from - 10), Math.min(t.length, from + WINDOW)).trim(),
        raw: whole.trim(),
      });
      break; // una cifra por mención: la primera es la que la palabra califica
    }
  }
  return found;
}

/**
 * Total adeudado en la moneda pedida.
 *
 * Lo que no se puede convertir con confianza NO se suma: vuelve en `unresolved`
 * para que lo lea una persona. `uyuPerUsd` sólo se usa si viene configurado —
 * inventar un tipo de cambio para poder restar sería peor que no restar.
 */
export function totalDebt(text, { currency, uyuPerUsd = null } = {}) {
  const items = parseDebtAmounts(text);
  let total = 0;
  const applied = [];
  const unresolved = [];

  for (const it of items) {
    if (it.confidence !== "high" || !it.currency) { unresolved.push({ ...it, reason: "moneda no declarada" }); continue; }
    if (it.currency === currency) { total += it.amount; applied.push(it); continue; }
    if (!uyuPerUsd) { unresolved.push({ ...it, reason: `moneda distinta (${it.currency}) y no hay tipo de cambio configurado` }); continue; }
    const converted = it.currency === "UYU" && currency === "USD" ? it.amount / uyuPerUsd
      : it.currency === "USD" && currency === "UYU" ? it.amount * uyuPerUsd
      : null;
    if (converted == null) { unresolved.push({ ...it, reason: `no se sabe convertir ${it.currency} a ${currency}` }); continue; }
    total += converted;
    applied.push({ ...it, convertedAmount: Math.round(converted), rate: uyuPerUsd });
  }

  return {
    total: Math.round(total * 100) / 100,
    currency,
    applied,
    unresolved,
    hasUnresolved: unresolved.length > 0,
  };
}
