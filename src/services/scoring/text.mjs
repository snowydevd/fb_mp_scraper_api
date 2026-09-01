/**
 * Text normalisation shared by every regex-based signal.
 *
 * Uruguayan sellers write "Financiación", "financiacion" and "FINANCIACIÓN"
 * interchangeably, so matching accented source text with accented patterns
 * misses most of the corpus. Everything is folded to lowercase ASCII once, and
 * the patterns are written unaccented against that folded form.
 *
 * Emoji are replaced by a space rather than dropped: listing copy is written as
 * "Venta - Permuta -Financiación☑️Consulte" and removing the emoji outright
 * would weld the last word to the next one, breaking \b anchors.
 */
export function normalizeText(input) {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // strip combining accents
    .replace(/[ -⁯]/g, " ")  // narrow/no-break spaces FB emits
    .replace(/[^\p{L}\p{N}$@./+-]+/gu, " ") // emoji, punctuation -> separator
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
