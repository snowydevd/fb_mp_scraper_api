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
import { MeliUnavailableError } from "../services/reference/meli.mjs";
import { scoreV1, scoreV2 } from "../services/scoring/scorer.mjs";
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
 * Market reference for one listing. MercadoLibre first; when its credentials
 * are missing or rejected, fall back to the median of comparable listings in
 * this same batch. The internal source is self-referential - it says how a car
 * compares to the rest of Facebook, not to fair value - so it is returned with
 * source: "internal" and the scorer down-weights a thin one automatically.
 */
async function referenceFor(listing, batch) {
  const make = listing.make ?? null;
  const model = listing.model ?? null;
  const year = listing.vehicleYear ?? null;
  const currency = listing.currencyResolved ?? "USD";
  const band = year ? { yearFrom: year - 2, yearTo: year + 2 } : { yearFrom: 1980, yearTo: 2100 };

  if (make && model) {
    try {
      const ref = await referenceFromMeli({ make, model, ...band, currency });
      if (ref.median) return ref;
    } catch (err) {
      if (!(err instanceof MeliUnavailableError)) throw err;
      // fall through to internal
    }
  }
  const peers = batch.filter(
    (b) => b.id !== listing.id && (b.currencyResolved ?? "USD") === currency && b.price != null
  );
  return referenceFromInternal({ make, model, ...band, currency }, peers.map((p) => ({
    price: p.price,
    currency_resolved: p.currencyResolved,
  })));
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

  // --- Fase 4: score everything from grid data alone --------------------
  const scored = [];
  for (const it of items) {
    const reference = await referenceFor(it, items);
    const result = scoreV1(it, reference);
    scored.push({ listing: it, reference, ...result });
    if (repo) await repo.saveScore({ listingId: it.id, score: result.score, version: "v1", breakdown: result.breakdown });
  }
  scored.sort((a, b) => b.score - a.score);

  // --- Fase 5: detail only for what cleared the threshold ---------------
  const candidates = scored.filter((s) => s.score >= DETAIL_THRESHOLD).slice(0, DETAIL_MAX_PER_RUN);
  log("info", `${candidates.length}/${scored.length} cleared the detail threshold (${DETAIL_THRESHOLD})`);

  const queue = [];
  for (const cand of candidates) {
    try {
      const detail = await fetchListingDetail(cand.listing.id, { skipDelay: dryRun });
      const merged = { ...cand.listing, ...detail, id: cand.listing.id };
      const reference = await referenceFor(merged, items);
      const v2 = scoreV2(merged, reference);
      cand.detail = merged;
      cand.v2 = v2;
      if (repo) await repo.saveScore({ listingId: merged.id, score: v2.score, version: "v2", breakdown: v2.breakdown });

      // --- Fase 6: draft, never send ---
      // A disqualified listing (financed, so its advertised price is only the
      // down payment) must not reach the queue either - contacting on a price
      // that isn't the sale price wastes the approach.
      if (v2.disqualified) {
        log("info", `skipping contact draft for ${merged.id}: ${v2.disqualifiedBy.join(", ")}`);
      } else {
        const entry = buildContactEntry({ ...merged, priceChangeCount: cand.listing.priceChangeCount }, reference);
        if (entry.ok) queue.push(entry);
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
    detailFetched: candidates.length,
    queued: queue.length,
    listingsUsed: listingsUsed(),
    elapsedMs: Date.now() - started,
  };
  log("info", "sync done", summary);
  return { summary, scored, queue };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry");
  runSync({ dryRun })
    .then(({ summary, scored, queue }) => {
      console.log("\n=== RANKING (v1, y v2 donde hay detalle) ===");
      for (const s of scored.slice(0, 12)) {
        const v = s.v2 ?? s;
        const km = s.detail?.mileageKm ? `${(s.detail.mileageKm / 1000).toFixed(0)}k km` : "";
        console.log(
          `${v.score.toFixed(3)} [${v.version}] ${String(s.listing.price).padStart(6)} ${s.listing.currencyResolved} ` +
          `| ${(s.listing.title ?? "").slice(0, 38).padEnd(40)} ${km}`
        );
      }
      if (queue.length) {
        console.log("\n=== COLA DE CONTACTO (borradores, NO enviados) ===");
        for (const q of queue) {
          console.log(`\n${q.listingId} | oferta ${q.currency} ${q.suggestedOffer} (pide ${q.rationale.asking}, ` +
            `mediana ${Math.round(q.rationale.marketMedian)}, expectativa ${q.rationale.acceptanceOutlook})`);
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
