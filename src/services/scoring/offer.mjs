/**
 * Fase 6: la cola de contacto.
 *
 * ACÁ NO SE MANDA NADA. La mensajería automatizada por Messenger es lo que más
 * rápido dispara el baneo de cuenta, y un mensaje genérico convierte mal: esto
 * produce una cola para revisión y envío manual.
 *
 * Tampoco se sugiere un monto. Antes había un `suggestOffer` anclado a una
 * mediana de mercado, pero esa mediana venía de MercadoLibre (que bloqueó la
 * búsqueda) o del propio lote de Facebook (que se compara contra sí mismo), así
 * que el número tenía menos fundamento del que aparentaba — y un número que
 * aparenta fundamento es peor que ninguno, porque invita a usarlo sin pensar.
 * El precio lo decidís vos; lo que la cola aporta son los datos para decidirlo:
 * kilometraje, deuda declarada, antigüedad de la publicación y bajadas previas.
 */
import { totalDebt } from "./debt.mjs";

const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null);

/**
 * Mensaje corto y humano, SIN monto: abre la conversación y deja el número
 * para cuando hables vos.
 *
 * El contexto se menciona sólo cuando es real: una frase sobre que la
 * publicación lleva tiempo es peor que ninguna frase cuando se publicó ayer.
 */
export function draftMessage(listing) {
  // Los títulos de Facebook vienen con espacio al final ("2008 CITROEN PICASSO
  // 2.0 "), lo que dejaba un espacio antes del punto en algo que vas a mandar.
  const title = String(listing.title ?? "").trim() || "el vehículo";
  const days = daysSince(listing.listedAt ?? listing.listed_at);
  const drops = Number(listing.priceChangeCount ?? listing.price_change_count) || 0;

  const lines = [`Hola, buenas. Me interesa ${title}.`];
  lines.push(days != null && days >= 30
    ? `Vi que la publicación lleva un tiempo, así que no sé si sigue disponible.`
    : `¿Sigue disponible?`);
  if (drops >= 2) lines.push(`Vi que ajustaste el precio más de una vez.`);
  lines.push(`¿Se puede ver estos días? Pago al contado y lo retiro yo.`);
  return lines.join(" ");
}

/**
 * La entrada de la cola: todo lo que hace falta para decidir, sin decidir nada.
 *
 * @param {object} listing  el aviso ya con detalle (km, año, descripción)
 * @param {object} [context] { batchMedian, currency } sólo como referencia visual
 */
export function buildContactEntry(listing, context = {}) {
  const price = listing.price == null ? null : Number(listing.price);
  const currency = listing.currencyResolved ?? listing.currency_resolved ?? null;
  const km = listing.mileageKm ?? listing.mileage_km ?? null;
  const year = listing.vehicleYear ?? listing.vehicle_year ?? null;

  // La deuda que el aviso declara: ya no se descuenta de ninguna oferta, pero
  // es la mitad de lo que decide si vale la pena, así que va al frente.
  const debt = totalDebt(`${listing.title ?? ""}\n${listing.description ?? ""}`, { currency });

  return {
    ok: true,
    listingId: listing.id,
    status: "pending",
    messageDraft: draftMessage(listing),
    // Todo esto es para que lo mires vos antes de mandar.
    facts: {
      price,
      currency,
      url: listing.url ?? null,
      make: listing.make ?? null,
      model: listing.model ?? null,
      vehicleYear: year,
      mileageKm: km,
      kmPerYear: km && year ? Math.round(km / Math.max(1, new Date().getFullYear() - year)) : null,
      listedAt: listing.listedAt ?? listing.listed_at ?? null,
      daysListed: daysSince(listing.listedAt ?? listing.listed_at),
      priceChangeCount: Number(listing.priceChangeCount ?? listing.price_change_count) || 0,
      declaredDebt: debt.total > 0 ? { amount: debt.total, currency, items: debt.applied } : null,
      // Montos que el aviso declara pero cuya moneda no está clara: no se
      // suman a nada, los tenés que mirar vos.
      debtNeedsReview: debt.unresolved,
      batchMedian: context.batchMedian ?? null,
    },
  };
}
