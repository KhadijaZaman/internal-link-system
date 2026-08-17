-- Add competitor scan tracking to topical_maps and per-node competitor storage.
-- Idempotent: safe to re-run.
--
-- topical_maps.competitor_scan_status: null | queued | running | complete | failed
-- topical_maps.competitor_scan_error:  last error message (includes out-of-funds notice)
-- topical_map_nodes.competitors:       JSONB array of {domain,url,bestPosition,matchedQuery}

BEGIN;

ALTER TABLE topical_maps
  ADD COLUMN IF NOT EXISTS competitor_scan_status     text,
  ADD COLUMN IF NOT EXISTS competitor_scan_error      text,
  ADD COLUMN IF NOT EXISTS competitor_scan_started_at timestamptz;

ALTER TABLE topical_map_nodes
  ADD COLUMN IF NOT EXISTS competitors jsonb;

COMMIT;
