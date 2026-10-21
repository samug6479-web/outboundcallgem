-- Migrazione: tabella scheduled_campaigns
-- Campagne pianificate in attesa dell'orario di partenza. Il backend la crea
-- da solo al primo utilizzo; questo file serve per crearla a mano.
--
--   psql "$DATABASE_URL" -f scripts/migrations/003_scheduled_campaigns.sql

CREATE TABLE IF NOT EXISTS scheduled_campaigns (
  id            SERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT        NOT NULL,
  operatore     TEXT,
  user_email    TEXT,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending', -- pending | sending | sent | partial | failed | cancelled | expired
  tipo_campagna TEXT        NOT NULL,
  voicebot_id   TEXT,
  chunk_size    INT         NOT NULL DEFAULT 1,
  note          TEXT,
  contacts      JSONB       NOT NULL,
  sent_count    INT,
  failed_count  INT,
  dispatched_at TIMESTAMPTZ,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_campaigns_due ON scheduled_campaigns (status, scheduled_at);
