# fb_mp_scraper_api

API HTTP que extrae publicaciones de Facebook Marketplace (Playwright + Chromium
headless) y un servidor MCP en TypeScript que la expone como tool para clientes
MCP (Claude Desktop, Claude Code, etc.).

## Requisitos

- Node.js >= 20
- Chromium de Playwright: `npx playwright install chromium`

## Levantar la API

```bash
npm install
npx playwright install chromium   # una sola vez
npm start                         # escucha en http://localhost:4000
```

### Endpoint

`GET /api/marketplace`

| Parámetro  | Tipo   | Requerido | Descripción                                    |
| ---------- | ------ | --------- | ---------------------------------------------- |
| `query`    | string | sí        | Texto de búsqueda                              |
| `location` | string | no        | Slug de ubicación de Marketplace (default `montevideo`) |
| `minPrice` | int    | no        | Precio mínimo (entero, sin decimales)          |
| `maxPrice` | int    | no        | Precio máximo                                  |

### Respuesta OK (`200`)

Siempre `{ count, items }`. `count` es `items.length` **después** del filtro de
precio. Una búsqueda sin resultados no es un error: devuelve `200` con
`{ "count": 0, "items": [] }`.

```json
{
  "count": 1,
  "items": [
    {
      "id": "1487450843409462",
      "title": "Auto Lifan 320 1.3 Gris 🔥",
      "price": 125000,
      "priceRaw": "125 000 $U",
      "currency": "UYU",
      "oldPrice": 140000,
      "oldPriceRaw": "140 000 $U",
      "location": "Colonia Nicolich, Canelones, Uruguay",
      "thumbnail": "https://scontent.fmvd1-1.fna.fbcdn.net/v/t39...jpg",
      "url": "https://www.facebook.com/marketplace/item/1487450843409462/"
    }
  ]
}
```

#### Campos de cada item

Las diez claves están **siempre presentes**; las anulables traen `null`, nunca
se omiten.

| Campo         | Tipo             | ¿Null? | Descripción                                                             |
| ------------- | ---------------- | ------ | ----------------------------------------------------------------------- |
| `id`          | `string`         | sí     | ID numérico de la publicación, como string. `null` si el href no matchea |
| `title`       | `string`         | sí     | Título de la publicación. Fallback al `alt` de la imagen                 |
| `price`       | `number` (int)   | sí     | Precio parseado. `0` = gratis. `null` = sin precio detectable            |
| `priceRaw`    | `string`         | sí     | Precio tal cual lo muestra FB, con moneda: `"125 000 $U"`                |
| `currency`    | `string`         | sí     | `UYU` \| `USD` \| `ARS` \| `BRL` \| `EUR` \| `GBP`. `null` si es ambiguo   |
| `oldPrice`    | `number` (int)   | sí     | Precio anterior parseado. `null` si no hay descuento                     |
| `oldPriceRaw` | `string`         | sí     | Precio anterior crudo. `null` si no hay descuento                        |
| `location`    | `string`         | sí     | Ubicación. Puede traer comas: `"Pando, Canelones, Uruguay"`              |
| `thumbnail`   | `string`         | sí     | URL de la miniatura en el CDN de FB. **Caduca** (lleva `oe=` firmado)    |
| `url`         | `string`         | no     | URL canónica de la publicación                                           |

Notas sobre los precios:

- **`price` es un entero sin decimales y sin moneda.** Un `price: 125000` puede
  ser UYU o USD: siempre leé `currency` junto con él. Un listado mezcla ambas.
- **`currency` es `null` cuando FB muestra un `$` pelado** (típico en avisos de
  EE.UU.: `priceRaw: "80 $"`). Se prefiere `null` antes que adivinar UYU o USD.
- `minPrice` / `maxPrice` comparan contra `price` crudo, sin convertir moneda —
  igual que el propio filtro de Facebook.
- Los items sin `price` detectable se descartan sólo si mandaste alguna cota.

### Errores

Toda falla responde `{ "error": { "code", "message" } }` con un código explícito:

| Código           | HTTP | Significado                                                        |
| ---------------- | ---- | ------------------------------------------------------------------ |
| `BAD_REQUEST`    | 400  | Parámetros inválidos                                               |
| `LOGIN_REQUIRED` | 503  | Facebook exige sesión (no hay cookies configuradas o expiraron)    |
| `BLOCKED`        | 503  | Captcha / checkpoint (detección de bot)                            |
| `DOM_CHANGED`    | 502  | La página cargó pero los selectores no matchean (FB cambió el DOM) |
| `NAV_FAILED`     | 504  | Falló la navegación o Facebook devolvió un error HTTP              |
| `INTERNAL`       | 500  | Cualquier otra excepción no prevista                               |

