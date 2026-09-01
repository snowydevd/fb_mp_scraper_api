/**
 * Fase 4 (v1) and Fase 5 (v2) scoring.
 *
 * Every subscore is computed, weighted and returned separately: the stored
 * breakdown has to be able to answer "why did this rank first?" without
 * re-running anything. Subscores are normalised to roughly [-1, 1] so weights
 * are comparable, and each carries the raw input it was derived from.
 */
import { evaluateFlags } from "./flags.mjs";

const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Scales at which a signal is considered "full strength". */
export const SCALES = {
  fullDiscount: 0.25,   // 25% under market  -> price_score 1.0
  fullDrop: 0.15,       // a 15% price cut   -> price_drop_score 1.0
  fullStalenessDays: 60,
  fullPriceChanges: 3,
  kmPerYearNormal: 14_000, // Uruguay: ~13-15k km/year
  kmPerYearBad: 30_000,
  kmPerYearSuspiciouslyLow: 4_000,
};

export const WEIGHTS_V1 = { price: 0.55, priceDrop: 0.20, staleness: 0.15, priceChanges: 0.10 };
export const WEIGHTS_V2 = { price: 0.38, priceDrop: 0.14, staleness: 0.10, priceChanges: 0.06, km: 0.14, flags: 0.10, seller: 0.08 };

const daysBetween = (from, to = new Date()) => {
  if (!from) return null;
  const d = (to.getTime() - new Date(from).getTime()) / 86_400_000;
  return Number.isFinite(d) && d >= 0 ? d : null;
};

// --- individual subscores -------------------------------------------------

export function priceScore(price, reference) {
  if (price == null || !reference?.median) {
    return { value: 0, applicable: false, reason: "no price or no market reference" };
  }
  if (reference.currency && reference.currency !== (reference.listingCurrency ?? reference.currency)) {
    return { value: 0, applicable: false, reason: "reference currency differs from listing currency" };
  }
  const discount = (reference.median - price) / reference.median;
  return {
    value: clamp(discount / SCALES.fullDiscount),
    applicable: true,
    discount,
    median: reference.median,
    sampleSize: reference.sampleSize,
    reliable: !!reference.isReliable,
  };
}

export function priceDropScore(price, oldPrice) {
  if (price == null || oldPrice == null || oldPrice <= price) {
    return { value: 0, applicable: false, reason: "no recorded drop" };
  }
  const drop = (oldPrice - price) / oldPrice;
  return { value: clamp(drop / SCALES.fullDrop, 0, 1), applicable: true, drop, oldPrice };
}

/**
 * Age of the listing. Facebook's own creation_time is preferred over
 * first_seen_at: the latter only starts counting the day we first crawled it,
 * so a listing that had been up for months would read as brand new.
 */
export function stalenessScore({ listedAt, firstSeenAt }) {
  const days = daysBetween(listedAt) ?? daysBetween(firstSeenAt);
  if (days == null) return { value: 0, applicable: false, reason: "no date" };
  return {
    value: clamp(days / SCALES.fullStalenessDays, 0, 1),
    applicable: true,
    days: Math.round(days),
    source: listedAt ? "facebook_creation_time" : "first_seen_at",
  };
}

export function priceChangeScore(count) {
  const n = Number(count) || 0;
  if (n <= 0) return { value: 0, applicable: false, count: 0 };
  return { value: clamp(n / SCALES.fullPriceChanges, 0, 1), applicable: true, count: n };
}

/**
 * Mileage judged per year, not absolute: 150 000 km on a 2010 car is ordinary,
 * the same figure on a 2022 car is not. Suspiciously low km for the age is
 * penalised too - a rolled-back odometer is a hazard, not a bargain.
 */
export function kmScore({ mileageKm, vehicleYear, now = new Date() }) {
  if (!mileageKm || !vehicleYear) {
    return { value: 0, applicable: false, reason: "missing mileage or year" };
  }
  const age = Math.max(1, now.getFullYear() - vehicleYear);
  const perYear = mileageKm / age;
  if (perYear < SCALES.kmPerYearSuspiciouslyLow) {
    return { value: -0.5, applicable: true, perYear, age, reason: "implausibly low km for age" };
  }
  const ratio = (SCALES.kmPerYearBad - perYear) / (SCALES.kmPerYearBad - SCALES.kmPerYearNormal);
  return { value: clamp(ratio), applicable: true, perYear: Math.round(perYear), age };
}

