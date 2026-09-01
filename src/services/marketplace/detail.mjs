/**
 * Fase 5: selective detail fetch.
 *
 * Only listings that cleared the Fase 4 threshold are opened, which keeps the
 * request volume low. Everything is read from the embedded Relay payload, not
 * the DOM: Marketplace collapses the description behind "Ver más", so scraping
 * the rendered text truncates exactly the part that matters, while
 * `redacted_description.text` carries the whole thing.
 *
 * Facebook also ships structured vehicle fields that the original plan intended
 * to regex out of prose. Verified present on a real listing:
 *   vehicle_odometer_data   {unit, value}  -> mileage, no parsing
 *   vehicle_make/model_display_name        -> comparables lookup
 *   vehicle_seller_type     PRIVATE_SELLER | DEALER
 *   vehicle_title_status    CLEAN | SALVAGE | ...
 *   vehicle_is_paid_off     the lien flag "prenda" tries to detect
 * Regex over the description stays as a fallback for the many listings where
 * sellers leave these blank.
 */
import { config } from "../../config.mjs";
import { ScraperError, ERROR_CODES, waitForOutcome } from "../scraper.mjs";
import { ExtractionError, resolveVehicleCurrency } from "./extract.mjs";
import { getBrowser, newSessionContext, persistSession, withPoliteSlot, countListings, log } from "./browser.mjs";

// Re-exported: these are pure and now live in parse.mjs, so the grid mapper
// and the scorer can use them without importing the browser layer.
import { parseMileageFromText, parseYear } from "./parse.mjs";

export { parseMileageFromText, parseYear };

/** Pull the listing node out of the detail page's Relay payload. */
async function extractDetailNode(page) {
  const node = await page.evaluate(() => {
    let found = null;
    const visit = (o) => {
      if (!o || typeof o !== "object" || found) return;
      if (Array.isArray(o)) { for (const v of o) visit(v); return; }
      if (o.redacted_description?.text !== undefined && o.marketplace_listing_title !== undefined) {
        found = o;
        return;
      }
      for (const k in o) visit(o[k]);
    };
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      try { visit(JSON.parse(s.textContent || "{}")); } catch { /* other islands still carry it */ }
      if (found) break;
    }
    if (!found) return null;
    // Only the fields we actually store. seller_phone_number and the seller's
    // name are deliberately NOT read - Ley 18.331, minimum necessary data.
    const pick = [
      "id", "marketplace_listing_title", "custom_title", "creation_time", "condition",
      "listing_price", "location_text", "marketplace_listing_category_id", "dealership_name",
      "vehicle_odometer_data", "vehicle_make_display_name", "vehicle_model_display_name",
      "vehicle_trim_display_name", "vehicle_seller_type", "vehicle_title_status",
      "vehicle_is_paid_off", "vehicle_number_of_owners", "vehicle_condition",
      "vehicle_transmission_type", "vehicle_fuel_type", "is_sold", "is_live", "is_pending",
    ];
    const out = { redacted_description: found.redacted_description?.text ?? null };
    for (const k of pick) out[k] = found[k] ?? null;
    out.seller_id = found.marketplace_listing_seller?.id ?? null;
    return out;
  });
  if (!node) throw new ExtractionError("detail payload had no listing node");
  return node;
}