```json
{ "error": { "code": "BAD_REQUEST", "message": "query parameter is required" } }
```

Los tres `BAD_REQUEST` posibles:

| Condición                        | `message`                                  |
| -------------------------------- | ------------------------------------------ |
| Falta `query` o está vacío       | `query parameter is required`              |
| `minPrice`/`maxPrice` no entero  | `minPrice must be a non-negative integer`  |
| `minPrice > maxPrice`            | `minPrice cannot be greater than maxPrice` |

### Comportamientos que conviene saber

- **Un `location` inválido no da error.** Facebook ignora el slug desconocido y
  responde desde otra ciudad (o redirige a `/marketplace/category/search/` sin
  ubicación). Vas a recibir `200` con items de un lugar que no pediste, o
  `count: 0`. Validá el slug del lado tuyo si te importa.
- **`thumbnail` caduca.** La URL viene firmada con expiración; si la vas a
  guardar, descargá la imagen, no el link.
- Los avisos duplicados que FB renderiza dos veces se deduplican por `id`.

### Sesión de Facebook (recomendado)

Sin sesión funciona: desde una IP residencial de Uruguay el Marketplace anónimo
devuelve resultados normalmente (verificado). Desde IPs de datacenter Facebook
suele redirigir al login, y en cualquier caso la sesión reduce el riesgo de que
te corten por volumen. Configurala por variable de entorno:

- `FB_COOKIES`: string de cookies crudo, por ejemplo `c_user=1000123...; xs=abc...`
  (copiá los valores de `c_user` y `xs` desde las DevTools del navegador con tu
  sesión abierta), o
