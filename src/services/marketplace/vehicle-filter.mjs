/**
 * ¿Esto es un auto, o un repuesto publicado en la categoría de autos?
 *
 * La Fase 1 dio por resuelto el problema: la categoría `cars` devolvía 24 de 24
 * vehículos reales. Pero la categoría la elige el VENDEDOR, y publicar una
 * cubierta dentro de "Autos y camionetas" da mucha más visibilidad que ponerla
 * en repuestos. Así que llegaron a la cola de contacto títulos como "Cubierta
 * rodado 17" y "Tapa de válvulas", con un borrador ofreciendo miles de dólares.
 *
 * Filtrar por `marketplace_listing_category_id` NO alcanza justamente por eso:
 * esas publicaciones traen la categoría de autos, porque es donde el vendedor
 * las puso. Igual se chequea, porque es gratis y ataja el otro caso (la
 * categoría `vehicles`, que incluye repuestos de verdad).
 *
 * El riesgo real acá es el falso positivo: la descripción de un auto de verdad
 * habla de repuestos todo el tiempo ("motor impecable", "cubiertas nuevas",
 * "tapizado original"). Por eso:
 *
 *   - se mira SOLO el título, nunca la descripción;
 *   - los términos van en dos niveles, y el débil sólo cuenta si la pieza es el
 *     sujeto del título, no una característica mencionada al pasar.
 */
import { normalizeText } from "../scoring/text.mjs";
import { VEHICLE_CATEGORY_ID } from "./url.mjs";

/**
 * Nivel A: prácticamente nunca son el título de un auto entero. Alcanzan solos,
 * incluso si el título nombra una marca ("Tapa de válvulas Volkswagen Gol"
 * sigue siendo una tapa de válvulas).
 */
export const PART_TERMS_STRONG = [
  // ruedas
  /\bcubiertas?\b/, /\bneumaticos?\b/, /\bllantas?\b/, /\bcubierta rodado\b/,
  /\brueda de auxilio\b/, /\btaza[s]? de rueda\b/,
  // motor y transmisión
  /\btapa de (?:valvulas?|cilindros?|distribucion)\b/, /\bculata\b/, /\bcigueñal\b/, /\bciguenal\b/,
  /\bcarburador\b/, /\binyectores?\b/, /\bbujias?\b/, /\bbobinas?\b/, /\balternador\b/,
  /\bburro de arranque\b/, /\bradiador\b/, /\bbomba de (?:agua|nafta|aceite|direccion)\b/,
  /\bkit de (?:embrague|distribucion|arrastre)\b/, /\bembrague\b/, /\bturbina?\b/,
  // suspensión y frenos
  /\bamortiguador(?:es)?\b/, /\brotulas?\b/, /\bespirales?\b/, /\btren delantero\b/,
  /\bpastillas? de freno\b/, /\bdiscos? de freno\b/, /\bcampanas? de freno\b/, /\bcubre carter\b/,
  // carrocería
  /\bparagolpes?\b/, /\bparachoques?\b/, /\bguardabarros?\b/, /\bcapot\b/, /\bcapo\b/,
  /\bopticas?\b/, /\bfaros?\b/, /\bfaroles?\b/, /\bstop trasero\b/, /\bparabrisas\b/,
  /\bluneta\b/, /\bespejos? (?:retrovisor|lateral)\b/, /\bporton trasero\b/,
  // interior y varios
  /\btapizados?\b/, /\bbutacas?\b/, /\bvolante\b/, /\btablero\b/, /\bcaja de cambios\b/,
  /\bcaño de escape\b/, /\bsilenciador\b/, /\bescape deportivo\b/, /\bbateria\b/,
  /\bcorrea de (?:distribucion|alternador)\b/, /\bfiltros? de (?:aire|aceite|nafta)\b/,
  // señales de desarme
  /\bdesarme\b/, /\bdesarmadero\b/, /\brepuestos?\b/, /\bchatarra\b/, /\bpara desarmar\b/,
];

/**
 * Nivel B: son piezas sólo cuando son el SUJETO del título. "motor" aparece en
 * media publicación de auto real ("Gol 1.6 motor impecable"), así que sólo
 * cuenta si abre el título o viene justo detrás de "vendo".
 */
export const PART_TERMS_WEAK = [
  /\bmotor\b/, /\bcaja\b/, /\bpuertas?\b/, /\basientos?\b/, /\bcapota\b/,
  /\bvidrios?\b/, /\bcristales?\b/, /\bmanijas?\b/, /\bcerraduras?\b/,
  /\bcubre asientos?\b/, /\balfombras?\b/, /\bfundas?\b/, /\bportaequipajes?\b/,
];

