-- Migrazione: tabella auth_attempts
-- Conta i tentativi falliti di login/OTP e le richieste di supporto, per il
-- limite tentativi. Il backend la crea da solo al primo utilizzo; questo file
-- serve per crearla a mano (es. su un database nuovo).
--
--   psql "$DATABASE_URL" -f scripts/migrations/002_auth_attempts.sql

CREATE TABLE IF NOT EXISTS auth_attempts (
  id  SERIAL PRIMARY KEY,
  key TEXT        NOT NULL,
  ts  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_key_ts ON auth_attempts (key, ts DESC);
