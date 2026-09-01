/**
 * Fase 4 (v1) and Fase 5 (v2) scoring.
 *
 * Every subscore is computed, weighted and returned separately: the stored
 * breakdown has to be able to answer "why did this rank first?" without
 * re-running anything. Subscores are normalised to roughly [-1, 1] so weights
 * are comparable, and each carries the raw input it was derived from.
 */
import { evaluateFlags } from "./flags.mjs";
import { detectDealer, DEALER_HIGH_CONFIDENCE, DEALER_THRESHOLD } from "./dealer.mjs";

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

/**
 * v1 decides which listings get their detail page opened, and opening one costs
 * a rate-limited navigation. In the run of 2026-09-01 all five detail fetches
 * went to listings that were then thrown away - four financed, one dealership -
 * because v1 ranked purely on price and a dealership's advertised price looks
 * excellent. So v1 now spends part of its weight on the two signals that
 * predict a wasted fetch: the seller, and mileage per year.
 */
export const WEIGHTS_V1 = { price: 0.42, priceDrop: 0.16, staleness: 0.12, priceChanges: 0.08, km: 0.12, seller: 0.10 };
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

/**
 * Seller subscore, dealership detection included.
 *
 * The listing-count heuristic above is only one of three signals and the
 * weakest in practice: it needs the database (or a batch large enough to see
 * the same seller twice) and it misses a dealership that posts one car at a
 * time. `detectDealer` folds it together with Facebook's structured fields and
 * the vocabulary of the description, and the worst of the two verdicts wins.
 */
export function sellerSubscore(listing) {
  const activeCount = listing.sellerActiveCount ?? listing.seller_active_count ?? null;
  const byCount = sellerScore(activeCount);
  const verdict = detectDealer({
    title: listing.title,
    description: listing.description,
    sellerType: listing.sellerType ?? listing.seller_type,
    dealershipName: listing.dealershipName ?? listing.dealership_name,
    sellerActiveCount: activeCount,
  });
  if (verdict.isDealer) {
    return {
      value: -1,
      applicable: true,
      activeCount: activeCount ?? undefined,
      reason: "likely dealer",
      dealer: verdict,
    };
  }
  // Suspicion below the threshold still counts. Treating the verdict as a
  // yes/no threw away real evidence: a title reading "… NOAHCARS" scores 0.5
  // on its own - short of the 0.6 needed to call it a dealership, but far from
  // nothing - and the listing ranked identically to a private sale. That
  // matters most in v1, where the title is all there is and the ranking decides
  // whose detail page is worth a rate-limited navigation.
  if (verdict.score > 0) {
    const graded = -Math.min(0.9, verdict.score / DEALER_THRESHOLD);
    return {
      value: Math.min(graded, byCount.applicable ? byCount.value : 0),
      applicable: true,
      activeCount: activeCount ?? undefined,
      reason: "possible dealer",
      dealer: verdict,
    };
  }
  return { ...byCount, dealer: verdict };
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

/**
 * Fase 4: everything obtainable from the search grid alone.
 *
 * The grid has no description, so the seller subscore here sees only the title
 * and the seller's listing count - deliberately weaker than v2's. It is enough
 * for a listing that names its own dealership in the title ("… NOAHCARS"),
 * which is most of them, and that is all this needs to do: stop the detail
 * budget being spent on listings that v2 will disqualify anyway.
 */
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
    // Grid hints, not the detail page's structured fields: the subtitle's
    // mileage and the year written into the title.
    km: kmScore({
      mileageKm: listing.mileageKm ?? listing.mileage_km ?? listing.mileageHint,
      vehicleYear: listing.vehicleYear ?? listing.vehicle_year ?? listing.vehicleYearHint,
    }),
    seller: sellerSubscore({ ...listing, description: null }),
  };
  const result = compose(subscores, WEIGHTS_V1, !!ref?.isReliable, "v1");
  result.dealer = subscores.seller.dealer;
  return result;
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
    seller: sellerSubscore(listing),
  };
  const result = compose(subscores, WEIGHTS_V2, !!ref?.isReliable, "v2");

  const dealer = subscores.seller.dealer;
  result.dealer = dealer;
  // A confidently-identified dealership is not a low-ranked opportunity, it is
  // not an opportunity: there is no margin to negotiate and the approach is
  // wasted. Weighted at 0.08 the seller subscore could never push one out of
  // the ranking on its own, so the verdict cuts outside the weighted sum.
  if (dealer.isDealer && (dealer.confidence === "high" || dealer.score >= DEALER_HIGH_CONFIDENCE)) {
    result.disqualified = true;
    result.disqualifiedBy = [`automotora/revendedor (${dealer.reasons.slice(0, 3).join(", ")})`];
    result.score = -1;
  }
  if (flags.disqualified) {
    // A financed listing advertises its down payment, so its price carries no
    // information about the car. Force it out of the ranking rather than let a
    // strong price subscore drag it back up.
    result.disqualified = true;
    result.disqualifiedBy = [
      ...(result.disqualifiedBy ?? []),
      ...flags.hits.filter((h) => h.disqualifies).map((h) => h.label),
    ];
    result.score = -1;
  }
  return result;
}
