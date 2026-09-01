# Prompt para Claude Code — refactor de `fb_mp_scrapper` a pipeline de oportunidades

> Pegá todo esto como primer mensaje en Claude Code, con el repo abierto.

---

## Contexto

Este repo tiene un extractor de Facebook Marketplace hecho con Playwright, expuesto como API. Hoy devuelve resultados de la grilla de búsqueda con este shape:

```json
{
  "count": 24,
  "items": [
    {
      "id": "1487450843409462",
      "title": "Auto Lifan 320 1.3 Gris",
      "price": 125000,
      "priceRaw": "125 000 $U",
      "currency": "UYU",
      "oldPrice": 140000,
      "oldPriceRaw": "140 000 $U",
      "location": "Colonia Nicolich, Canelones, Uruguay",
      "thumbnail": "https://...",
      "url": "https://www.facebook.com/marketplace/item/1487450843409462/"
    }
  ]
}
```

**Objetivo final:** convertir esto en un pipeline que detecte oportunidades de compra-reventa de autos usados en Uruguay. La idea de negocio es comprar vehículos alrededor de USD 7.000–8.000, usarlos un tiempo y revenderlos. El sistema tiene que encontrar publicaciones que sean buen negocio y priorizarlas.

**Problemas conocidos, ya diagnosticados:**

1. La búsqueda es por texto libre. Buscando "auto" devuelve autos a batería, sillas de bebé, Hot Wheels y camas infantiles. De 24 resultados, 1 era un auto real.
2. No entra a la publicación individual, así que no hay descripción, kilometraje, vendedor ni fecha de publicación.
3. No hay persistencia. Cada consulta es efímera, y sin historial no se puede calcular antigüedad de publicación ni detectar revendedores.

**Restricción de trabajo:** avanzá de a una fase, pará al final de cada una y esperá mi confirmación antes de seguir. No hagas refactors grandes sin avisarme primero.

---

## Fase 0 — Diagnóstico (sin cambios de código)

Leé el repo y reportame:

1. Cómo construye la URL de búsqueda y qué parámetros acepta.
2. Si extrae datos por selectores CSS del DOM o parseando el JSON embebido en tags `<script>`.
3. Cómo maneja la sesión de Facebook (cookies persistidas, storage state, login manual).
4. Si ya existe alguna función que abra la publicación individual, aunque esté rota o sin usar.
5. Qué rate limiting o delays tiene, si tiene alguno.
6. Cómo está expuesta la API (framework, endpoints, tipos).

Terminá con un resumen de qué es reutilizable tal cual, qué hay que arreglar y qué conviene tirar. **No modifiques nada todavía.**

---

## Fase 1 — Búsqueda por categoría en lugar de texto libre

Reemplazar la búsqueda por keyword por la categoría de vehículos de Marketplace, que soporta filtros nativos del lado del servidor (marca, modelo, año mín/máx, kilometraje máx, rango de precio, radio de ubicación).

- Nueva función de búsqueda que reciba esos filtros de forma tipada y arme la URL de categoría.
- Filtrado del lado de Facebook, no post-procesado nuestro.
- Mantené la función vieja de búsqueda por texto si la usa otra cosa, pero que no sea el camino por defecto.

**Criterio de aceptación:** una corrida con filtros de autos usados en Montevideo/Canelones devuelve ≥90% de vehículos reales, sin juguetes ni accesorios.

**Pará acá y mostrame el output de una corrida real antes de seguir.**

---

## Fase 2 — Persistencia

El extractor deja de ser "la API" y pasa a ser una librería que consume un worker programado. La API pasa a leer de la base, no de Facebook en vivo.

Postgres (Supabase). Schema mínimo:

- `listings` — `id` (el id de FB como PK), `title`, `price`, `currency`, `location`, `url`, `thumbnail`, `first_seen_at`, `last_seen_at`, `is_active`, y los campos de detalle en null por ahora.
- `price_history` — `listing_id`, `price`, `currency`, `observed_at`. Insertar una fila cada vez que el precio cambie respecto a la última observación.
- `sellers` — `seller_id`, `first_seen_at`, `listing_count` (derivado).
- `raw_snapshots` — payload crudo por corrida, para poder reparsear sin volver a scrapear cuando cambiemos la lógica.

**Importante sobre moneda:** en Uruguay las publicaciones vienen en UYU y en USD indistintamente. Guardá `price` y `currency` siempre separados y no normalices al guardar. La conversión se hace solo al comparar. Si mezclás monedas en la base, cualquier cálculo de mediana queda inservible.

Worker programado que corre cada N horas, hace upsert de lo encontrado y marca `is_active = false` lo que dejó de aparecer.

**Pará acá.**

---

## Fase 3 — Precio de referencia de mercado

Para saber si un precio es bueno hace falta un comparable. Usar la **API pública de MercadoLibre**, no scraping:

```
https://api.mercadolibre.com/sites/MLU/search?category=MLU1744&q=...
```