/** 3+ active listings from one seller reads as a dealer: no margin there. */
export function sellerScore(activeCount) {
  const n = Number(activeCount) || 0;
  if (n <= 0) return { value: 0, applicable: false, reason: "no seller id" };
  if (n >= 3) return { value: -1, applicable: true, activeCount: n, reason: "likely dealer" };
  if (n === 2) return { value: -0.4, applicable: true, activeCount: n };
  return { value: 0.1, applicable: true, activeCount: n, reason: "single listing" };
}

// --- composition ----------------------------------------------------------

/**
 * When the market reference is thin (< 5 comparables) the price subscore must
 * not decide the ranking, so its weight is cut and redistributed across the
 * signals that don't depend on it.
 */
function adjustWeights(weights, priceReliable) {
  if (priceReliable) return { weights, adjusted: false };
  const reduced = { ...weights, price: weights.price * 0.25 };
  const freed = weights.price - reduced.price;
  const others = Object.keys(reduced).filter((k) => k !== "price");
  const totalOther = others.reduce((s, k) => s + reduced[k], 0);
  for (const k of others) reduced[k] += freed * (reduced[k] / totalOther);
  return { weights: reduced, adjusted: true };
}

function compose(subscores, baseWeights, priceReliable, version) {
  const { weights, adjusted } = adjustWeights(baseWeights, priceReliable);
  let score = 0;
  const breakdown = {};
  for (const [key, sub] of Object.entries(subscores)) {
    const w = weights[key] ?? 0;
    const contribution = sub.applicable ? sub.value * w : 0;
    score += contribution;
    breakdown[key] = { ...sub, weight: Number(w.toFixed(4)), contribution: Number(contribution.toFixed(4)) };
  }
  return {
    score: Number(clamp(score).toFixed(4)),
    version,
    weightsAdjustedForThinReference: adjusted,
    breakdown,
  };
}

/** Fase 4: everything obtainable from the search grid alone. */
export function scoreV1(listing, reference) {
  const price = listing.price == null ? null : Number(listing.price);
  const ref = reference ? { ...reference, listingCurrency: listing.currencyResolved ?? listing.currency_resolved } : null;
  const subscores = {
    price: priceScore(price, ref),
    priceDrop: priceDropScore(price, listing.oldPrice ?? listing.old_price ?? null),
    staleness: stalenessScore({
      listedAt: listing.listedAt ?? listing.listed_at ?? listing.createdAt,
      firstSeenAt: listing.firstSeenAt ?? listing.first_seen_at,
    }),
    priceChanges: priceChangeScore(listing.priceChangeCount ?? listing.price_change_count),
  };
  return compose(subscores, WEIGHTS_V1, !!ref?.isReliable, "v1");
}

/** Fase 5: adds the signals that only the detail page can supply. */
export function scoreV2(listing, reference) {
  const price = listing.price == null ? null : Number(listing.price);
  const ref = reference ? { ...reference, listingCurrency: listing.currencyResolved ?? listing.currency_resolved } : null;
  const flags = evaluateFlags(`${listing.title ?? ""}\n${listing.description ?? ""}`);
  const subscores = {
    price: priceScore(price, ref),
    priceDrop: priceDropScore(price, listing.oldPrice ?? listing.old_price ?? null),
    staleness: stalenessScore({
      listedAt: listing.listedAt ?? listing.listed_at ?? listing.createdAt,
      firstSeenAt: listing.firstSeenAt ?? listing.first_seen_at,
    }),
    priceChanges: priceChangeScore(listing.priceChangeCount ?? listing.price_change_count),
    km: kmScore({
      mileageKm: listing.mileageKm ?? listing.mileage_km,
      vehicleYear: listing.vehicleYear ?? listing.vehicle_year,
    }),
    flags: { value: flags.score, applicable: flags.hits.length > 0, hits: flags.hits, disqualified: flags.disqualified },
    seller: sellerScore(listing.sellerActiveCount ?? listing.seller_active_count),
  };
  const result = compose(subscores, WEIGHTS_V2, !!ref?.isReliable, "v2");
  if (flags.disqualified) {
    // A financed listing advertises its down payment, so its price carries no
    // information about the car. Force it out of the ranking rather than let a
    // strong price subscore drag it back up.
    result.disqualified = true;
    result.disqualifiedBy = flags.hits.filter((h) => h.disqualifies).map((h) => h.label);
    result.score = -1;
  }
  return result;
}
