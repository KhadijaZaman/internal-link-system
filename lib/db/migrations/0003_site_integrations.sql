-- Per-site data-source credentials (Task: let new users add and connect their own website).
-- Idempotent: safe to re-run. Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0003_site_integrations.sql
--
-- Creates site_integrations: one row per (site, provider in gsc/ga4/bing).
-- `credentials` holds secret material and is never returned by any API
-- response; `config` holds non-secret settings (e.g. selected GSC property).

BEGIN;

CREATE TABLE IF NOT EXISTS site_integrations (
  id serial PRIMARY KEY,
  site_id integer NOT NULL,
  provider text NOT NULL,
  credentials jsonb NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'site_integrations_site_id_sites_id_fk'
  ) THEN
    ALTER TABLE site_integrations
      ADD CONSTRAINT site_integrations_site_id_sites_id_fk
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS site_integrations_site_provider_uniq
  ON site_integrations (site_id, provider);

COMMIT;
