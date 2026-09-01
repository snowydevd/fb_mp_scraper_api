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
| `GET`   | `/health`                | Estado y qué está configurado (base, sesión FB, MELI)  |
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
| `SCRAPER_MIN_DELAY_MS`      | 8000    | Piso del delay aleatorio por navegación |
| `SCRAPER_MAX_DELAY_MS`      | 20000   | Techo del delay aleatorio            |
| `SCRAPER_SESSION_BUDGET`    | 100     | Listings máximos por corrida         |
| `DATABASE_URL`              | —       | Postgres; sin esto la API sólo scrapea |
| `WORKER_INTERVAL_HOURS`     | 6       | Cada cuánto corre el worker programado |
| `WORKER_JITTER_PCT`         | 0.2     | Jitter aplicado al intervalo         |
| `WORKER_ACTIVE_HOURS`       | 9-22    | Ventana horaria en que puede correr  |
| `MELI_CACHE_TTL_HOURS`      | 72      | TTL del cache de precios de referencia |
| `UYU_PER_USD`               | —       | Tipo de cambio para netear deuda en la otra moneda; sin esto no se convierte |

## Servidor MCP

El directorio `mcp-server/` contiene un servidor MCP (stdio) sobre el SDK
oficial `@modelcontextprotocol/sdk` que expone tres tools:

- **`list_opportunities`** — el ranking de oportunidades ya puntuadas, mejor
  primero. Lee la base, **no scrapea**, así que llamarla es gratis. Cada fila
  trae el `breakdown` completo del score. Las automotoras se excluyen por
  defecto; `includeDealers: true` existe para auditar el filtro.
- **`list_contact_queue`** — los borradores de oferta y mensaje pendientes de
  revisión. Es de **solo lectura a propósito**: aprobar o descartar un borrador
  es una decisión humana, y se hace por `PATCH /api/contact-queue/:id`.
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
npm test                  # 90 tests unitarios, sin tocar Facebook ni Postgres
npm run test:integration  # 23 tests contra un Postgres real (ver abajo)
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

### La deuda sale del precio, no de la lista

Una deuda que el vendedor pone por escrito **no es motivo para descartar la
publicación**: es plata que vamos a pagar nosotros, así que sale de la oferta.
Son dos ejes distintos y los dos se usan — `flags.mjs` la penaliza en el
**ranking**, donde mide riesgo; `debt.mjs` la descuenta del **precio**, que es
donde el problema se resuelve.

```
Citroën Picasso, pide USD 6.500, mediana 7.495
  sin deuda                        -> oferta 6.150
  "Debe 200 dólares de patente"    -> oferta 5.950   (-200)
  "prenda, saldo 2000 usd"         -> oferta 4.150   (-2000, marcado: la deuda domina)
  "Debo 8000 usd de prenda"        -> sin borrador: la deuda se come la oferta
```

Y el borrador lo dice de frente, que es la posición más fuerte que hay — el
número deja de parecer arbitrario y queda claro que se leyó la publicación:

> "Vi que la publicación menciona una deuda de USD 200, así que la oferta ya la
> contempla."

**Dos reglas mandan sobre todo lo demás:**

**Sin moneda segura, no se descuenta.** Esta plata entra en una oferta que una
persona va a mandar. Restarle 15.000 pesos a un precio en dólares convierte una
oferta de USD 6.150 en una de USD -8.850. Cuando la moneda no está declarada
(un `$` pelado es ambiguo acá) o está en la otra moneda sin tipo de cambio
configurado, el monto **no se toca** y viaja en `debt.needsReview` para que lo
mire un humano. El worker lo loguea como error, no como info.

Si querés que convierta, configurá `UYU_PER_USD`. Sin eso no se convierte nada:
inventar un tipo de cambio para poder restar sería peor que no restar.

**Un número no es un monto por estar cerca de la palabra "deuda".** "deuda de
patente 2024 y 2025" son los AÑOS que se adeudan, no 2024 dólares. Un número de
cuatro cifras en rango de año y sin símbolo de moneda se descarta — pero
"deuda de u$s 2000" y "deuda de 2.024 pesos" sí son plata.

El redondeo al netear va siempre para abajo: redondear 5.975 a 6.000 devolvería
parte de la deuda que se acaba de descontar.

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

