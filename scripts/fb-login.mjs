#!/usr/bin/env node
/**
 * Captura tu sesión de Facebook a un archivo, abriendo un navegador de verdad.
 *
 *   npm run fb:login
 *
 * Abre Chromium con ventana, esperás a que loguees a mano (usuario, clave, 2FA,
 * lo que Facebook pida) y en cuanto detecta la sesión guarda el storage state.
 *
 * Por qué así y no copiando cookies del DevTools: el storage state se lleva
 * TODAS las cookies más el localStorage, así que sobrevive más y Facebook lo ve
 * como el mismo navegador que hizo el login. Pegar sólo `c_user` y `xs` a mano
 * también funciona, pero es más frágil y se rompe antes.
 *
 * El archivo que sale es un TOKEN VIVO: quien lo tenga entra a tu cuenta sin
 * contraseña ni segundo factor. Está en .gitignore; no lo pegues en ningún lado.
 */
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const destino = resolve(process.argv[2] ?? process.env.FB_STORAGE_STATE ?? "./fb-state.json");
const ESPERA_MAX_MS = 5 * 60_000;

console.log(`\nAbriendo Chromium. Logueate en la ventana que se abre.`);
console.log(`Cuando Facebook te deje adentro, esto guarda solo en:\n  ${destino}\n`);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ locale: "es-ES", timezoneId: "America/Montevideo" });
const page = await context.newPage();
await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded" });

/** `c_user` es el id de usuario: aparece recién cuando la sesión quedó abierta. */
const logueado = async () => (await context.cookies()).some((c) => c.name === "c_user" && c.value);

const desde = Date.now();
let listo = false;
while (Date.now() - desde < ESPERA_MAX_MS) {
  if (await logueado()) { listo = true; break; }
  await page.waitForTimeout(1500);
}

if (!listo) {
  console.error(`\nSe agotaron los ${ESPERA_MAX_MS / 60000} minutos sin detectar sesión. No se guardó nada.`);
  await browser.close();
  process.exit(1);
}

// Un rato más: después del login Facebook termina de asentar cookies, y guardar
// en el primer instante deja un estado a medio hacer.
await page.waitForTimeout(3000);
const state = await context.storageState();
await writeFile(destino, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
await browser.close();

const cookies = state.cookies.filter((c) => c.domain.includes("facebook")).length;
console.log(`\n✓ Sesión guardada (${cookies} cookies de facebook.com), permisos 600.`);
console.log(`\nAgregá esto al .env:`);
console.log(`  FB_STORAGE_STATE=${destino}`);
console.log(`  FB_STORAGE_STATE_OUT=${destino}\n`);
console.log(`Lo segundo hace que, si Facebook rota la sesión durante una corrida,`);
console.log(`la versión nueva se escriba de vuelta y no se pierda.\n`);
console.log(`Después: npm run fb:check\n`);
