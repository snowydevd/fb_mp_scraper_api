# fb_mp_scraper_api

API HTTP que extrae publicaciones de Facebook Marketplace (Playwright + Chromium
headless) y un servidor MCP en TypeScript que la expone como tool para clientes
MCP (Claude Desktop, Claude Code, etc.).

## Requisitos

- Node.js >= 20
- Chromium de Playwright: `npx playwright install chromium`
- Opcional: Docker, sólo para correr los tests de integración contra Postgres

## Levantar la API

```bash
npm install
npx playwright install chromium   # una sola vez
npm start                         # escucha en http://localhost:4000
```

### Endpoints

| Método  | Ruta                     | Qué hace                                              |
| ------- | ------------------------ | ----------------------------------------------------- |
| `GET`   | `/health`                | Estado y qué está configurado (base, sesión de Facebook) |
| `GET`   | `/api/opportunities`     | Ranking puntuado desde la base (sin automotoras)       |
| `GET`   | `/api/contact-queue`     | Borradores pendientes de aprobación humana             |
| `PATCH` | `/api/contact-queue/:id` | `{ status }` — aprobar / descartar / marcar enviado    |
| `GET`   | `/api/marketplace`       | Búsqueda por texto en vivo (scrapea Facebook)          |

`GET /api/opportunities` acepta `limit` (≤200), `minScore` e `includeDealers=1`.
`GET /api/contact-queue` acepta `status` (`pending` por defecto, o `all`) y `limit`.

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
| `NOT_FOUND`      | 404  | Ruta inexistente, o entrada de la cola inexistente                 |
| `NO_DATABASE`    | 503  | `DATABASE_URL` no configurada (endpoints que leen de la base)      |
| `INTERNAL`       | 500  | Cualquier otra excepción no prevista                               |

`INTERNAL` responde `"internal server error"` y nada más: el stack y las rutas
del filesystem quedan en el log del servidor, nunca en la respuesta.

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

### Sesión de Facebook

Sin sesión funciona —desde una IP residencial de Uruguay el Marketplace anónimo
devuelve resultados, verificado— **pero corta en 24 resultados**:

| filtro | resultados |
| --- | ---: |
| precio 5000–12000 | 24 |
| precio 0–100000 | 24 |
| 5000–12000 con `SCRAPER_SCROLL_PASSES=10` | 24 |

Ese tope **no era de Facebook, era nuestro**. El payload embebido en `<script>`
sólo trae la primera página, la que renderizó el servidor. Medido con sesión
puesta, scrolleando:

| | inicial | scroll 1 | scroll 2 | scroll 3+ |
| --- | ---: | ---: | ---: | ---: |
| nodos en `<script>` | 24 | 24 | 24 | 24 |
| anchors en el DOM | 21 | **42** | 22 | 22 |
| consultas GraphQL | 9 | 10 | 14 | 14 |

El scroll **sí** trae más avisos —las consultas GraphQL suben— pero no van a los
`<script>`, y leer el DOM tampoco sirve porque la grilla está **virtualizada**:
los nodos saltaron a 42 y volvieron a 22 cuando Facebook recicló los que salieron
de pantalla.

Lo único que persiste es la respuesta. `collectGraphqlListings` engancha las
respuestas de `/api/graphql` y saca de ahí los nodos, que son el MISMO JSON de
Relay servido por la red: sigue valiendo la regla de preferirlo antes que los
selectores. Se fusiona con lo del `<script>` por id.

Resultado medido: **24 → 49 avisos** con las 3 pasadas de scroll por defecto.
`SCRAPER_SCROLL_PASSES` es ahora la palanca del caudal.

Y algo que sólo aparece con sesión: **los nodos de GraphQL traen `seller_id`**,
que los del `<script>` traían vacío. Eso convierte la detección de automotoras
de heurística de texto en un conteo. En una corrida real: 18 vendedores para 49
avisos, y **4 de ellos concentraban 34** —uno solo tenía 16 publicaciones
activas—. Esas 34 se saltean sin gastar una navegación.

```bash
npm run fb:login    # abre Chromium, logueás a mano, guarda la sesión y el .env
npm run fb:check    # verifica que sirve y compara contra el tope de 24
```

