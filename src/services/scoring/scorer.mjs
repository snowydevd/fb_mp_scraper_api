/**
 * Fase 4 (v1) and Fase 5 (v2) scoring.
 *
 * Every subscore is computed, weighted and returned separately: the stored
 * breakdown has to be able to answer "why did this rank first?" without
 * re-running anything. Subscores are normalised to roughly [-1, 1] so weights
 * are comparable, and each carries the raw input it was derived from.
 */
import { evaluateByCategory } from "./flags.mjs";
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
  /**
   * Kilometraje ABSOLUTO, interpolado entre anclas. Va aparte del km/año a
   * propósito: miden cosas distintas y las dos importan.
   *
   * El km/año dice cómo se usó el auto —uso intenso, o un tablero corregido si
   * da sospechosamente bajo—. El km absoluto dice cuánta vida le queda, que es
   * lo que se revende. Un 2008 con 210.000 km hizo 11k/año, o sea uso normal, y
   * midiendo sólo km/año puntuaba igual que un 2015 con 57.000. Para comprar y
   * revender no son ni parecidos.
   */
  /**
   * Debajo de esto, en un usado de esta banda de precio, el número no es
   * creíble. Un auto de USD 5.000-12.000 en Uruguay no tiene 5.000 km: o es un
   * error de carga, o es un tablero corregido, o —lo más común— es la entrega
   * de un plan metida en el campo del odómetro. En los tres casos el número no
   * puede puntuar como excelente.
   */
  kmAbsoluteImplausible: 20_000,
  kmAbsolute: [
    [80_000, 1.0],
    [150_000, 0.4],
    [250_000, -0.3],
    [350_000, -1.0],
  ],
};

/** Interpola linealmente entre las anclas, plano fuera de los extremos. */
function interpolar(x, anclas) {
  if (x <= anclas[0][0]) return anclas[0][1];
  const ultima = anclas[anclas.length - 1];
  if (x >= ultima[0]) return ultima[1];
  for (let i = 1; i < anclas.length; i++) {
    const [x1, y1] = anclas[i - 1];
    const [x2, y2] = anclas[i];
    if (x <= x2) return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
  }
  return ultima[1];
}

/**
 * v1 decide a quién se le abre la publicación, y abrir una cuesta una
 * navegación con rate limit. Sin descripción no hay señal de deuda, así que el
 * peso se lo llevan el km (de la pista del subtítulo) y el vendedor.
 */
export const WEIGHTS_V1 = { km: 0.50, seller: 0.28, staleness: 0.15, priceDrop: 0.05, priceChanges: 0.02 };
/**
 * v2, con la descripción a la vista. Las dos preguntas que deciden si un auto
 * vale la pena —cuánto rodó y cuánto debe— se llevan el 68% del peso.
 *
 * El PRECIO no puntúa. La banda de precio ya se filtra del lado de Facebook al
 * buscar, así que todo lo que llega está dentro del presupuesto; y adentro de
 * esa banda, quién decide si el precio es bueno es una persona, no el scorer.
 * Sacarlo se llevó puesta toda la maquinaria de precio de referencia, que era
 * la parte más frágil del sistema: dependía de MercadoLibre —que terminó
 * bloqueando la búsqueda— o de la mediana del propio lote de Facebook, que se
 * compara contra sí misma.
 *
 * Las tres señales de vendedor motivado quedan con peso chico: son reales pero
 * necesitan historial, y hoy valen casi cero hasta que el scheduler junte
 * corridas.
 */
export const WEIGHTS_V2 = { km: 0.38, deuda: 0.30, seller: 0.14, condicion: 0.08, staleness: 0.06, priceDrop: 0.03, priceChanges: 0.01 };

const daysBetween = (from, to = new Date()) => {
  if (!from) return null;
  const d = (to.getTime() - new Date(from).getTime()) / 86_400_000;
  return Number.isFinite(d) && d >= 0 ? d : null;
};

// --- individual subscores -------------------------------------------------

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
 * Kilometraje: las dos lecturas, y manda la peor.
 *
 * Se toma el mínimo y no un promedio porque un auto vale lo que vale su peor
 * señal: 300.000 km hechos "prolijamente" a 15k por año siguen siendo 300.000
 * km, y 40.000 km en un año son 40.000 km por más nuevo que sea el auto.
 *
 * El km sospechosamente bajo para el año se penaliza igual que el alto: un
 * tablero corregido es un riesgo, no una ganga.
 */
