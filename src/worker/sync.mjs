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
import { referenceFromInternal } from "../services/reference/reference-price.mjs";
import { scoreV1, scoreV2 } from "../services/scoring/scorer.mjs";
import { detectDealer, countBySellerInBatch } from "../services/scoring/dealer.mjs";
import { partitionVehicles } from "../services/marketplace/vehicle-filter.mjs";
import { buildContactEntry } from "../services/scoring/offer.mjs";

/**
 * Piso para abrirle el detalle a un aviso (Fase 5).
 *
 * Era 0.25, calibrado contra una escala que ya no existe: el subscore de precio
 * se llevaba el 42% del peso de v1 y al sacarlo los scores se desplomaron —en
 * una corrida real el máximo fue 0.096—. Un umbral que nadie alcanza no filtra,
 * deja el pipeline mudo.
 *
 * Ahora es 0 y el trabajo de limitar el gasto lo hace DETAIL_MAX_PER_RUN, que
 * es quien lo hacía de verdad igual. El umbral sólo saca lo que tiene una
 * bandera concreta en contra: sospecha de automotora, o un kilometraje que no
 * es creíble. Ambos dan negativo.
 */
export const DETAIL_THRESHOLD = Number(process.env.DETAIL_SCORE_THRESHOLD ?? 0);
export const DETAIL_MAX_PER_RUN = Number(process.env.DETAIL_MAX_PER_RUN ?? 5);

/**
 * Fracción de la tanda que puede saltearse por veredicto de GRILLA antes de que
 * dejemos de creerle. Ver el comentario en el filtro de elegibles.
 */
export const GRID_DEALER_SKIP_MAX_SHARE = Number(process.env.GRID_DEALER_SKIP_MAX_SHARE ?? 0.5);

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
 * Mediana del lote, sólo como CONTEXTO para que una persona mire el precio.
 *
 * Ya no puntúa: el subscore de precio se fue junto con MercadoLibre. Se
 * excluyen las automotoras porque publican a precio de agencia y arrastran la
 * mediana para arriba, y el resultado igual es autorreferencial —dice cómo se
 * compara un aviso contra el resto de Facebook, no contra valor de mercado—.
 * Por eso viaja en `facts.batchMedian` y no en el score.
 */
function medianaDelLote(listing, batch, dealerIds) {
  const currency = listing.currencyResolved ?? "USD";
  const peers = batch.filter(
    (b) => b.id !== listing.id && (b.currencyResolved ?? "USD") === currency && b.price != null && !dealerIds.has(b.id)
  );
  const ref = referenceFromInternal({ currency }, peers.map((p) => ({ price: p.price, currency_resolved: p.currencyResolved })));
  return ref.median == null ? null : { value: Math.round(ref.median), currency, sampleSize: ref.sampleSize };
}

