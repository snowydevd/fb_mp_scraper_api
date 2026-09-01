#!/usr/bin/env node
/**
 * Qué endpoint devuelve autos CON PRECIO, usando el token que ya funciona.
 *
 * El diagnóstico dejó claro que /sites/MLU/search está bloqueado por política
 * pero el token es válido y otros endpoints responden. Esto vuelca la FORMA de
 * lo que devuelven los candidatos, para poder escribir el mapeo contra una
 * respuesta real en vez de contra la documentación.
 *
 * Imprime claves y un item de muestra, no el volcado entero: la idea es poder
 * pegarlo en un mensaje.
 */
import { config } from "../src/config.mjs";
import { debugToken, meliFetch, MeliUnavailableError } from "../src/services/reference/meli.mjs";

const API = "https://api.mercadolibre.com";
const SITE = config.meli.siteId;
const CAT = config.meli.carsCategory;
let token;
try {
  ({ token } = await debugToken());
} catch (err) {
  console.error(`\nno se pudo arrancar: ${err.message}`);
  if (err instanceof MeliUnavailableError) console.error("  (si dice UND_ERR_CONNECT_TIMEOUT, fue la red: reintentá)\n");
  process.exit(1);
}

const get = async (url) => {
  const res = await meliFetch(url, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* no era json */ }
  return { status: res.status, ok: res.ok, json, text };
};

/** Resume un objeto: claves de primer nivel, y el tipo de cada una. */
const forma = (o, prof = 0) => {
  if (o === null) return "null";
  if (Array.isArray(o)) return `array[${o.length}]${o.length && prof < 1 ? " de " + forma(o[0], prof + 1) : ""}`;
  if (typeof o !== "object") return typeof o;
  const claves = Object.keys(o);
  if (prof >= 1) return `{${claves.slice(0, 14).join(", ")}${claves.length > 14 ? ", …" : ""}}`;
  return "{\n" + claves.map((k) => `      ${k}: ${forma(o[k], prof + 1)}`).join("\n") + "\n    }";
};

const CANDIDATOS = [
  ["products/search por texto",      `${API}/products/search?status=active&site_id=${SITE}&q=volkswagen%20gol`],
  ["products/search por categoría",  `${API}/products/search?status=active&site_id=${SITE}&category_id=${CAT}`],
  ["highlights de la categoría",     `${API}/highlights/${SITE}/category/${CAT}`],
  ["items del usuario (control)",    `${API}/users/${(await get(`${API}/users/me`)).json?.id}/items/search?limit=1`],
];

for (const [nombre, url] of CANDIDATOS) {
  console.log(`\n${"=".repeat(72)}\n${nombre}\n${url}`);
  const r = await get(url);
  console.log(`HTTP ${r.status}`);
  if (!r.ok) { console.log(r.text.replace(/\s+/g, " ").slice(0, 220)); continue; }
  console.log("forma:", forma(r.json));
  const lista = r.json?.results ?? r.json?.content ?? null;
  if (Array.isArray(lista) && lista.length) {
    console.log(`\n  primer resultado (${lista.length} en la página):`);
    console.log("   ", JSON.stringify(lista[0], null, 2).split("\n").slice(0, 40).join("\n    "));
  }
}

// Si products/search devuelve ids de producto, el precio vive en el producto.
const ps = await get(`${API}/products/search?status=active&site_id=${SITE}&q=volkswagen%20gol`);
const primerId = ps.json?.results?.[0]?.id ?? ps.json?.results?.[0];
if (primerId && typeof primerId === "string") {
  console.log(`\n${"=".repeat(72)}\ndetalle del producto ${primerId} (¿trae precio?)\n`);
  const p = await get(`${API}/products/${primerId}`);
  console.log(`HTTP ${p.status}`);
  if (p.ok) {
    const j = p.json;
    console.log("  claves:", Object.keys(j).join(", "));
    console.log("  buy_box_winner:", JSON.stringify(j.buy_box_winner ?? null).slice(0, 400));
    console.log("  attributes:", (j.attributes ?? []).map((a) => `${a.id}=${a.value_name}`).slice(0, 10).join(" | "));
  }
}
console.log("");
