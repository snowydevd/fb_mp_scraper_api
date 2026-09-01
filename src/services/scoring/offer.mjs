/**
 * Fase 6: offer amount and message draft.
 *
 * NOTHING here sends anything. Automated Messenger outreach is the fastest way
 * to lose the account, and a generic message converts badly, so this produces a
 * queue for manual review and manual sending.
 *
 * The offer is anchored to the market median, never to a fixed percentage off
 * the asking price: a car already listed 15% under market does not deserve a
 * further "-11% of asking" - that just burns the opportunity.
 */

export const OFFER = {
  desiredMarginPct: 0.18, // what we want to be under market when we buy
  outlookBands: { high: 0.08, medium: 0.18 }, // gap from asking -> acceptance outlook
  roundTo: 50,
  // When the car is already priced at or below our target, the median anchor
  // lands above the asking price and clamping produced an offer EQUAL to it -
  // a draft reading "te pago 5990" for a car listed at 5990. That is not an
  // offer, it is a no-op, and it was reaching the contact queue. A cash,
  // same-day, self-collected purchase is worth at least this much of a
  // discount, so the offer floor sits below asking rather than on it.
  minCashDiscountPct: 0.03,
};

const round = (v, step) => Math.round(v / step) * step;

/**
 * @param {object} listing  { price, currencyResolved, listedAt, priceChangeCount, oldPrice }
 * @param {object} reference { median, isReliable, sampleSize, currency }
 */
export function suggestOffer(listing, reference) {
  const asking = Number(listing.price);
  if (!Number.isFinite(asking) || asking <= 0) {
    return { ok: false, reason: "listing has no usable price" };
  }
  if (!reference?.median || !reference.isReliable) {
    return {
      ok: false,
      reason: reference?.median
        ? `market reference too thin (n=${reference.sampleSize}) to anchor an offer`
        : "no market reference available",
    };
  }

  const anchor = reference.median * (1 - OFFER.desiredMarginPct);
  // Never offer above what they are already asking.
  const raw = Math.min(anchor, asking);
  // Round to a clean figure, then re-clamp: rounding 5 990 up to 6 000 would
  // have us offering more than the seller is asking.
  let offer = Math.min(round(raw, OFFER.roundTo), asking);
  let anchoredTo = "market_median";

  // The car is already at or below what the median says we should pay, so the
  // clamp collapsed the offer onto the asking price. Fall back to the cash
  // discount rather than emit a draft that offers exactly what is being asked.
  if (offer >= asking) {
    offer = Math.min(round(asking * (1 - OFFER.minCashDiscountPct), OFFER.roundTo), asking - 1);
    anchoredTo = "asking_cash_discount";
  }
  const gapFromAsking = (asking - offer) / asking;
  const underMarket = (reference.median - offer) / reference.median;

  const outlook =
    gapFromAsking <= OFFER.outlookBands.high ? "alta"
    : gapFromAsking <= OFFER.outlookBands.medium ? "media"
    : "baja";

  return {
    ok: true,
    offer,
    currency: listing.currencyResolved ?? listing.currency_resolved ?? reference.currency ?? null,
    asking,
    marketMedian: reference.median,
    gapFromAskingPct: Number((gapFromAsking * 100).toFixed(1)),
    underMarketPct: Number((underMarket * 100).toFixed(1)),
    acceptanceOutlook: outlook,
    anchoredTo,
    referenceSampleSize: reference.sampleSize,
    referenceSource: reference.source ?? null,
  };
}

const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null);

/**
 * A short, human message. Context earns a mention only when it is real: an
 * opening line about a listing being up "a while" is worse than no line at all
 * when it went up yesterday.
 */
export function draftMessage(listing, offerResult) {
  if (!offerResult?.ok) return null;
  const title = listing.title ?? "el vehículo";
  const days = daysSince(listing.listedAt ?? listing.listed_at);
  const drops = Number(listing.priceChangeCount ?? listing.price_change_count) || 0;
  const cur = offerResult.currency ?? "";
  const amount = offerResult.offer.toLocaleString("es-UY");

  const lines = [`Hola, buenas. Me interesa ${title}.`];

  if (days != null && days >= 30) {
    lines.push(`Vi que la publicación lleva un tiempo, así que no sé si sigue disponible.`);
  } else {
    lines.push(`¿Sigue disponible?`);
  }

  if (drops >= 2) {
    lines.push(`Vi que ajustaste el precio más de una vez, así que te tiro una propuesta concreta.`);
  }

  if (offerResult.anchoredTo === "asking_cash_discount") {
    // The price is already fair. Pretending otherwise reads as a lowball and
    // loses the car; the honest pitch here is speed and certainty, not price.
    lines.push(
      `El precio me parece razonable. Te ofrezco ${cur} ${amount} al contado, hoy mismo, y lo retiro yo.`,
      `Si te sirve, coordinamos para verlo cuando puedas. Gracias.`
    );
  } else {
    lines.push(
      `Estoy en condiciones de pagarte ${cur} ${amount} al contado, hoy mismo, y lo retiro yo.`,
      `Si te sirve, coordinamos para verlo cuando puedas. Gracias.`
    );
  }

  return lines.join(" ");
}

/** Build the queue entry. Status starts pending: a human approves and sends. */
export function buildContactEntry(listing, reference) {
  const offer = suggestOffer(listing, reference);
  if (!offer.ok) return { ok: false, reason: offer.reason, listingId: listing.id };
  return {
    ok: true,
    listingId: listing.id,
    suggestedOffer: offer.offer,
    currency: offer.currency,
    rationale: offer,
    messageDraft: draftMessage(listing, offer),
    status: "pending",
  };
}