/** Marcas frecuentes en Uruguay. No salva del nivel A, sólo del nivel B. */
const MAKE_RE =
  /\b(volkswagen|vw|chevrolet|fiat|ford|peugeot|renault|nissan|toyota|honda|hyundai|kia|suzuki|citroen|citroën|mitsubishi|byd|chery|geely|jac|great wall|haval|mercedes|bmw|audi|jeep|dodge|ram|iveco|daihatsu|subaru|mazda|seat|skoda|lifan|zotye|dfsk|changan|baic)\b/;

/** El sujeto es lo que abre el título, o lo que sigue a "vendo"/"venta de". */
function isSubject(text, term) {
  const m = text.match(term);
  if (!m) return false;
  const head = text.slice(0, m.index).trim();
  if (!head) return true;                                    // abre el título
  return /^(?:vendo|venta(?: de)?|se vende|liquido|oferta)\s*$/.test(head);
}

/**
 * No son autos aunque el vendedor los publique en "Autos y camionetas".
 *
 * Sólo marcas que en Uruguay son EXCLUSIVAMENTE de moto: Suzuki y Honda hacen
 * las dos cosas, así que ponerlas acá se llevaría puestos autos de verdad. Para
 * el resto se usa el tipo de vehículo, que es inequívoco.
 */
export const NOT_A_CAR = [
  /\bmotos?\b/, /\bmotocicletas?\b/, /\bciclomotor\b/, /\bscooters?\b/,
  /\bcuatricicl\w*/, /\bquad\b/, /\bjet ?ski\b/, /\blanchas?\b/,
  /\btrailers?\b/, /\bremolques?\b/, /\bcasa rodante\b/, /\bmotorhome\b/,
  /\btractor(?:es)?\b/, /\bretroexcavadora\b/, /\bmontacargas?\b/,
  // marcas sólo de moto
  /\bhusqvarna\b/, /\bktm\b/, /\bvespa\b/, /\bzanella\b/, /\byumbo\b/,
  /\bbaccio\b/, /\bmotomel\b/, /\bgilera\b/, /\bbajaj\b/, /\broyal enfield\b/,
  /\bharley\b/, /\bwinner\b/, /\bkeeway\b/,
  // publicaciones genéricas de agencia, sin un auto concreto
  /\bvehiculos? varios\b/, /\bautos? varios\b/, /\bconsultar? stock\b/,
];

/**
 * @param {object} listing  item de la grilla ya mapeado
 * @returns {{ok:boolean, reason?:string, matched?:string}}
 */
export function isVehicleListing(listing) {
  // Barato y ataja la categoría `vehicles`, que sí trae repuestos de verdad.
  if (listing.categoryId && listing.categoryId !== VEHICLE_CATEGORY_ID) {
    return { ok: false, reason: "categoría distinta a autos y camionetas", matched: listing.categoryId };
  }

  const title = normalizeText(listing.title);
  if (!title) return { ok: true }; // sin título no hay evidencia; que decida el resto del pipeline

  for (const re of NOT_A_CAR) {
    const m = title.match(re);
    if (m) return { ok: false, reason: "no es un auto", matched: m[0] };
  }

  for (const re of PART_TERMS_STRONG) {
    const m = title.match(re);
    if (m) return { ok: false, reason: "el título es un repuesto", matched: m[0] };
  }

  // El nivel B sólo si además NO hay marca, o si la pieza abre el título: un
  // "Fiat Uno motor 1.4" es un auto, un "Motor Fiat Uno 1.4" es un motor.
  for (const re of PART_TERMS_WEAK) {
    if (isSubject(title, re)) {
      return { ok: false, reason: "el título tiene un repuesto como sujeto", matched: title.match(re)[0] };
    }
    if (!MAKE_RE.test(title) && re.test(title)) {
      return { ok: false, reason: "repuesto sin marca de vehículo en el título", matched: title.match(re)[0] };
    }
  }

  return { ok: true };
}

/** Separa una tanda en vehículos y no-vehículos, con el motivo de cada descarte. */
export function partitionVehicles(items) {
  const vehicles = [];
  const notVehicles = [];
  for (const it of items) {
    const verdict = isVehicleListing(it);
    if (verdict.ok) vehicles.push(it);
    else notVehicles.push({ id: it.id, title: it.title, price: it.price, ...verdict });
  }
  return { vehicles, notVehicles };
}