- Buscar comparables por marca + modelo + rango de año (±2 años respecto al del listing).
- Descartar outliers (quedarse entre percentil 10 y 90) — hay muchas publicaciones fantasma con precios irreales.
- Calcular mediana y guardarla cacheada por combinación marca/modelo/año, con TTL de algunos días. No pegarle a la API por cada listing.
- Devolver también el `n` de comparables. Con menos de 5, marcar la referencia como poco confiable y no dejar que domine el score.

**Pará acá.**

---

## Fase 4 — Scorer v1 (solo con datos de grilla)

Módulo de scoring con **subscores separados y trazables**, no un número único opaco. Cada listing tiene que poder explicar por qué puntuó lo que puntuó.

Con lo que ya tenemos sin abrir la publicación:

- `price_score` — `(mediana_mercado - precio) / mediana_mercado`. El de mayor peso.
- `price_drop_score` — si `oldPrice` no es null, el vendedor ya bajó el precio. Señal fuerte de vendedor motivado, y sale gratis. Escalar según la magnitud de la baja.
- `staleness_score` — días entre `first_seen_at` y hoy. Más días publicado = más probable que acepte oferta.
- `price_change_count` — cuántas bajadas acumuló en `price_history`. Dos bajadas es mejor señal que una.

Persistir el score y el desglose. Endpoint que devuelva el ranking ordenado.

**Pará acá y validá el ranking contra publicaciones reales conmigo antes de la fase 5.**

---

## Fase 5 — Fetch de detalle selectivo + Scorer v2

Recién ahora abrir publicaciones individuales, y **solo las que pasaron el umbral de la fase 4** (esperable: ~5 de cada 100). Esto mantiene el volumen de requests bajo.

Extraer de la página de detalle:

- Descripción completa. Ojo: Marketplace colapsa el texto detrás de "Ver más". Si se lee del DOM sin expandir, se pierde el final del texto, que es justo donde suele estar lo importante. **Preferí parsear el JSON embebido en los `<script>`**, que trae el texto completo aunque visualmente esté colapsado, y además es más estable que los selectores CSS (Facebook rota los nombres de clase).
- Kilometraje: primero el atributo estructurado del vehículo si existe; si no, regex sobre la descripción (`140.000 km`, `140mil kms`, `140 mil kilómetros`).
- Año del vehículo.
- `seller_id`. Verificá que sea estable entre scrapes del mismo listing en días distintos — si es un identificador efímero, la detección de revendedores no va a funcionar.
- Fecha de publicación (viene relativa, tipo "hace 3 semanas": normalizala contra el timestamp del scrape).

Subscores nuevos:

- `km_score` — usar **km/año, no km absolutos**. En Uruguay ~13-15k km/año es lo normal. Penalizar también el km sospechosamente bajo para el año (tablero corregido).
- `flag_score` — regex sobre título + descripción, con pesos distintos por término:
  - Penalización fuerte: `deuda`, `debe`, `prenda`, `prendado`, `gravamen`, `embargo`, `saldo`, `financiad`, `cuotas`
  - Penalización fuerte: `chocado`, `para repuestos`, `no anda`, `motor fundido`, `sin empadronar`, `a nombre de`
  - Penalización leve: `permuto`, `escucho ofertas`
  - Bonus: `único dueño`, `papeles al día`, `libre de deuda`
- `seller_score` — contar listings activos distintos por `seller_id`. Con 3 o más autos activos es revendedor o automotora, y ahí no hay margen. Penalización fuerte.

---

## Fase 6 — Cola de contacto (NO envío automático)

Generar para cada oportunidad que pase el umbral:

- Monto de oferta sugerido. **Anclado a la mediana de mercado, no a un porcentaje fijo del precio publicado.** Si el auto ya está 15% por debajo de mercado, ofrecer -11% del publicado es insultante y se pierde la oportunidad.
- Borrador de mensaje personalizado, que use el contexto disponible (antigüedad de la publicación, bajadas de precio previas).

**No implementes envío automático de mensajes por Messenger.** La mensajería automatizada es lo que más rápido dispara el baneo de cuenta, y un mensaje genérico convierte mal. La cola queda para aprobación y envío manual.

---

## Consideraciones transversales

- **Rate limiting:** delays aleatorios de 8-20s entre requests, tope de ~100 listings por sesión, no correr 24/7. Asumir que las cuentas se pierden y hacer que la sesión sea fácil de rotar.
- **Resiliencia:** preferir siempre el JSON embebido antes que selectores CSS. Todo parser tiene que fallar de forma explícita y loggeada, nunca devolver null silencioso.
- **Datos personales:** guardar el mínimo necesario del vendedor (id y conteo de publicaciones). No persistir nombres, teléfonos ni fotos de perfil — Ley 18.331 de protección de datos personales.
- **Tests:** para el scorer, tests unitarios con fixtures cargadas a mano. El scorer tiene que poder testearse sin tocar Facebook.