- **v1** (grilla): `price`, `priceDrop`, `staleness`, `priceChanges`, `km`, `seller`
- **v2** (+ detalle): los mismos, más `flags`, y con los datos estructurados del
  detalle en vez de las pistas de la grilla

v1 no es sólo un ranking: es lo que decide **a quién se le abre la publicación**,
y abrir una cuesta una navegación con rate limit. Rankeando sólo por precio, las
5 navegaciones de una corrida se fueron enteras a avisos que después se
descartaban —el precio de una automotora se ve excelente justamente porque es la
entrega de un plan—. Por eso v1 gasta parte de su peso en las dos señales que
predicen una navegación desperdiciada: el vendedor y el km/año.

Las pistas de la grilla (`mileageHint` del subtítulo, `vehicleYearHint` del
título) son peores que los campos estructurados del detalle, pero son las que
están disponibles antes de gastar la navegación.

El veredicto de automotora en v1 es **gradual**, no binario: un título que dice
"… NOAHCARS" da 0.5 contra un umbral de 0.6. No alcanza para afirmar que es una
automotora, pero está lejos de ser nada, así que baja el score sin descalificar.
La decisión firme se toma en v2, con la descripción a la vista.

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

El resultado de MercadoLibre se cachea por combinación marca/modelo/banda de
años en `reference_prices`, con TTL de `MELI_CACHE_TTL_HOURS`: una corrida hace
una llamada por banda y no una por listing. La referencia `internal` **no** se
cachea — es una propiedad del batch de esa corrida, no del mercado. Si
MercadoLibre falla, se deja de intentar por el resto de la corrida en vez de
gastar un token request por listing.

### Supabase: RLS y string de conexión

**Activá RLS.** Supabase publica por PostgREST (`/rest/v1/`) toda tabla del
schema `public`, y la anon key es pública por diseño. Las tablas creadas por SQL
—como estas— arrancan con RLS **apagado**; sólo las creadas desde la UI vienen
con RLS puesto. Sin RLS, cualquiera con la anon key lee y escribe `listings`,
`sellers` y `contact_queue`.

`schema.sql` ya lo hace: `ENABLE ROW LEVEL SECURITY` en las 7 tablas y **cero
políticas**. Sin una policy que lo permita, PostgREST no le devuelve nada a
`anon` ni a `authenticated`. El pipeline no se entera, porque no pasa por
PostgREST: `repo.mjs` abre una conexión Postgres directa con `DATABASE_URL`, y
ese rol es el **dueño** de las tablas — un dueño saltea RLS.

Por eso mismo **no** se usa `FORCE ROW LEVEL SECURITY`: sujetaría también al
dueño a unas políticas que no existen, y el worker perdería su propia escritura.
Si alguna vez te conectás con un rol que no sea el dueño, hay que escribirle
políticas explícitas.

Hay dos tests de integración que lo cubren: uno verifica que las 7 tablas tengan
`relrowsecurity` y ninguna `relforcerowsecurity`, y otro crea un rol que no es
dueño y comprueba que RLS lo bloquea incluso con `GRANT SELECT` encima.

Sobre el string de conexión: para `npm run migrate` usá el **directo**
(puerto 5432), no el pooler en modo transacción (6543). El pooler está pensado
para queries cortas y el schema se aplica como un solo bloque multi-sentencia.
Para el worker sirven los dos.

### Cola de contacto

La oferta se ancla a la **mediana de mercado**, nunca a un porcentaje fijo del
precio publicado, y nunca supera lo que el vendedor pide. Cada entrada trae su
expectativa de aceptación (`alta` / `media` / `baja`) según la distancia al
precio publicado.

Cuando el auto ya está por debajo de lo que la mediana dice que deberíamos
pagar, el ancla queda por encima del precio publicado y la oferta colapsaba
sobre él: un borrador que decía "te pago 5990" por un auto de 5990. Eso no es
una oferta. En ese caso la oferta cae a un descuento por pago contado
(`minCashDiscountPct`, 3%) y el mensaje lo dice de frente — el precio es
razonable, lo que se ofrece es rapidez y certeza, no un lowball.

**No hay envío automático.** La cola queda en estado `pending` para aprobación y
envío manual, y una vez que una persona la aprueba o descarta, el worker no la
vuelve a tocar.

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