export async function runSync({ dryRun = false, filters = DEFAULT_FILTERS } = {}) {
  const runId = randomUUID();
  const started = Date.now();
  log("info", `sync ${runId} start dry=${dryRun}`, filters);

  const { url, items: raw, failures } = await searchVehicles(filters, { skipDelay: dryRun });
  if (failures.length) log("error", `${failures.length} listings failed to map`, failures.slice(0, 3));

  // La categoría la elige el vendedor, y publicar una cubierta dentro de "Autos
  // y camionetas" da mucha más visibilidad que ponerla en repuestos. Llegaron a
  // la cola títulos como "Cubierta rodado 17" con un borrador ofreciendo miles
  // de dólares.
  //
  // El corte va acá, antes de persistir, porque un repuesto no sólo ensucia la
  // cola: entra a `listings`, se puntúa, y sobre todo entra en la mediana
  // interna de precios, donde una cubierta "de USD 850" arrastra para abajo la
  // referencia que decide todo el ranking.
  const { vehicles: items, notVehicles } = partitionVehicles(raw);
  if (notVehicles.length) {
    log("info", `${notVehicles.length}/${raw.length} descartados por no ser vehículos`,
      notVehicles.map((n) => `${n.title} (${n.matched})`).slice(0, 8));
  }

  let repo = null;
  if (!dryRun) {
    if (!config.db.url) throw new Error("DATABASE_URL is not set - run with --dry or configure a database");
    repo = await import("../db/repo.mjs");
    await repo.migrate();
    // El snapshot guarda la tanda COMPLETA, incluido lo descartado: existe para
    // poder reparsear sin volver a scrapear, y si guardáramos sólo lo que pasó
    // el filtro de hoy nunca podríamos revisar si el filtro se comió algo.
    await repo.saveSnapshot({ runId, sourceUrl: url, filters, payload: raw, itemCount: raw.length });
    const stats = await repo.upsertListings(items);
    const deactivated = await repo.markMissingInactive(items.map((i) => i.id), { city: null });
    log("info", `persisted: +${stats.inserted} new, ${stats.updated} updated, ${stats.priceChanges} price changes, ${deactivated} deactivated`);
  }

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
    const result = scoreV1(it);
    scored.push({ listing: it, ...result });
    if (repo) await repo.saveScore({ listingId: it.id, score: result.score, version: "v1", breakdown: result.breakdown });
  }
  scored.sort((a, b) => b.score - a.score);

  // --- Fase 5: detail only for what cleared the threshold ---------------
  //
  // A confident grid-level dealer verdict skips the detail fetch entirely.
  // v1 already demotes these, so they rarely reach the top slice anyway, but
  // the fetch is the scarce resource: in the run of 2026-09-01 all five
  // navigations went to listings that were then thrown away, so no genuine
  // candidate got looked at at all. Suspicion below the threshold does NOT
  // skip - a demoted score is the right response to a maybe.
  //
  // Con un tope. En una corrida se vio `gridDealers: 22` de 24 —un transitorio
  // que no se pudo reproducir después, dos corridas siguientes dieron 4— y con
  // ese número el salteo habría descartado la tanda entera sin abrir una sola
  // publicación, en silencio y sin nada raro en el resumen.
  //
  // Que la grilla diga que casi todo es automotora es mucho más probable que
  // sea un problema de detección que un hecho del mercado: el veredicto de
  // grilla necesita una señal decisiva o 0.6 sólo con el título, y los títulos
  // rara vez llegan. Pasado el tope se desconfía del veredicto y se abre el
  // detalle igual — la degradación del score sigue aplicando, y v2 decide con
  // la descripción a la vista, que es donde la decisión es firme.
  //
  // El tope mira SÓLO los veredictos de texto. Un vendedor con 16 publicaciones
  // activas es una automotora y punto: eso no es una heurística que pueda
  // dispararse de más, es un conteo. Aplicarle el tope hacía que, justo cuando
  // la evidencia es más dura, se la desconfiara más — y con la sesión puesta
  // los nodos de GraphQL traen seller_id (los del <script> venían vacíos), así
  // que esa evidencia pasó a existir. Medido en vivo: 4 vendedores concentraban
  // 34 de 49 avisos, y el tope los estaba dando por buenos.
  const rejected = [];
  const porTexto = scored.filter((s) => s.dealer?.isDealer && !s.dealer.signals.some((x) => x.decisive));
  const textoShare = scored.length ? porTexto.length / scored.length : 0;
  const trustGridSkip = textoShare <= GRID_DEALER_SKIP_MAX_SHARE;
  if (!trustGridSkip) {
    log("error",
      `la grilla marcó ${porTexto.length}/${scored.length} como automotoras SÓLO por texto ` +
      `(${Math.round(textoShare * 100)}%, por encima del ${Math.round(GRID_DEALER_SKIP_MAX_SHARE * 100)}% esperable): ` +
      `se desconfía de esos veredictos y se les abre el detalle igual`);
  }
  const eligible = scored.filter((s) => {
    if (!s.dealer?.isDealer) return true;
    // Un veredicto decisivo (conteo de publicaciones, o el campo estructurado
    // de Facebook) no lo tapa el tope.
    const decisivo = s.dealer.signals.some((x) => x.decisive);
    if (!decisivo && !trustGridSkip) return true;
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
      const v2 = scoreV2(merged);
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
        const entry = buildContactEntry(
          { ...merged, priceChangeCount: cand.listing.priceChangeCount },
          { batchMedian: medianaDelLote(merged, items, dealerIds) }
        );
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
    notVehicles: notVehicles.length,
    scored: scored.length,
    gridDealers: dealerIds.size,
    detailSkippedAsDealer: scored.length - eligible.length,
    gridDealersPorTexto: porTexto.length,
    gridDealerSkipTrusted: trustGridSkip,
    detailFetched: candidates.length,
    queued: queue.length,
    rejected: rejected.length,
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
      if (summary.notVehicles) {
        console.log(`\n=== NO SON VEHÍCULOS (${summary.notVehicles} descartados antes de puntuar) ===`);
      }
      if (rejected.length) {
        console.log("\n=== DESCARTADOS (no llegan a la cola) ===");
        for (const r of rejected) console.log(`${r.id} | ${(r.title ?? "").slice(0, 40)} -> ${r.reason}`);
      }
      if (queue.length) {
        console.log("\n=== COLA DE CONTACTO (borradores, NO enviados) ===");
        for (const q of queue) {
          const f = q.facts;
          console.log(`\n${q.listingId} | ${f.make ?? ""} ${f.model ?? ""} ${f.vehicleYear ?? ""}`.trimEnd());
          console.log(`  pide   ${f.currency} ${f.price}` + (f.batchMedian ? `   (mediana del lote ${f.batchMedian.value}, n=${f.batchMedian.sampleSize})` : ""));
          console.log(`  km     ${f.mileageKm ? f.mileageKm.toLocaleString("es-UY") : "desconocido"}` +
            (f.kmPerYear ? `  (${f.kmPerYear.toLocaleString("es-UY")}/año)` : ""));
          console.log(`  deuda  ${f.declaredDebt ? `${f.declaredDebt.currency} ${f.declaredDebt.amount}` : "ninguna declarada"}`);
          if (f.daysListed != null) console.log(`  publicado hace ${f.daysListed} días${f.priceChangeCount ? `, ${f.priceChangeCount} bajadas` : ""}`);
          console.log(`  ${f.url}`);
          if (q.facts.debtNeedsReview?.length) {
            console.log(`  ** REVISAR: deuda declarada sin moneda clara -> ` +
              q.facts.debtNeedsReview.map((x) => `${x.amount} (${x.reason})`).join("; ") + " **");
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
