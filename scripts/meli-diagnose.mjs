#!/usr/bin/env node
/**
 * Por qué MercadoLibre devuelve 403 CON un token válido.
 *
 * `meli:check` responde "¿está configurado?". Esto responde "¿qué me deja hacer
 * este token?", que es otra pregunta: el token se emite bien (si no, el error
 * sería invalid_client) y aun así la búsqueda corta. El cuerpo del 403 nombra
 * la política, y sin eso no se sabe si falta un scope, si la app necesita
 * habilitación o si el endpoint directamente exige token de usuario.
 *
 * No imprime el token: sólo su prefijo, para poder identificarlo sin filtrarlo.
 */
import { config } from "../src/config.mjs";
import { debugToken, MeliUnavailableError } from "../src/services/reference/meli.mjs";

const API = "https://api.mercadolibre.com";
const SITE = config.meli.siteId;
const CAT = config.meli.carsCategory;

let token;
try {
  const t = await debugToken();
  token = t.token;
  console.log(`\ntoken obtenido vía ${t.source}`);
  if (t.raw) {
    console.log(`  token_type : ${t.raw.token_type ?? "?"}`);
    console.log(`  expires_in : ${t.raw.expires_in ?? "?"}s`);
    console.log(`  scope      : ${t.raw.scope ?? "(sin scope declarado)"}`);
    console.log(`  user_id    : ${t.raw.user_id ?? "(ninguno — es token de app, no de usuario)"}`);
  }
  console.log(`  valor      : ${String(token).slice(0, 12)}…\n`);
} catch (err) {
  if (err instanceof MeliUnavailableError) { console.error(`\nno se pudo obtener el token:\n  ${err.message}\n`); process.exit(1); }
  throw err;
}

/** Cada endpoint con y sin token, para separar "falta auth" de "auth insuficiente". */
const pruebas = [
  ["categoría (control, anónimo)",        `${API}/categories/${CAT}`,                          false],
  ["categoría con token",                 `${API}/categories/${CAT}`,                          true],
  ["búsqueda por categoría",              `${API}/sites/${SITE}/search?category=${CAT}&limit=1`, true],
  ["búsqueda por texto",                  `${API}/sites/${SITE}/search?q=gol&limit=1`,          true],
  ["búsqueda sin site (global)",          `${API}/products/search?status=active&site_id=${SITE}&q=gol`, true],
  ["/users/me (¿es token de usuario?)",   `${API}/users/me`,                                    true],
  ["info del site",                       `${API}/sites/${SITE}`,                               true],
  ["tendencias del site",                 `${API}/trends/${SITE}`,                              true],
];

for (const [nombre, url, conToken] of pruebas) {
  const headers = { accept: "application/json" };
  if (conToken) headers.authorization = `Bearer ${token}`;
  let res, body;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    body = await res.text();
  } catch (err) {
    console.log(`  ??? ${nombre.padEnd(38)} error de red: ${err.message}`);
    continue;
  }
  const marca = res.ok ? "\x1b[32m OK\x1b[0m" : "\x1b[31m" + String(res.status).padStart(3) + "\x1b[0m";
  console.log(`  ${marca} ${nombre.padEnd(38)} ${res.ok ? "" : body.replace(/\s+/g, " ").slice(0, 150)}`);
}

console.log(`
Cómo leerlo:
  - Si "categoría con token" da OK pero las búsquedas dan 403, el token es
    válido y el bloqueo es de política sobre el endpoint de búsqueda.
  - Si /users/me da 403 o 401, el token es de aplicación y no de usuario: hay
    endpoints que sólo aceptan token de usuario (flujo authorization_code).
  - El código dentro del cuerpo (PA_UNAUTHORIZED_RESULT_FROM_POLICIES,
    forbidden, etc.) es lo que hay que buscar en el soporte de MercadoLibre.
`);