- `FB_STORAGE_STATE`: ruta a un JSON de [storage state de Playwright](https://playwright.dev/docs/auth)
  generado con `npx playwright codegen --save-storage=fb-state.json facebook.com`.

Si la sesión expira, la API responde `LOGIN_REQUIRED` indicando que hay que
renovarla.

### Tuning opcional (variables de entorno)

| Variable                    | Default | Descripción                          |
| --------------------------- | ------- | ------------------------------------ |
| `PORT`                      | 4000    | Puerto de la API                     |
| `SCRAPER_MAX_CONCURRENCY`   | 2       | Scrapes simultáneos máximos          |
| `SCRAPER_NAV_TIMEOUT_MS`    | 30000   | Timeout de navegación                |
| `SCRAPER_RESULT_TIMEOUT_MS` | 15000   | Espera máxima a que aparezcan items  |
| `SCRAPER_SCROLL_PASSES`     | 3       | Pasadas de scroll para cargar más    |

## Servidor MCP

El directorio `mcp-server/` contiene un servidor MCP (stdio) sobre el SDK
oficial `@modelcontextprotocol/sdk` que expone la tool:

- **`search_marketplace`** — parámetros `query` (requerido), `location`,
  `minPrice`, `maxPrice`; devuelve `{ count, items }` tipado. Los errores del
  extractor llegan al cliente MCP con su código (`[LOGIN_REQUIRED] ...`).

### Build y ejecución

```bash
cd mcp-server
npm install
npm run build        # genera dist/index.js
```

El servidor MCP llama a la API HTTP, así que la API debe estar corriendo
(`npm start` en la raíz). La URL se configura con `MARKETPLACE_API_URL`
(default `http://localhost:4000`).

### Conectarlo a un cliente MCP

Claude Code:

```bash
claude mcp add fb-marketplace -e MARKETPLACE_API_URL=http://localhost:4000 \
  -- node /ruta/absoluta/fb_mp_scraper_api/mcp-server/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "fb-marketplace": {
      "command": "node",
      "args": ["/ruta/absoluta/fb_mp_scraper_api/mcp-server/dist/index.js"],
      "env": { "MARKETPLACE_API_URL": "http://localhost:4000" }
    }
  }
}
```

---

## Pipeline de oportunidades

El extractor dejó de ser "la API": ahora es una librería que consume un worker
programado, y la API sirve el ranking desde la base.

```bash
npm run worker:dry     # busca, puntúa y muestra el ranking SIN base de datos
npm run migrate        # aplica el schema (necesita DATABASE_URL)
npm run worker         # corrida completa con persistencia
npm test               # 31 tests unitarios del scorer, sin tocar Facebook
```

### Búsqueda por categoría, no por texto

`GET /api/marketplace?query=auto` devolvía autos a batería, sillas de bebé y
Hot Wheels: 1 vehículo real de 24. La búsqueda ahora usa la categoría de autos,
cuyos filtros corren del lado de Facebook.

```js
import { searchVehicles } from "./src/services/marketplace/search.mjs";
await searchVehicles({ location: "montevideo", minPrice: 5000, maxPrice: 12000 });
// -> /marketplace/montevideo/cars?minPrice=5000&maxPrice=12000
```

Verificado: **24 de 24 vehículos reales**, todos en la categoría `807311116002614`.

Los slugs de ubicación se validan localmente contra `KNOWN_LOCATIONS`: Facebook
no valida el suyo y sirve otra ciudad ante un slug desconocido.

### La moneda que Facebook reporta es incorrecta

Un Volkswagen Gol publicado como `11 500 $U` (pesos) tiene en su propia
descripción `PRECIO: USD 11.500`. El JSON del detalle confirma
`currency: "UYU"`. Los vendedores uruguayos escriben la cifra en dólares en un
campo denominado en pesos.

Por eso se guardan **tres** campos y ninguno se convierte al escribir:

| Campo                 | Qué es                                          |
| --------------------- | ----------------------------------------------- |
| `currency_reported`   | Exactamente lo que dijo Facebook                |
| `currency_resolved`   | Nuestra lectura, por magnitud del monto         |
| `currency_confidence` | `high` / `low` / `none`                         |

### La trampa de los financiados

Los avisos financiados publican **la entrega, no el precio del auto**. Un Ford
EcoSport 2017 aparecía a "USD 5000" — era la seña de un plan en cuotas, y su
odómetro estructurado decía `5000` mientras la descripción decía `98000km`.

Encabezan cualquier ranking por precio y nunca son oportunidades reales, así que
se **descalifican** (`score = -1`) y no llegan a la cola de contacto. En una
corrida real, 3 de los 4 mejores candidatos por precio eran de este tipo.

El kilometraje estructurado se contrasta contra la descripción: si difieren más
de 3x, gana la descripción y queda registrado en `mileageConflict`.

### Scoring trazable

Cada listing guarda su desglose completo: cada subscore con su peso y su
contribución, de modo que el ranking siempre se puede explicar.

- **v1** (grilla): `price`, `priceDrop`, `staleness`, `priceChanges`
- **v2** (+ detalle): agrega `km` (km/año, no km absolutos), `flags`, `seller`

`staleness` usa el `creation_time` de Facebook, no `first_seen_at`: la
antigüedad real está disponible desde la primera corrida.

Cuando la referencia de mercado tiene menos de 5 comparables, el peso del
subscore de precio se recorta al 25% y se redistribuye, para que una referencia
pobre no decida el ranking.

### Precio de referencia

`GET /sites/MLU/search` de MercadoLibre **ya no es público** (403
`PA_UNAUTHORIZED_RESULT_FROM_POLICIES`). Configurá `MELI_CLIENT_ID` +
`MELI_CLIENT_SECRET`, o `MELI_ACCESS_TOKEN`. Sin credenciales, la referencia cae
a la mediana de nuestros propios listings comparables, marcada como
`source: "internal"` — dice cómo se compara un auto contra el resto de Facebook,
no contra valor de mercado.

En ambos casos se descartan outliers fuera del rango p10–p90 antes de la
mediana: en una sola página de Facebook aparecieron precios de 1, 111111 y
1000000.

### Cola de contacto

La oferta se ancla a la **mediana de mercado**, nunca a un porcentaje fijo del
precio publicado, y nunca supera lo que el vendedor pide. Cada entrada trae su
expectativa de aceptación (`alta` / `media` / `baja`) según la distancia al
precio publicado.

**No hay envío automático.** La cola queda en estado `pending` para aprobación y
envío manual.

### Rate limiting

Delay aleatorio de 8–20s antes de cada navegación (`SCRAPER_MIN_DELAY_MS` /
`SCRAPER_MAX_DELAY_MS`), tope de concurrencia, y presupuesto duro de 100
listings por proceso (`SCRAPER_SESSION_BUDGET`). La sesión se re-persiste tras
cada corrida en `FB_STORAGE_STATE_OUT`, para no perder una rotación de Facebook.

### Datos personales

Se guarda el mínimo del vendedor: `seller_id` y conteo de publicaciones activas.
El payload de detalle expone `seller_phone_number` y el nombre del vendedor —
**no se leen ni se persisten** (Ley 18.331).
