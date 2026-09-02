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
import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Deja las variables puestas en el .env.
 *
 * Antes esto sólo imprimía las líneas para copiar, y ese es justo el paso que
 * se saltea: `fb:check` seguía diciendo "sesión: NINGUNA" con el archivo ya
 * guardado al lado. Nunca pisa un valor que ya esté puesto — si ya apuntás a
 * otra sesión, avisa y no toca nada.
 */
async function ponerEnEnv(destino) {
  const envPath = resolve("./.env");
  let contenido = "";
  let existia = true;
  try {
    contenido = await readFile(envPath, "utf8");
  } catch {
    existia = false;
  }

  const CLAVES = ["FB_STORAGE_STATE", "FB_STORAGE_STATE_OUT"];
  const activa = (clave) => {
    const m = new RegExp(`^\\s*${clave}\\s*=\\s*(.+)$`, "m").exec(contenido);
    const v = m?.[1]?.trim();
    return v ? v : null;
  };

  // Las dos claves se deciden JUNTAS. Si una ya apunta a otra sesión y la otra
  // se reescribe igual, quedás leyendo de una y escribiendo en la otra, que es
  // peor que no hacer nada: mezcla dos sesiones sin que se note.
  const yaEstaban = CLAVES.map((k) => [k, activa(k)])
    .filter(([, v]) => v && v !== destino)
    .map(([k, v]) => `${k}=${v}`);
  if (yaEstaban.length) return { envPath, existia, puestas: [], yaEstaban };

  const puestas = [];
  for (const clave of CLAVES) {
    if (activa(clave) === destino) continue;           // ya apunta acá
    contenido = contenido.replace(new RegExp(`^\\s*#\\s*${clave}\\s*=.*$`, "m"), "");
    contenido += `${contenido.endsWith("\n") || !contenido ? "" : "\n"}${clave}=${destino}\n`;
    puestas.push(clave);
  }

  if (puestas.length) {
    await writeFile(envPath, contenido, { encoding: "utf8", mode: 0o600 });
  }
  return { envPath, existia, puestas, yaEstaban };
}

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
console.log(`  ${destino}`);

const env = await ponerEnEnv(destino);
if (env.puestas.length) {
  console.log(`\n✓ ${env.existia ? "Actualizado" : "Creado"} ${env.envPath}:`);
  for (const k of env.puestas) console.log(`    ${k}=${destino}`);
  console.log(`\n  FB_STORAGE_STATE_OUT es adónde se reescribe la sesión si Facebook la`);
  console.log(`  rota durante una corrida. Sin eso, la rotación se pierde.`);
} else if (env.yaEstaban.length) {
  console.log(`\n! El .env ya apunta a otra sesión, no se tocó:`);
  for (const l of env.yaEstaban) console.log(`    ${l}`);
  console.log(`\n  Si querés usar la que acabás de capturar, cambialas a:`);
  console.log(`    FB_STORAGE_STATE=${destino}`);
  console.log(`    FB_STORAGE_STATE_OUT=${destino}`);
} else {
  console.log(`\n✓ El .env ya apuntaba acá.`);
}
console.log(`\nAhora: npm run fb:check\n`);
