BEGIN;

ALTER TABLE query_intel
  ADD COLUMN IF NOT EXISTS global_search_volume INTEGER,
  ADD COLUMN IF NOT EXISTS global_volume_fetched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS global_volume_source TEXT,
  ADD COLUMN IF NOT EXISTS volume_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS volume_claim_token TEXT,
  ADD COLUMN IF NOT EXISTS global_volume_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS global_volume_claim_token TEXT;

CREATE INDEX IF NOT EXISTS query_intel_global_volume_fetched_at_idx
  ON query_intel (global_volume_fetched_at);

ALTER TABLE topical_maps
  ADD COLUMN IF NOT EXISTS demand_status TEXT,
  ADD COLUMN IF NOT EXISTS demand_error TEXT,
  ADD COLUMN IF NOT EXISTS demand_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS demand_fetched_at TIMESTAMPTZ;

COMMIT;