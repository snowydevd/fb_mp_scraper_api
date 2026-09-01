/**
 * Pure parsers over listing text. No browser, no network - so the scorer and
 * the grid mapper can both use them without dragging Playwright into a unit
 * test.
 *
 * These lived in detail.mjs, which imports the browser layer. That was fine
 * while only the detail path parsed prose; the grid needs the year too, to
 * decide which listings are worth opening at all.
 *
 * The character classes below contain the non-breaking and narrow spaces
 * Facebook actually emits inside numbers ("140 000 km"), not plain ones.
 */

const YEAR_RE = /\b(19[89]\d|20[0-4]\d)\b/;

/** Mileage from free text, when the structured odometer is absent. */
export function parseMileageFromText(text) {
  const t = String(text ?? "").replace(/[   ]/g, " ");
  if (!t) return null;
  const mil = t.match(/([\d]+(?:[.,]\d+)?)\s*mil\s*(?:km|kms|kil[oó]metros)/i);
  if (mil) return { km: Math.round(parseFloat(mil[1].replace(",", ".")) * 1000), source: "description" };
  // Either a grouped figure ("57.000", "140 000") or a plain run of digits.
  // A looser [\d.\s]+ span would swallow the preceding model year, turning
  // "Año 2017 98000km" into 201 798 000.
  const plain = t.match(/(\d{1,3}(?:[.\s]\d{3})+|\d{2,7})\s*(?:km|kms|kil[oó]metros)\b/i);
  if (plain) {
    const digits = plain[1].replace(/\D/g, "");
    const km = digits ? parseInt(digits, 10) : null;
    if (km && km >= 1000 && km <= 1_500_000) return { km, source: "description" };
  }
  return null;
}

/** Model year. No structured field exists, so title first, then description. */
export function parseYear(title, description) {
  for (const src of [title, description]) {
    const m = String(src ?? "").match(YEAR_RE);
    if (m) {
      const y = parseInt(m[1], 10);
      if (y >= 1980 && y <= new Date().getFullYear() + 1) return y;
    }
  }
  return null;
}
