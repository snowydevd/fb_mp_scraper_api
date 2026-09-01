/**
 * Scheduled worker. The extractor is a library now; this is what calls it, and
 * the HTTP API reads the database instead of Facebook.
 *
 * Run:
 *   node src/worker/sync.mjs --dry      search + score in memory, nothing written
 *   node src/worker/sync.mjs            full run (requires DATABASE_URL)
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.mjs";
import { searchVehicles } from "../services/marketplace/search.mjs";
import { fetchListingDetail } from "../services/marketplace/detail.mjs";
import { closeBrowser, listingsUsed, log, BudgetExceededError } from "../services/marketplace/browser.mjs";
import { referenceFromInternal, referenceFromMeli } from "../services/reference/reference-price.mjs";
import { createReferenceCache } from "../services/reference/cache.mjs";
import { MeliUnavailableError } from "../services/reference/meli.mjs";
import { scoreV1, scoreV2 } from "../services/scoring/scorer.mjs";
import { detectDealer, countBySellerInBatch } from "../services/scoring/dealer.mjs";
import { buildContactEntry } from "../services/scoring/offer.mjs";

/** Listings scoring at or above this get their detail page fetched (Fase 5). */
export const DETAIL_THRESHOLD = Number(process.env.DETAIL_SCORE_THRESHOLD ?? 0.25);
export const DETAIL_MAX_PER_RUN = Number(process.env.DETAIL_MAX_PER_RUN ?? 5);

export const DEFAULT_FILTERS = {
  location: "montevideo",
  category: "cars",
  minPrice: Number(process.env.TARGET_MIN_PRICE ?? 5000),
  maxPrice: Number(process.env.TARGET_MAX_PRICE ?? 12000),
  sortBy: "creation_time_descend",
};

/**
 * How many active listings each seller in this batch has.
 *
 * The batch count is a floor, not the truth: it only sees the cars that made it
 * into this page of results. When the database is available its count is the
 * larger and more honest one, so the two are merged by max.
 */
async function sellerCounts(items, repo) {
  const counts = countBySellerInBatch(items);
  if (!repo) return counts;
  const ids = [...counts.keys()];
  for (const id of ids) {
    try {
      const n = await repo.countActiveBySeller(id);
      if (n > counts.get(id)) counts.set(id, n);
    } catch (err) {
      log("error", `seller count failed for ${id}: ${err.message}`);
    }
  }
  return counts;
}

/**
 * Market reference for one listing. MercadoLibre first (cached by make/model/
 * year band, so a run makes one call per band rather than one per listing);
 * when its credentials are missing or rejected, fall back to the median of
 * comparable listings in this same batch.
 *
 * Dealer listings are excluded from that fallback. They are priced at retail
 * with margin baked in, and in the observed run four of the twenty-four
 * listings were the same dealership - so the "market median" that decided the
 * ranking was partly built from the very listings the pipeline exists to
 * exclude. The internal source stays self-referential either way (it says how a
 * car compares to the rest of Facebook, not to fair value), which is why it is
 * returned with source: "internal" and down-weighted by the scorer when thin.
 */
async function referenceFor(listing, batch, { cache, dealerIds }) {
  const make = listing.make ?? null;
  const model = listing.model ?? null;
  const year = listing.vehicleYear ?? null;
  const currency = listing.currencyResolved ?? "USD";
  const band = year ? { yearFrom: year - 2, yearTo: year + 2 } : { yearFrom: 1980, yearTo: 2100 };

  if (make && model) {
    try {
      const ref = await cache.lookup({ make, model, ...band, currency }, () =>
        referenceFromMeli({ make, model, ...band, currency })
      );
      if (ref?.median) return ref;
    } catch (err) {
      if (!(err instanceof MeliUnavailableError)) throw err;
      // One failure is enough: retrying per listing would cost a token request
      // each time when the credentials are simply wrong.
      cache.markUpstreamUnavailable(err.message);
      // fall through to internal
    }
  }

  const peers = batch.filter(
    (b) =>
      b.id !== listing.id &&
      (b.currencyResolved ?? "USD") === currency &&
      b.price != null &&
      !dealerIds.has(b.id)
  );
  const ref = referenceFromInternal({ make, model, ...band, currency }, peers.map((p) => ({
    price: p.price,
    currency_resolved: p.currencyResolved,
  })));
  ref.excludedDealerPeers = batch.length - 1 - peers.length;
  return ref;
}

