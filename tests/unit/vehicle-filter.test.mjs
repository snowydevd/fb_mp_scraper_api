import { test } from "node:test";
import assert from "node:assert/strict";
import { isVehicleListing, partitionVehicles } from "../../src/services/marketplace/vehicle-filter.mjs";
import { VEHICLE_CATEGORY_ID } from "../../src/services/marketplace/url.mjs";

const t = (title, extra = {}) => isVehicleListing({ title, categoryId: VEHICLE_CATEGORY_ID, ...extra });

/**
 * Los 24 títulos exactos de una corrida real (Montevideo, 5000-12000, 2026-09-01).
 * Todos son autos: ninguno puede caer en el filtro. Es la red contra el falso
 * positivo, que es el riesgo caro acá — descartar un auto de verdad no se nota
 * en ningún log, simplemente nunca aparece.
 */
const AUTOS_REALES = [
  "Hyundai tucson 2012 extrafull manual ‼️‼️‼️",
  "Volkswagen gol g5 2010 extrafull ‼️‼️‼️",
  "Peugeot 207 compact 2011 divino ‼️‼️‼️",
  "Nissan Note 2014 extrafull ‼️‼️‼️",
  "Suzuki Alto 800 GA - 2022",
  "Volkswagen Gol G4 1.6 - 2008",
  "Volkswagen gol g8",
  "Volkswagen UP!",
  "Peugeot partner 2016 extrafull divina ‼️‼️‼️",
  "Byd f0 extrafull divino noahcars‼️‼️‼️",
  "Peugeot 408 Allure Plus 2.0 - 2012",
  "Suzuki celerio 2014 extrafull divino noahcars‼",
  "Chevrolet Ahile LTZ 1.4 2010",
  "Chevrolet Onix LT 1.0 | 2017",
  "Nissan March",
  "Mitsubishi l200 diesel",
  "Ford escape 2014 extrafull automatica‼️‼️‼️",
  "Fiat uno way divino con A/C NOAHCARS‼️‼️‼️",
  "Fiat uno atracttive 2017 extrafull‼️‼️‼️",
  "Volkswagen gol g5 full aire y direccion ‼️‼️‼️",
  "Peugeot 206 break 1.4 extrafull ‼️‼️‼️",
  "2008 CITROEN PICASSO 2.0 ",
  "Ford Ecosport Titanium",
  "2016 NISSAN MARCH 1.6 AT 2016",
];

test("ningún auto real de la corrida cae en el filtro", () => {
  for (const title of AUTOS_REALES) {
    const r = t(title);
    assert.equal(r.ok, true, `falso positivo en "${title}": ${r.reason} (${r.matched})`);
  }
});

// Los dos que el usuario vio llegar a contact_queue.
test("los repuestos que llegaron a la cola ahora se cortan", () => {
  assert.equal(t("Cubierta rodado 17").ok, false);
  assert.equal(t('Cubierta rodado 17"').ok, false);
  assert.equal(t("Tapa de valvulas").ok, false);
  assert.equal(t("Tapa de válvulas").ok, false);
});

test("una pieza con marca adelante sigue siendo una pieza", () => {
  // El nombre de la marca no puede salvar a un repuesto del nivel fuerte.
  assert.equal(t("Tapa de válvulas Volkswagen Gol").ok, false);
  assert.equal(t("Paragolpes delantero Peugeot 206").ok, false);
  assert.equal(t("Alternador Chevrolet Corsa").ok, false);
  assert.equal(t("Óptica izquierda Fiat Uno").ok, false);
});

// "motor" aparece en media publicación de auto real, así que sólo cuenta
// cuando es el sujeto del título.
test("una pieza ambigua sólo cuenta si es el sujeto del título", () => {
  assert.equal(t("Motor Fiat Uno 1.4").ok, false, "el motor abre el título: es un motor");
  assert.equal(t("Vendo motor 1.6").ok, false);
  assert.equal(t("Puertas de Gol").ok, false);
  // …y no cuando es una característica del auto.
  assert.equal(t("Fiat Uno 1.4 motor impecable").ok, true);
  assert.equal(t("Volkswagen Gol con caja automática").ok, true);
  assert.equal(t("Chevrolet Onix 5 puertas").ok, true);
});

test("sólo se mira el título: la descripción de un auto habla de piezas todo el tiempo", () => {
  const r = isVehicleListing({
    title: "Volkswagen Gol G4 1.6 - 2008",
    categoryId: VEHICLE_CATEGORY_ID,
    description: "Cubiertas nuevas, tapizado original, motor impecable, alternador y batería cambiados.",
  });
  assert.equal(r.ok, true, "sería un falso positivo carísimo");
});

test("una categoría que no es la de autos se corta sin mirar el título", () => {
  const r = isVehicleListing({ title: "Volkswagen Gol", categoryId: "999999999" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /categoría/);
});

test("sin título no se descarta: no hay evidencia", () => {
  assert.equal(isVehicleListing({ title: null, categoryId: VEHICLE_CATEGORY_ID }).ok, true);
  assert.equal(isVehicleListing({ title: "", categoryId: VEHICLE_CATEGORY_ID }).ok, true);
});

test("partitionVehicles separa y explica cada descarte", () => {
  const { vehicles, notVehicles } = partitionVehicles([
    { id: "1", title: "Volkswagen Gol G4 1.6 - 2008", categoryId: VEHICLE_CATEGORY_ID },
    { id: "2", title: "Cubierta rodado 17", categoryId: VEHICLE_CATEGORY_ID },
    { id: "3", title: "Tapa de válvulas", categoryId: VEHICLE_CATEGORY_ID },
  ]);
  assert.deepEqual(vehicles.map((v) => v.id), ["1"]);
  assert.deepEqual(notVehicles.map((n) => n.id), ["2", "3"]);
  assert.ok(notVehicles[0].matched, "el motivo tiene que ser auditable");
  assert.ok(notVehicles[0].reason);
});

test("acentos y mayúsculas no cambian el veredicto", () => {
  assert.equal(t("TAPA DE VÁLVULAS").ok, false);
  assert.equal(t("tapa de valvulas").ok, false);
  assert.equal(t("Ópticas traseras").ok, false);
  assert.equal(t("opticas traseras").ok, false);
});

// --- tope del salteo por veredicto de grilla ------------------------------
// Vive acá porque es la misma familia de problema: un filtro que se pasa de
// listo y se come la tanda entera sin que nada lo note.
test("el tope del salteo por grilla está en una fracción, no en un absoluto", async () => {
  const { GRID_DEALER_SKIP_MAX_SHARE } = await import("../../src/worker/sync.mjs");
  assert.ok(GRID_DEALER_SKIP_MAX_SHARE > 0 && GRID_DEALER_SKIP_MAX_SHARE < 1,
    "una tanda entera marcada como automotora es un bug de detección, no un hecho del mercado");
  assert.ok(GRID_DEALER_SKIP_MAX_SHARE <= 0.6);
});
