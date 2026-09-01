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
  detail_fetched_at   TIMESTAMPTZ
);

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
  UNIQUE (listing_id)
);