/** Pure mapping from the raw detail node - unit-testable on fixtures. */
export function mapDetail(node) {
  const description = node.redacted_description ?? null;
  const title = node.marketplace_listing_title ?? node.custom_title ?? null;

  // The structured odometer is NOT always trustworthy: sellers of financed
  // cars put the down payment in it (observed: a 2017 EcoSport with
  // odometer 5000 whose description said 98000km). Cross-check against the
  // description and prefer prose when the two disagree by more than 3x.
  const odo = node.vehicle_odometer_data;
  const fromText = parseMileageFromText(description);
  const fromAttr =
    odo?.value != null
      ? { km: odo.unit === "MILES" ? Math.round(odo.value * 1.60934) : Math.round(odo.value), source: "attribute" }
      : null;

  let mileageKm = null;
  let mileageSource = null;
  let mileageConflict = null;
  if (fromAttr && fromText && Math.max(fromAttr.km, fromText.km) / Math.max(1, Math.min(fromAttr.km, fromText.km)) > 3) {
    mileageConflict = { attribute: fromAttr.km, description: fromText.km };
    mileageKm = fromText.km;          // prose is what the seller actually wrote
    mileageSource = "description_over_conflicting_attribute";
  } else {
    const chosen = fromAttr ?? fromText;
    if (chosen) { mileageKm = chosen.km; mileageSource = chosen.source; }
  }

  const amount = node.listing_price?.amount != null ? Number(node.listing_price.amount) : null;
  const reported = node.listing_price?.currency ?? null;
  const resolved = resolveVehicleCurrency(amount, reported);

  // vehicle_seller_type is authoritative when present; the listing-count
  // heuristic in the scorer stays as the fallback for when it is blank.
  const sellerType = node.vehicle_seller_type ?? (node.dealership_name ? "DEALER" : null);

  return {
    id: node.id ? String(node.id) : null,
    title,
    description,
    price: amount,
    currencyReported: reported,
    currencyResolved: resolved.currency,
    currencyConfidence: resolved.confidence,
    listedAt: node.creation_time ? new Date(node.creation_time * 1000).toISOString() : null,
    mileageKm,
    mileageSource,
    mileageConflict,
    vehicleYear: parseYear(title, description),
    make: node.vehicle_make_display_name ?? null,
    model: node.vehicle_model_display_name ?? null,
    trim: node.vehicle_trim_display_name ?? null,
    sellerId: node.seller_id ?? null,
    sellerType,
    isDealer: sellerType === "DEALER" || !!node.dealership_name,
    titleStatus: node.vehicle_title_status ?? null,
    isPaidOff: node.vehicle_is_paid_off ?? null,
    numberOfOwners: node.vehicle_number_of_owners ?? null,
    condition: node.vehicle_condition ?? node.condition ?? null,
    transmission: node.vehicle_transmission_type ?? null,
    fuelType: node.vehicle_fuel_type ?? null,
    locationText: node.location_text?.text ?? null,
    isSold: node.is_sold ?? null,
  };
}

async function runDetail(listingId) {
  const url = `https://www.facebook.com/marketplace/item/${listingId}/`;
  const browser = await getBrowser();
  const { context, hasSession } = await newSessionContext(browser);
  try {
    const page = await context.newPage();
    let response;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.scraper.navTimeoutMs });
    } catch (err) {
      throw new ScraperError(ERROR_CODES.NAV_FAILED, `Detail navigation failed: ${err.message.split("\n")[0]}`, { url });
    }
    const status = response?.status();
    const { state } = await waitForOutcome(page, { mainStatus: status });
    if (state === "login") {
      throw new ScraperError(
        ERROR_CODES.LOGIN_REQUIRED,
        hasSession ? "Session expired while fetching detail." : "Detail page requires a session.",
        { url, status }
      );
    }
    if (state === "blocked") throw new ScraperError(ERROR_CODES.BLOCKED, "Captcha on the detail page.", { url });

    // The Relay island streams in after domcontentloaded.
    await page.waitForTimeout(3000 + Math.floor(Math.random() * 2500));
    const node = await extractDetailNode(page);
    countListings(1);
    await persistSession(context);
    const detail = mapDetail(node);
    log("info", `detail ${listingId}: ${detail.make ?? "?"} ${detail.model ?? "?"} km=${detail.mileageKm ?? "?"} seller=${detail.sellerType ?? "?"}`);
    return detail;
  } finally {
    await context.close().catch(() => {});
  }
}

/** Fetch one listing's detail page. Politeness and budget apply. */
export function fetchListingDetail(listingId, opts = {}) {
  if (!/^\d+$/.test(String(listingId))) throw new TypeError("listingId must be numeric");
  return withPoliteSlot(() => runDetail(listingId), opts);
}