`fb:login` **deja las variables puestas en el `.env` solo**. Antes sólo imprimía
las líneas para copiar, y ése es justo el paso que se saltea: `fb:check` seguía
diciendo "sesión: NINGUNA" con el archivo ya guardado al lado. Nunca pisa un
valor que ya esté puesto — si el `.env` ya apunta a otra sesión, avisa y no toca
nada, porque escribir sólo una de las dos claves te dejaría leyendo de una
sesión y escribiendo en otra.

Guarda un [storage state de Playwright](https://playwright.dev/docs/auth):
todas las cookies más el localStorage, así que sobrevive más que pegar `c_user`
y `xs` a mano, y Facebook lo ve como el mismo navegador que hizo el login.

`FB_STORAGE_STATE_OUT` es adónde se reescribe la sesión si Facebook la rota
durante una corrida. Sin eso, la rotación se pierde al cerrar el contexto y la
sesión envejece antes.

A mano también sirve, y es más frágil:
`FB_COOKIES="c_user=1000123...; xs=abc..."` copiando esas dos cookies del
DevTools.

> **El archivo de sesión es un token vivo.** Quien lo tenga entra a tu cuenta sin
> contraseña ni segundo factor — peor que filtrar una contraseña, porque no hay
> nada que rotar salvo cerrar todas las sesiones. Está cubierto por `.gitignore`
> (`*state*.json`, `*session*.json`, `*cookies*.json`, `fb-*.json`) y `fb:login`
> lo escribe con permisos 600. Conviene usar una cuenta secundaria: asumí que
> las cuentas se pierden, y que la sesión sea fácil de rotar.

Si la sesión expira, la API responde `LOGIN_REQUIRED`; volvé a correr
`npm run fb:login`.

### Tuning opcional (variables de entorno)

| Variable                    | Default | Descripción                          |
| --------------------------- | ------- | ------------------------------------ |
| `PORT`                      | 4000    | Puerto de la API                     |
| `SCRAPER_MAX_CONCURRENCY`   | 2       | Scrapes simultáneos máximos          |
| `SCRAPER_NAV_TIMEOUT_MS`    | 30000   | Timeout de navegación                |
| `SCRAPER_RESULT_TIMEOUT_MS` | 15000   | Espera máxima a que aparezcan items  |
| `SCRAPER_SCROLL_PASSES`     | 3       | Pasadas de scroll para cargar más    |
| `SCRAPER_MIN_DELAY_MS`      | 8000    | Piso del delay aleatorio por navegación |
| `SCRAPER_MAX_DELAY_MS`      | 20000   | Techo del delay aleatorio            |
| `SCRAPER_SESSION_BUDGET`    | 100     | Listings máximos por corrida         |
| `DATABASE_URL`              | —       | Postgres; sin esto la API sólo scrapea |
| `WORKER_INTERVAL_HOURS`     | 6       | Cada cuánto corre el worker programado |
| `WORKER_JITTER_PCT`         | 0.2     | Jitter aplicado al intervalo         |
| `WORKER_ACTIVE_HOURS`       | 9-22    | Ventana horaria en que puede correr  |
| `UYU_PER_USD`               | —       | Tipo de cambio para sumar deuda en la otra moneda; sin esto no se convierte |
| `DETAIL_SCORE_THRESHOLD`    | 0       | Piso de score para abrir el detalle |
| `DETAIL_MAX_PER_RUN`        | 5       | Detalles máximos por corrida |

## Servidor MCP

El directorio `mcp-server/` contiene un servidor MCP (stdio) sobre el SDK
oficial `@modelcontextprotocol/sdk` que expone tres tools:

- **`list_opportunities`** — el ranking de oportunidades ya puntuadas, mejor
  primero. Lee la base, **no scrapea**, así que llamarla es gratis. Cada fila
  trae el `breakdown` completo del score. Las automotoras se excluyen por
  defecto; `includeDealers: true` existe para auditar el filtro.
- **`list_contact_queue`** — los borradores pendientes de revisión, cada uno con
  los hechos para juzgarlo: kilometraje, deuda declarada, días publicado. **No
  trae monto sugerido**, el precio lo decidís vos. Es de solo lectura a
  propósito: aprobar o descartar es una decisión humana, por
  `PATCH /api/contact-queue/:id`.
- **`search_marketplace`** — el camino viejo por texto libre: `query`
  (requerido), `location`, `minPrice`, `maxPrice`. Devuelve lo que matchee el
  texto, juguetes incluidos; para autos usá el pipeline. Los errores del
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
npm run worker:dry        # busca, puntúa y muestra el ranking SIN base de datos
npm run migrate           # aplica el schema (necesita DATABASE_URL)
npm run worker            # corrida completa con persistencia
npm run worker:schedule   # worker programado (cada ~6h, con jitter y ventana horaria)
npm test                  # 115 tests unitarios, sin tocar Facebook ni Postgres
npm run test:integration  # 29 tests contra un Postgres real (ver abajo)
```

Los tests de integración se saltean solos si no hay `TEST_DATABASE_URL`:

```bash
npm run db:up             # Postgres 16 en docker, puerto 55432
TEST_DATABASE_URL=postgres://postgres:dev@localhost:55432/fbmp npm run test:integration
npm run db:down
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

### Repuestos publicados como si fueran autos

La categoría la elige el **vendedor**, y publicar una cubierta dentro de "Autos
y camionetas" da mucha más visibilidad que ponerla en repuestos. Así llegaron a
la cola de contacto títulos como "Cubierta rodado 17" y "Tapa de válvulas", con
un borrador ofreciendo miles de dólares por una pieza.

Filtrar por `marketplace_listing_category_id` **no alcanza** justamente por eso:
esas publicaciones traen la categoría de autos, porque es ahí donde el vendedor
las puso. Igual se chequea, porque es gratis y ataja el otro caso (la categoría
`vehicles`, que sí incluye repuestos de verdad).

El riesgo caro acá es el **falso positivo**: descartar un auto real no se nota
en ningún log, simplemente nunca aparece. Por eso `vehicle-filter.mjs`:

- mira **sólo el título**, nunca la descripción — la descripción de un auto real
  habla de piezas todo el tiempo ("motor impecable", "cubiertas nuevas",
  "tapizado original");
- usa dos niveles de término. El **fuerte** (`cubierta`, `tapa de válvulas`,
  `alternador`, `paragolpes`, `amortiguador`…) alcanza solo, incluso si el
  título nombra una marca: "Tapa de válvulas Volkswagen Gol" sigue siendo una
  tapa de válvulas. El **débil** (`motor`, `caja`, `puerta`, `asiento`) sólo
  cuenta si la pieza es el **sujeto** del título — "Motor Fiat Uno 1.4" es un
  motor, "Fiat Uno 1.4 motor impecable" es un auto.

También se cortan los **vehículos que no son autos** publicados igual en "Autos
y camionetas": motos, cuatriciclos, trailers, casas rodantes, y las
publicaciones genéricas de agencia ("Vehículos varios", "Consultar stock").
Visto en vivo: un "2017 husqvarna fc" —una moto de cross— con la categoría de
autos. Sólo se usan marcas que en Uruguay son EXCLUSIVAMENTE de moto: Suzuki y
Honda hacen las dos cosas, y ponerlas en esa lista se llevaría autos de verdad.

El corte va **antes de persistir**, porque un repuesto no sólo ensucia la cola:
entra a `listings`, se puntúa, y sobre todo entra en la mediana interna de
precios, donde una cubierta "de USD 850" arrastra para abajo la referencia que
decide todo el ranking. El snapshot crudo sí guarda la tanda completa: existe
para poder reparsear sin re-scrapear, y guardando sólo lo que pasó el filtro de
hoy nunca podríamos revisar si el filtro se comió algo.

Los 24 títulos de una corrida real están como fixture en los tests: ninguno
puede caer en el filtro.

### Automotoras: el filtro principal

El negocio es comprarle a un particular con motivo para vender. Una automotora
tiene margen que defender, publica a precio de mercado y no acepta una oferta al
contado por debajo — una automotora arriba del ranking no es un casi-acierto,
es ruido que cuesta un contacto.

`vehicle_seller_type` de Facebook es decisivo **cuando viene**, y muy seguido no
viene. El aviso `1049705647676534` ("Fiat uno way divino con A/C NOAHCARS")
llegó con `vehicle_seller_type: null` y `dealership_name: null`, mientras su
descripción decía "Noah Cars / Venta - Permuta - Financiación / Contamos con
servicio de escribania y gestoria". Por eso se combinan tres familias de señal
(`src/services/scoring/dealer.mjs`) y ninguna se cree sola:

| Familia      | Señal                                            | Peso        |
| ------------ | ------------------------------------------------ | ----------- |
| Estructural  | `vehicle_seller_type`, `dealership_name`         | decisiva    |
| Conductual   | N publicaciones activas del mismo `seller_id`    | decisiva a partir de 3 |
| Textual      | el vocabulario de un negocio de autos            | acumulativa |

Las señales textuales son débiles **a propósito**: "permuta" sola es un
particular abierto a un canje; "permuta" + "financiación" + "escribanía" es un
negocio. Se suman hasta un umbral (`DEALER_THRESHOLD = 0.6`) en vez de que un
solo término defina el veredicto.

El corte está en dos lugares, y los dos hacen falta:

1. En el scorer, `scoreV2` descalifica (`score = -1`) fuera de la suma
   ponderada — con peso 0.08 el subscore de vendedor nunca podría sacar a una
   automotora del ranking por sí solo.
2. En el worker, antes de armar el borrador de contacto.

Además, las automotoras detectadas se **excluyen de la referencia interna de
precios**: en la corrida observada, 4 de 24 avisos eran de la misma automotora,
así que la "mediana de mercado" que decidía el ranking se construía en parte con
los avisos que el pipeline existe para excluir.

**Todo el texto se normaliza antes de matchear** (`scoring/text.mjs`): sin
tildes, en minúsculas, con los emoji convertidos en separador. Escritos contra
el texto crudo, los patrones fallaban en silencio — `/\bfinanciad[oa]\b/` nunca
matcheaba "Financiación" y `/\bpermuto\b/` nunca matcheaba "Permuta".

### Deuda, prenda y embargo

Los términos de gravamen se pesan por separado, porque no son lo mismo: una
**prenda** viva bloquea la transferencia hasta cancelarla, mientras que una
**deuda de patente** es chica, conocida y se descuenta del precio.

| Término            | Peso  |
| ------------------ | ----- |
| `embargo`          | -0.45 |
| `prenda`           | -0.40 |
| `gravamen`         | -0.40 |
| `deuda`            | -0.35 |
| `debe`             | -0.30 |
| `saldo`            | -0.25 |
| `deuda de patente` | -0.15 |
| `multas`           | -0.15 |

**El contexto anula el término.** Sin esto el sistema penalizaba al vendedor por
decir que el auto NO debe nada: "sin deuda" daba -0.20 y "no debe nada" -0.30,
o sea que la señal de vendedor honesto que más queremos era justo la que
restaba. El caso más caro era **"sin embargo"**: la conjunción adversativa más
común del español matcheaba `/\bembargo\b/` y valía -0.45, así que cualquier
vendedor escribiendo prosa normal ("tiene detalles de pintura, sin embargo el
motor está impecable") quedaba marcado como auto embargado.

Anulan el término que viene después: `sin`, `no tiene/debe/adeuda`, `libre de`.
Y apareciendo después: `cancelada`, `levantada`, `saldada`, `pagada`. Una prenda
levantada es un trámite terminado, no un gravamen.

La ventana de contexto es chica (28 caracteres) a propósito: con una ventana
grande, un "sin" de cualquier parte del aviso anularía una prenda mencionada
tres oraciones más abajo.

Cada aparición se evalúa por separado, así que "sin deuda de patente, pero debe
multas" anula la primera y cuenta la segunda. Lo anulado se devuelve en
`neutralised` en vez de desaparecer, y un término específico que reemplaza a uno
genérico (`deuda de patente` sobre `deuda`) deja el genérico visible con
`counted: false` — el desglose tiene que explicar el score, y un hit con peso
que no está sumado hace que los números no cierren para quien los lea.

Del otro lado suman: `libre de deuda`, `sin deuda`, `no debe nada`,
`sin prenda`, `patente al día`, `prenda cancelada`, `único dueño`,
`papeles al día`.

### El contexto anula el término

Sin esto el sistema penalizaba al vendedor por decir que el auto **no** debe
nada: "sin deuda" daba -0.20 y "no debe nada" -0.30, o sea que la señal de
vendedor honesto que más queremos era justo la que restaba. El caso más caro era
**"sin embargo"**: la conjunción adversativa más común del español matcheaba
`/\bembargo\b/` y valía -0.45, así que cualquier vendedor escribiendo prosa
normal quedaba marcado como auto embargado.

Anulan el término que viene después: `sin`, `no tiene/debe/adeuda`, `libre de`.
Y apareciendo después: `cancelada`, `levantada`, `saldada`, `pagada`. La ventana
es de 28 caracteres a propósito: con una grande, un "sin" de cualquier parte del
aviso anularía una prenda mencionada tres oraciones más abajo.

Lo anulado vuelve en `neutralised` en vez de desaparecer.

### Deuda: la mitad de la decisión

`deuda` es un subscore propio con el 30% del peso de v2, separado de `condicion`
a propósito: "debe plata" y "está chocado" son preguntas distintas, y un
desglose que las mezcla no explica por qué un auto quedó abajo.

Los términos se pesan distinto porque no son lo mismo: una **prenda** viva
bloquea la transferencia hasta cancelarla, una **deuda de patente** es chica,
conocida y se descuenta al negociar.

| Término | Peso | | Término | Peso |
| --- | ---: | --- | --- | ---: |
| `embargo` | -0.45 | | `libre de deuda` | +0.20 |
| `prenda` | -0.40 | | `sin deuda` | +0.18 |
| `gravamen` | -0.40 | | `no debe nada` | +0.18 |
| `deuda` | -0.35 | | `sin prenda` | +0.15 |
| `debe` | -0.30 | | `patente al día` | +0.12 |
| `saldo` | -0.25 | | `prenda cancelada` | +0.10 |
| `deuda de patente` | -0.15 | | | |
| `multas` | -0.15 | | | |

`debt.mjs` además parsea el **monto**, que va a los hechos de la cola. Nunca se
suma un monto cuya moneda no esté declarada: un `$` pelado es ambiguo en
Uruguay, y una deuda en la otra moneda sin `UYU_PER_USD` configurado tampoco se
convierte. Y un número cerca de la palabra "deuda" no es un monto: "deuda de
patente **2024 y 2025**" son los años que se adeudan.

### La trampa de los financiados

Los avisos financiados publican **la entrega, no el precio del auto**. Un Ford
EcoSport 2017 aparecía a "USD 5000" — era la seña de un plan en cuotas, y su
odómetro estructurado decía `5000` mientras la descripción decía `98000km`.

Encabezan cualquier ranking por precio y nunca son oportunidades reales, así que
se **descalifican** (`score = -1`) y no llegan a la cola de contacto. En una
corrida real, 3 de los 4 mejores candidatos por precio eran de este tipo.

El kilometraje estructurado se contrasta contra la descripción: si difieren más
de 3x, gana la descripción y queda registrado en `mileageConflict`.

### Scoring: kilometraje y deuda

El ranking contesta una sola pregunta: **¿a cuál de estos autos vale la pena
escribirle?** No contesta si el precio es bueno — eso lo decidís vos, y la banda
de precio ya se filtra del lado de Facebook al buscar, así que todo lo que llega
está dentro del presupuesto.

| Subscore     | v1 (grilla) | v2 (con detalle) | Qué mide |
| ------------ | ----------: | ---------------: | -------- |
| `km`         | 0.50 | 0.38 | kilometraje |
| `deuda`      |    — | 0.30 | prenda, embargo, patente, multas |
| `seller`     | 0.28 | 0.14 | automotora / revendedor |
| `condicion`  |    — | 0.08 | chocado, para repuestos, único dueño |
| `staleness`  | 0.15 | 0.06 | días publicado |
| `priceDrop`  | 0.05 | 0.03 | bajó el precio |
| `priceChanges` | 0.02 | 0.01 | cuántas veces lo bajó |

**El precio no puntúa.** Antes se llevaba el 38–42% del peso, anclado a una
mediana que venía de MercadoLibre o del propio lote de Facebook. MercadoLibre
bloqueó `/sites/{site}/search` (403 con token de usuario válido y todo lo demás
respondiendo), y la mediana del lote se compara contra sí misma. Un número que
aparenta fundamento es peor que ninguno.

**El kilometraje se mide dos veces y manda la peor.** El km/año dice cómo se usó
el auto; el km absoluto dice cuánta vida le queda, que es lo que se revende. Un
2008 con 210.000 km hizo 11k/año —uso normal— y midiendo sólo km/año puntuaba
igual que un 2015 con 57.000. Para comprar y revender no son ni parecidos.

Un km implausiblemente bajo penaliza igual que uno alto, por dos motivos
distintos: un tablero corregido es un riesgo, y —mucho más común— un usado de
USD 5.000–12.000 con "5.000 km" no tiene 5.000 km.

#### El km de la grilla miente de una forma específica

Los avisos financiados publican **la entrega en el campo del odómetro**. En la
grilla eso sale como "5.000 km" en un auto que pide USD 5.000, y sin descripción
no hay con qué contrastarlo. Medido en una corrida real: **4 de los 6
kilometrajes de la grilla eran el precio**, y los cuatro eran avisos financiados
que se llevaron el presupuesto de navegación entero.

La coincidencia exacta entre precio y "kilometraje" no pasa por azar, así que se
descarta. Es la misma mentira que `mapDetail` ya cruzaba contra la descripción;
la grilla no tiene descripción, así que necesita su propia defensa.

#### El umbral de detalle

`DETAIL_SCORE_THRESHOLD` es **0**, no 0.25. Ese valor estaba calibrado contra una
escala que ya no existe: al sacar el precio los scores se desplomaron y en una
corrida real el máximo fue 0.096. Un umbral que nadie alcanza no filtra, deja el
pipeline mudo. Quien limita el gasto es `DETAIL_MAX_PER_RUN`, que era quien lo
hacía de verdad igual; el umbral sólo saca lo que tiene una bandera concreta en
contra —sospecha de automotora, o un km no creíble—, que dan negativo.

### Cola de contacto

**No hay envío automático y no hay monto sugerido.**

Lo primero es por la cuenta: la mensajería automatizada por Messenger es lo que
más rápido dispara el baneo. La cola queda en `pending` para aprobación y envío
manual, y una vez que una persona la aprueba o descarta el worker no la vuelve a
tocar.

Lo segundo es por el número: la oferta se anclaba a una mediana de mercado que
resultó no existir, así que el monto tenía menos fundamento del que aparentaba —
y un número que aparenta fundamento invita a usarlo sin pensar. La cola trae los
**hechos** y el precio lo ponés vos:

```
1734174691163250 | Citroën picasso 2.0 2008
  pide   USD 6500   (mediana del lote 7500, n=17)
  km     210.000  (11.667/año)
  deuda  ninguna declarada
  publicado hace 19 días
  https://www.facebook.com/marketplace/item/1734174691163250/
  "Hola, buenas. Me interesa 2008 CITROEN PICASSO 2.0. ¿Sigue disponible?
   ¿Se puede ver estos días? Pago al contado y lo retiro yo."
```

La `mediana del lote` es contexto, no score: dice cómo se compara ese aviso
contra el resto de la página de Facebook, no contra valor de mercado. Las
automotoras se excluyen de ese cálculo porque publican a precio de agencia.

El borrador abre la conversación sin comprometer un número. Si el aviso declara
una deuda, el monto aparece en los hechos —no se descuenta de nada, porque no
hay nada de dónde descontarlo— y si la moneda no está clara queda en
`debtNeedsReview` para que la mires.

### Worker programado

`npm run worker:schedule` corre el sync cada `WORKER_INTERVAL_HOURS` (6 por
defecto) con jitter de ±20%, sólo dentro de `WORKER_ACTIVE_HOURS` (`9-22`, hora
de Montevideo) porque "no correr 24/7" es parte de las reglas de politeness.
Nunca solapa dos corridas, resetea el presupuesto de listings por corrida (es un
rate limit, no un tope de por vida) y cierra Chromium entre corridas. Una
corrida que falla se loguea y no baja el scheduler.

### Rate limiting

Delay aleatorio de 8–20s antes de cada navegación (`SCRAPER_MIN_DELAY_MS` /
`SCRAPER_MAX_DELAY_MS`), tope de concurrencia, y presupuesto duro de 100
listings por proceso (`SCRAPER_SESSION_BUDGET`). **Todo camino que navegue pasa
por `withPoliteSlot`, incluido `GET /api/marketplace`**: ese endpoint tenía su
propio Chromium y su propio límite de concurrencia sin delay ni presupuesto, así
que un loop contra él le pegaba a Facebook tan rápido como pudiera navegar
mientras el worker esperaba 8–20s por request. Hay un solo Chromium por proceso. La sesión se re-persiste tras
cada corrida en `FB_STORAGE_STATE_OUT`, para no perder una rotación de Facebook.

### Datos personales

Se guarda el mínimo del vendedor: `seller_id` y conteo de publicaciones activas.
El payload de detalle expone `seller_phone_number` y el nombre del vendedor —
**no se leen ni se persisten** (Ley 18.331).