export function kmScore({ mileageKm, vehicleYear, now = new Date() }) {
  if (!mileageKm) return { value: 0, applicable: false, reason: "sin kilometraje" };

  if (mileageKm < SCALES.kmAbsoluteImplausible) {
    return {
      value: -0.5, applicable: true, mileageKm,
      reason: `km implausiblemente bajo para un usado (< ${SCALES.kmAbsoluteImplausible.toLocaleString("es-UY")})`,
    };
  }
  const absoluto = interpolar(mileageKm, SCALES.kmAbsolute);
  if (!vehicleYear) {
    // Sin año no hay km/año, pero el absoluto solo ya dice bastante.
    return { value: absoluto, applicable: true, mileageKm, absoluto: Number(absoluto.toFixed(3)), reason: "sin año: sólo km absoluto" };
  }

  const age = Math.max(1, now.getFullYear() - vehicleYear);
  const perYear = mileageKm / age;
  if (perYear < SCALES.kmPerYearSuspiciouslyLow) {
    return { value: -0.5, applicable: true, perYear: Math.round(perYear), age, mileageKm, reason: "km implausiblemente bajo para el año" };
  }
  const porAno = clamp((SCALES.kmPerYearBad - perYear) / (SCALES.kmPerYearBad - SCALES.kmPerYearNormal));

  return {
    value: Math.min(porAno, absoluto),
    applicable: true,
    mileageKm,
    perYear: Math.round(perYear),
    age,
    porAno: Number(porAno.toFixed(3)),
    absoluto: Number(absoluto.toFixed(3)),
    manda: absoluto < porAno ? "km absoluto" : "km por año",
  };
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
 * Suma ponderada, con el desglose completo. Un subscore que no aplica aporta 0
 * y su peso queda igual: un auto sin km conocido no es un auto con km malo, así
 * que no se le reparte el peso a los demás — queda por debajo del que tiene km
 * bueno y por encima del que lo tiene malo.
 */
function compose(subscores, weights, version) {
  let score = 0;
  const breakdown = {};
  for (const [key, sub] of Object.entries(subscores)) {
    const w = weights[key] ?? 0;
    const contribution = sub.applicable ? sub.value * w : 0;
    score += contribution;
    breakdown[key] = { ...sub, weight: Number(w.toFixed(4)), contribution: Number(contribution.toFixed(4)) };
  }
  return { score: Number(clamp(score).toFixed(4)), version, breakdown };
}

/**
 * Fase 4: sólo con lo que da la grilla. Sin descripción no hay deuda que medir,
 * así que esto es apenas el filtro que elige a quién abrirle el detalle.
 */
export function scoreV1(listing) {
  const price = listing.price == null ? null : Number(listing.price);
  const subscores = {
    km: kmScore({
      mileageKm: listing.mileageKm ?? listing.mileage_km ?? listing.mileageHint,
      vehicleYear: listing.vehicleYear ?? listing.vehicle_year ?? listing.vehicleYearHint,
    }),
    seller: sellerSubscore({ ...listing, description: null }),
    staleness: stalenessScore({
      listedAt: listing.listedAt ?? listing.listed_at ?? listing.createdAt,
      firstSeenAt: listing.firstSeenAt ?? listing.first_seen_at,
    }),
    priceDrop: priceDropScore(price, listing.oldPrice ?? listing.old_price ?? null),
    priceChanges: priceChangeScore(listing.priceChangeCount ?? listing.price_change_count),
  };
  const result = compose(subscores, WEIGHTS_V1, "v1");
  result.dealer = subscores.seller.dealer;
  return result;
}

/** Fase 5: con la descripción, que es lo único que dice si el auto debe plata. */
export function scoreV2(listing) {
  const price = listing.price == null ? null : Number(listing.price);
  const cats = evaluateByCategory(`${listing.title ?? ""}\n${listing.description ?? ""}`);

  const subscores = {
    km: kmScore({
      mileageKm: listing.mileageKm ?? listing.mileage_km,
      vehicleYear: listing.vehicleYear ?? listing.vehicle_year,
    }),
    deuda: { value: cats.deuda.score, applicable: cats.deuda.hits.length > 0, hits: cats.deuda.hits },
    seller: sellerSubscore(listing),
    condicion: { value: cats.condicion.score, applicable: cats.condicion.hits.length > 0, hits: cats.condicion.hits },
    staleness: stalenessScore({
      listedAt: listing.listedAt ?? listing.listed_at ?? listing.createdAt,
      firstSeenAt: listing.firstSeenAt ?? listing.first_seen_at,
    }),
    priceDrop: priceDropScore(price, listing.oldPrice ?? listing.old_price ?? null),
    priceChanges: priceChangeScore(listing.priceChangeCount ?? listing.price_change_count),
  };
  const result = compose(subscores, WEIGHTS_V2, "v2");

  const dealer = subscores.seller.dealer;
  result.dealer = dealer;
  result.neutralised = cats.neutralised;

  // Una automotora identificada con confianza no es una oportunidad mala: no es
  // una oportunidad. No hay margen que negociar. Con peso 0.14 el subscore de
  // vendedor no podría sacarla del ranking, así que el veredicto corta afuera
  // de la suma ponderada.
  if (dealer.isDealer && (dealer.confidence === "high" || dealer.score >= DEALER_HIGH_CONFIDENCE)) {
    result.disqualified = true;
    result.disqualifiedBy = [`automotora/revendedor (${dealer.reasons.slice(0, 3).join(", ")})`];
    result.score = -1;
  }
  // Un aviso financiado publica la entrega, no el precio del auto. El número
  // que muestra no dice nada, así que tampoco sirve para que lo evalúes vos.
  if (cats.disqualified) {
    result.disqualified = true;
    result.disqualifiedBy = [
      ...(result.disqualifiedBy ?? []),
      ...cats.deuda.hits.filter((h) => h.disqualifies).map((h) => h.label),
    ];
    result.score = -1;
  }
  return result;
}