export async function runSync({ dryRun = false, filters = DEFAULT_FILTERS } = {}) {
  const runId = randomUUID();
  const started = Date.now();
  log("info", `sync ${runId} start dry=${dryRun}`, filters);

  const { url, items, failures } = await searchVehicles(filters, { skipDelay: dryRun });
  if (failures.length) log("error", `${failures.length} listings failed to map`, failures.slice(0, 3));

  let repo = null;
  if (!dryRun) {
    if (!config.db.url) throw new Error("DATABASE_URL is not set - run with --dry or configure a database");
    repo = await import("../db/repo.mjs");
    await repo.migrate();
    await repo.saveSnapshot({ runId, sourceUrl: url, filters, payload: items, itemCount: items.length });
    const stats = await repo.upsertListings(items);
    const deactivated = await repo.markMissingInactive(items.map((i) => i.id), { city: null });
    log("info", `persisted: +${stats.inserted} new, ${stats.updated} updated, ${stats.priceChanges} price changes, ${deactivated} deactivated`);
  }

  const cache = createReferenceCache({ repo, log });
  const counts = await sellerCounts(items, repo);

  // --- grid-level dealer pass -------------------------------------------
  // The grid has no description, so this catches only what the title and the
  // seller's own listing count give away ("… NOAHCARS"). Its job is to keep
  // dealers out of the internal price reference, not to make a final verdict -
  // that happens after the detail fetch, with the description in hand.
  const dealerIds = new Set();
  for (const it of items) {
    it.sellerActiveCount = it.sellerId ? counts.get(it.sellerId) ?? null : null;
    const verdict = detectDealer({
      title: it.title,
      sellerActiveCount: it.sellerActiveCount,
    });
    it.gridDealerVerdict = verdict;
    if (verdict.isDealer) dealerIds.add(it.id);
  }
  if (dealerIds.size) {
    log("info", `${dealerIds.size}/${items.length} listings look like dealers from the grid alone; excluded from the internal reference`);
  }

  // --- Fase 4: score everything from grid data alone --------------------
  const scored = [];
  for (const it of items) {
    const reference = await referenceFor(it, items, { cache, dealerIds });
    const result = scoreV1(it, reference);
    scored.push({ listing: it, reference, ...result });
    if (repo) await repo.saveScore({ listingId: it.id, score: result.score, version: "v1", breakdown: result.breakdown });
  }
  scored.sort((a, b) => b.score - a.score);
  log("info", `reference cache: ${cache.stats.misses} lookups, ${cache.stats.memoHits} memo hits, ${cache.stats.dbHits} db hits, ${cache.stats.stored} stored`);

  // --- Fase 5: detail only for what cleared the threshold ---------------
  //
  // A confident grid-level dealer verdict skips the detail fetch entirely.
  // v1 already demotes these, so they rarely reach the top slice anyway, but
  // the fetch is the scarce resource: in the run of 2026-09-01 all five
  // navigations went to listings that were then thrown away, so no genuine
  // candidate got looked at at all. Suspicion below the threshold does NOT
  // skip - a demoted score is the right response to a maybe.
  const rejected = [];
  const eligible = scored.filter((s) => {
    if (!s.dealer?.isDealer) return true;
    rejected.push({
      id: s.listing.id,
      title: s.listing.title,
      reason: `automotora detectada en la grilla (${s.dealer.reasons.join(", ")}) - no se abre el detalle`,
    });
    return false;
  });
  const candidates = eligible.filter((s) => s.score >= DETAIL_THRESHOLD).slice(0, DETAIL_MAX_PER_RUN);
  log("info", `${candidates.length}/${eligible.length} cleared the detail threshold (${DETAIL_THRESHOLD}); ` +
    `${scored.length - eligible.length} skipped as dealers before spending a navigation`);

  const queue = [];
  for (const cand of candidates) {
    try {
      const detail = await fetchListingDetail(cand.listing.id, { skipDelay: dryRun });
      const merged = {
        ...cand.listing,
        ...detail,
        id: cand.listing.id,
        sellerActiveCount:
          (detail.sellerId ? counts.get(detail.sellerId) : null) ?? cand.listing.sellerActiveCount ?? null,
      };
      const reference = await referenceFor(merged, items, { cache, dealerIds });
      const v2 = scoreV2(merged, reference);
      cand.detail = merged;
      cand.v2 = v2;

      // Now that the description is in hand the dealer verdict is real; feed it
      // back so the internal reference stops counting this listing as a peer.
      if (v2.dealer?.isDealer) dealerIds.add(merged.id);

      if (repo) {
        // The detail fetch cost a rate-limited navigation. Everything it found
        // is written back, including the dealer verdict, so a later run can
        // skip the listing instead of paying for the same page again.
        await repo.updateDetail(merged.id, {
          ...detail,
          isDealer: v2.dealer?.isDealer ?? null,
          dealerScore: v2.dealer?.score ?? null,
          dealerReasons: v2.dealer?.reasons ?? null,
        });
        await repo.saveScore({ listingId: merged.id, score: v2.score, version: "v2", breakdown: v2.breakdown });
      }

      // --- Fase 6: draft, never send ---
      // Two independent reasons to never reach the queue:
      //   a financed listing advertises a down payment, so its price says
      //   nothing about the car; a dealership has no margin to give.
      // Both are checked here as well as inside the scorer: the weighted sum
      // must never be able to rescue either back into the contact queue.
      const dealer = v2.dealer;
      if (v2.disqualified) {
        rejected.push({ id: merged.id, title: merged.title, reason: v2.disqualifiedBy.join(", ") });
        log("info", `skipping contact draft for ${merged.id}: ${v2.disqualifiedBy.join(", ")}`);
      } else if (dealer?.isDealer) {
        rejected.push({ id: merged.id, title: merged.title, reason: `automotora (${dealer.confidence}): ${dealer.reasons.join(", ")}` });
        log("info", `skipping contact draft for ${merged.id}: dealer verdict ${dealer.confidence} (${dealer.reasons.join(", ")})`);
      } else {
        const entry = buildContactEntry({ ...merged, priceChangeCount: cand.listing.priceChangeCount }, reference);
        const debt = entry.rationale?.debt;
        if (debt?.deducted > 0) {
          log("info", `${merged.id}: deuda declarada de ${debt.currency} ${debt.deducted} descontada de la oferta`);
        }
        if (debt?.needsReview?.length) {
          // No se descontó porque no se sabe la moneda. Tiene que verlo una
          // persona ANTES de mandar la oferta, no después.
          log("error", `${merged.id}: hay deuda declarada SIN descontar (revisar a mano): ` +
            debt.needsReview.map((d) => `${d.amount} — ${d.reason}`).join("; "));
        }
        if (entry.ok) {
          queue.push(entry);
          if (repo) {
            const written = await repo.enqueueContact(entry);
            if (!written.written) log("info", `contact_queue kept as-is for ${entry.listingId}: ${written.reason}`);
          }
        } else {
          rejected.push({ id: merged.id, title: merged.title, reason: entry.reason });
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) { log("error", err.message); break; }
      log("error", `detail failed for ${cand.listing.id}: ${err.message}`);
    }
  }

  // Re-rank on the best score available per listing: a v2 pass can move a
  // listing a long way, and disqualification must actually push it to the end.
  scored.sort((a, b) => (b.v2?.score ?? b.score) - (a.v2?.score ?? a.score));

  const summary = {
    runId,
    url,
    found: items.length,
    scored: scored.length,
    gridDealers: dealerIds.size,
    detailSkippedAsDealer: scored.length - eligible.length,
    detailFetched: candidates.length,
    queued: queue.length,
    rejected: rejected.length,
    referenceCache: cache.stats,
    listingsUsed: listingsUsed(),
    elapsedMs: Date.now() - started,
  };
  log("info", "sync done", summary);
  return { summary, scored, queue, rejected };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry");
  runSync({ dryRun })
    .then(({ summary, scored, queue, rejected }) => {
      console.log("\n=== RANKING (v1, y v2 donde hay detalle) ===");
      for (const s of scored.slice(0, 12)) {
        const v = s.v2 ?? s;
        const km = s.detail?.mileageKm ? `${(s.detail.mileageKm / 1000).toFixed(0)}k km` : "";
        const flag = (s.v2?.dealer ?? s.listing.gridDealerVerdict)?.isDealer ? " [automotora]" : "";
        console.log(
          `${v.score.toFixed(3)} [${v.version}] ${String(s.listing.price).padStart(6)} ${s.listing.currencyResolved} ` +
          `| ${(s.listing.title ?? "").slice(0, 38).padEnd(40)} ${km}${flag}`
        );
      }
      if (rejected.length) {
        console.log("\n=== DESCARTADOS (no llegan a la cola) ===");
        for (const r of rejected) console.log(`${r.id} | ${(r.title ?? "").slice(0, 40)} -> ${r.reason}`);
      }
      if (queue.length) {
        console.log("\n=== COLA DE CONTACTO (borradores, NO enviados) ===");
        for (const q of queue) {
          console.log(`\n${q.listingId} | oferta ${q.currency} ${q.suggestedOffer} (pide ${q.rationale.asking}, ` +
            `mediana ${Math.round(q.rationale.marketMedian)}, expectativa ${q.rationale.acceptanceOutlook}, ` +
            `anclado a ${q.rationale.anchoredTo})`);
          const d = q.rationale.debt;
          if (d?.deducted > 0) {
            console.log(`  deuda: -${d.currency} ${d.deducted} (la oferta antes de la deuda era ${d.offerBeforeDebt})` +
              (d.dominates ? "  ** la deuda domina el negocio, mirala bien **" : ""));
          }
          if (d?.needsReview?.length) {
            console.log(`  ** REVISAR A MANO: deuda declarada sin descontar -> ` +
              d.needsReview.map((x) => `${x.amount} (${x.reason})`).join("; ") + " **");
          }
          console.log(`  "${q.messageDraft}"`);
        }
      }
      console.log("\n", JSON.stringify(summary));
      return closeBrowser();
    })
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error("[sync] failed:", err.message);
      await closeBrowser().catch(() => {});
      process.exit(1);
    });
}
