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

Respuesta OK (`200`):

```json
{
  "count": 2,
  "items": [
    {
      "id": "1234567890",
      "title": "Bicicleta rodado 29",
      "price": 1500,
      "priceRaw": "$ 1.500",
      "oldPriceRaw": null,
      "location": "Montevideo",
      "thumbnail": "https://scontent...",
      "url": "https://www.facebook.com/marketplace/item/1234567890/"
    }
  ]
}
```

`price` es el número parseado (0 = gratis, `null` = sin precio detectable);
`priceRaw` conserva el string original con su moneda.

### Errores

Toda falla responde `{ "error": { "code", "message" } }` con un código explícito:

| Código           | HTTP | Significado                                                        |
| ---------------- | ---- | ------------------------------------------------------------------ |
| `BAD_REQUEST`    | 400  | Parámetros inválidos                                               |
| `LOGIN_REQUIRED` | 503  | Facebook exige sesión (no hay cookies configuradas o expiraron)    |
| `BLOCKED`        | 503  | Captcha / checkpoint (detección de bot)                            |
| `DOM_CHANGED`    | 502  | La página cargó pero los selectores no matchean (FB cambió el DOM) |
| `NAV_FAILED`     | 504  | Falló la navegación o Facebook devolvió un error HTTP              |

"Sin resultados" **no** es un error: responde `200` con `items: []`.

### Sesión de Facebook (recomendado)

Desde IPs de datacenter (y a menudo también residenciales) Facebook redirige el
Marketplace anónimo al login. Configurá una sesión por variable de entorno:

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
