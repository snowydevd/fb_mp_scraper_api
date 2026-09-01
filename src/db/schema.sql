-- fb_mp_scraper_api - schema for the opportunity pipeline (Fase 2)
--
-- Currency rule: `price` and `currency` are ALWAYS stored separately and are
-- never normalised on write. Uruguayan vehicle listings mix UYU and USD, and
-- Facebook stamps USD-priced cars with the session's UYU symbol, so the label
-- it reports is kept apart from our reading of it:
--   currency_reported -> exactly what Facebook's formatted_amount said
--   currency_resolved -> our resolution, with a confidence
-- Conversion happens only at comparison time, never here.

CREATE TABLE IF NOT EXISTS listings (
  id                  TEXT PRIMARY KEY,              -- Facebook listing id
  title               TEXT,
  price               NUMERIC(14,2),
  price_label         TEXT,                          -- "7500 $U", as rendered
  currency_reported   TEXT,                          -- what Facebook claims
  currency_resolved   TEXT,                          -- what we believe it is
  currency_confidence TEXT,                          -- high | low | none
  old_price           NUMERIC(14,2),                 -- strikethrough, if any
  city                TEXT,
  state               TEXT,
  url                 TEXT NOT NULL,
  thumbnail           TEXT,                          -- signed CDN url, expires
  category_id         TEXT,
  seller_id           TEXT,
  listed_at           TIMESTAMPTZ,                   -- Facebook's creation_time
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  is_sold             BOOLEAN,

  -- Detail fields, populated selectively in Fase 5
  description         TEXT,
  mileage_km          INTEGER,
  mileage_source      TEXT,                          -- attribute | description | grid_subtitle
  vehicle_year        INTEGER,
  make                TEXT,
  model               TEXT,
  trim                TEXT,
  title_status        TEXT,
  is_paid_off         BOOLEAN,
  number_of_owners    INTEGER,
  transmission        TEXT,
  fuel_type           TEXT,
  seller_type         TEXT,                          -- Facebook's vehicle_seller_type
  is_dealer           BOOLEAN,                       -- our combined verdict
  dealer_score        NUMERIC(6,3),
  dealer_reasons      JSONB,                         -- why the verdict went that way
  detail_fetched_at   TIMESTAMPTZ
);

-- Columns added after the first deployment. CREATE TABLE IF NOT EXISTS above is
-- a no-op on an existing database, so every later column needs its own ALTER.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS trim             TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS title_status     TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_paid_off      BOOLEAN;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS number_of_owners INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS transmission     TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS fuel_type        TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_type      TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_dealer        BOOLEAN;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS dealer_score     NUMERIC(6,3);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS dealer_reasons   JSONB;

CREATE INDEX IF NOT EXISTS listings_active_idx    ON listings (is_active, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS listings_seller_idx    ON listings (seller_id) WHERE seller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS listings_listed_at_idx ON listings (listed_at DESC);
CREATE INDEX IF NOT EXISTS listings_model_idx     ON listings (make, model, vehicle_year);

-- One row per observed price CHANGE, not per observation.
CREATE TABLE IF NOT EXISTS price_history (
  id          BIGSERIAL PRIMARY KEY,
  listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  price       NUMERIC(14,2) NOT NULL,
  currency    TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_history_listing_idx ON price_history (listing_id, observed_at DESC);

-- Minimum viable seller record. Ley 18.331: no names, phones or profile photos.
CREATE TABLE IF NOT EXISTS sellers (
  seller_id     TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw payload per run, so parsing logic can change without re-scraping.
CREATE TABLE IF NOT EXISTS raw_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  run_id      UUID NOT NULL,
  source_url  TEXT NOT NULL,
  filters     JSONB,
  payload     JSONB NOT NULL,
  item_count  INTEGER,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS raw_snapshots_run_idx ON raw_snapshots (run_id, captured_at DESC);

-- Market reference prices, cached per make/model/year band (Fase 3).
CREATE TABLE IF NOT EXISTS reference_prices (
  id             BIGSERIAL PRIMARY KEY,
  make           TEXT NOT NULL,
  model          TEXT NOT NULL,
  year_from      INTEGER NOT NULL,
  year_to        INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  median_price   NUMERIC(14,2) NOT NULL,
  p10_price      NUMERIC(14,2),
  p90_price      NUMERIC(14,2),
  sample_size    INTEGER NOT NULL,
  source         TEXT NOT NULL,                      -- meli | internal
  is_reliable    BOOLEAN NOT NULL,                   -- false when sample_size < 5
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (make, model, year_from, year_to, currency, source)
);

-- Scores, kept with their full breakdown so any ranking can be explained.
CREATE TABLE IF NOT EXISTS listing_scores (
  listing_id   TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  score        NUMERIC(6,4) NOT NULL,
  version      TEXT NOT NULL,                        -- v1 | v2
  breakdown    JSONB NOT NULL,                       -- every subscore + weight
  reference_id BIGINT REFERENCES reference_prices(id),
  scored_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listing_scores_rank_idx ON listing_scores (score DESC);

-- Fase 6: contact queue. Drafts only - nothing here is ever sent automatically.
CREATE TABLE IF NOT EXISTS contact_queue (
  id             BIGSERIAL PRIMARY KEY,
  listing_id     TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  suggested_offer NUMERIC(14,2) NOT NULL,
  currency       TEXT NOT NULL,
  rationale      JSONB NOT NULL,
  message_draft  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | discarded | sent
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id)
);
ALTER TABLE contact_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS contact_queue_status_idx ON contact_queue (status, created_at DESC);

-- A human decides what gets sent; the worker must never overwrite that
-- decision on its next run. Only rows still untouched at 'pending' may be
-- refreshed, and this constraint keeps the vocabulary honest.
ALTER TABLE contact_queue DROP CONSTRAINT IF EXISTS contact_queue_status_check;
ALTER TABLE contact_queue ADD CONSTRAINT contact_queue_status_check
  CHECK (status IN ('pending', 'approved', 'discarded', 'sent'));

-- Row Level Security ---------------------------------------------------------
--
-- Supabase publica por PostgREST toda tabla del schema `public`, y la anon key
-- es pública por diseño: sin RLS, cualquiera con esa key lee y escribe estas
-- tablas, incluida contact_queue. Las tablas creadas por SQL (como estas)
-- arrancan con RLS apagado — sólo las creadas desde la UI vienen con RLS puesto.
--
-- Se activa SIN políticas a propósito: sin una policy que lo permita, PostgREST
-- no devuelve nada a `anon` ni a `authenticated`. El pipeline no se ve afectado
-- porque no pasa por PostgREST: repo.mjs abre una conexión Postgres directa con
-- DATABASE_URL, y ese rol es el DUEÑO de estas tablas. Un dueño saltea RLS.
--
-- Por eso mismo NO se usa FORCE ROW LEVEL SECURITY: haría que el dueño también
-- quede sujeto a las políticas, y el worker dejaría de poder escribir.
--
-- Si algún día se conecta con un rol que no sea el dueño, hay que escribirle
-- políticas explícitas o darle BYPASSRLS.
ALTER TABLE listings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sellers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_scores   ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_queue    ENABLE ROW LEVEL SECURITY;
