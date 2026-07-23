-- job_runs becomes per-site (Task: accounts & multi-site, review follow-up).
-- Idempotent: safe to re-run. Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0002_job_runs_per_site.sql
--
-- Adds site_id (NOT NULL DEFAULT 1, FK -> sites.id) to job_runs and converts
-- the PK to a composite (name, site_id) while KEEPING the original constraint
-- name so `drizzle-kit push` sees no diff. Existing rows backfill to the
-- legacy site (id=1) via the column default.

BEGIN;

ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS site_id integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'job_runs_site_id_sites_id_fk'
  ) THEN
    ALTER TABLE job_runs
      ADD CONSTRAINT job_runs_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES sites(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conname = 'job_runs_pkey' AND a.attname = 'site_id'
  ) THEN
    ALTER TABLE job_runs DROP CONSTRAINT job_runs_pkey;
    ALTER TABLE job_runs ADD CONSTRAINT job_runs_pkey PRIMARY KEY (name, site_id);
  END IF;
END $$;

COMMIT;
