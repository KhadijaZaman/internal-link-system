BEGIN;

ALTER TABLE action_items
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'technical',
  ADD COLUMN IF NOT EXISTS source_records JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS score_components JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS owner TEXT,
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS freshness TEXT NOT NULL DEFAULT 'fresh',
  ADD COLUMN IF NOT EXISTS source_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE action_items
SET category = CASE
  WHEN action_type IN ('add_inbound_links', 'add_outbound_links') THEN 'technical'
  WHEN action_type IN ('review_suggestions', 'fix_cannibalization') THEN 'linking'
  WHEN action_type IN ('fix_losing_query', 'improve_ctr') THEN 'visibility'
  WHEN action_type = 'optimize_content' THEN 'content'
  ELSE 'technical'
END
WHERE category = 'technical';

CREATE INDEX IF NOT EXISTS action_items_site_category_status_idx
  ON action_items (site_id, category, status);

COMMIT;