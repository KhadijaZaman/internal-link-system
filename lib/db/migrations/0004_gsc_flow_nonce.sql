-- Add flow_nonce column to site_integrations for atomic GSC OAuth race protection.
-- Idempotent: safe to re-run. Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0004_gsc_flow_nonce.sql
--
-- The auth-url endpoint writes a one-time nonce here when the owner initiates
-- a GSC OAuth flow.  The callback's credential write is a conditional UPDATE
-- WHERE flow_nonce = $nonce, making the "flow still active" check and the
-- credential write atomic at the DB level.  A disconnect (DELETE) removes the
-- nonce along with the row, so any stale in-flight callback finds 0 matching
-- rows and is rejected without writing credentials.

BEGIN;

ALTER TABLE site_integrations ADD COLUMN IF NOT EXISTS flow_nonce text;

COMMIT;
