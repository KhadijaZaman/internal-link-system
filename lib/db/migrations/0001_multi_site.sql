-- Multi-site foundation migration (Task: accounts & multi-site).
-- Idempotent: safe to re-run. Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v legacy_domain="$SITE_DOMAIN" -v legacy_host="<bare host>" \
--     -v legacy_sitemap="$SITEMAP_URL" -f lib/db/migrations/0001_multi_site.sql
--
-- Adds users + sites, inserts the legacy Wellows site as id=1 (unclaimed),
-- adds site_id (NOT NULL DEFAULT 1, FK -> sites.id) to every per-site table,
-- and converts PKs/uniques to composites that lead with site_id while KEEPING
-- the original constraint/index names so `drizzle-kit push` sees no diff.
-- app_state deliberately stays global (see task notes); job_runs becomes
-- per-site in 0002_job_runs_per_site.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- users + sites
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
  id serial PRIMARY KEY,
  owner_user_id text,
  domain text NOT NULL,
  host text NOT NULL,
  display_name text NOT NULL,
  sitemap_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sites_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sites_host_uniq ON sites (host);

INSERT INTO sites (id, domain, host, display_name, sitemap_url)
VALUES (1, :'legacy_domain', :'legacy_host', 'Wellows', NULLIF(:'legacy_sitemap', ''))
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('sites', 'id'),
              GREATEST((SELECT COALESCE(MAX(id), 1) FROM sites), 1));

-- Sanity: the legacy site MUST be id 1 (drizzle schema defaults depend on it).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = 1) THEN
    RAISE EXCEPTION 'legacy site id=1 missing after insert';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Helper-free site_id add + FK, per table
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'conversations', 'messages', 'inventory', 'link_graph', 'link_stats',
    'link_suggestions', 'gsc_snapshots', 'query_losers', 'optimize_queue',
    'crawl_progress', 'wp_posts', 'page_classifications', 'link_exclude_list',
    'audit_reports', 'linking_settings', 'link_lookups', 'query_intel',
    'watchlist_queries', 'page_target_keywords', 'kb_documents', 'kb_chunks',
    'tracked_submissions', 'cluster_runs', 'cluster_run_clusters',
    'action_items', 'health_snapshots', 'digests', 'url_blocklist', 'pages',
    'bing_page_stats', 'bing_query_stats', 'ai_citation_uploads',
    'ai_citation_rows', 'similarity_runs', 'topical_maps',
    'topical_map_nodes', 'topical_map_bridges'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS site_id integer NOT NULL DEFAULT 1',
      t
    );
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t || '_site_id_sites_id_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (site_id) REFERENCES sites(id)',
        t, t || '_site_id_sites_id_fk'
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Primary-key swaps (keep original constraint names)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('inventory',            'inventory_pkey',            'site_id, url'),
      ('link_stats',           'link_stats_pkey',           'site_id, url'),
      ('wp_posts',             'wp_posts_pkey',             'site_id, url'),
      ('page_classifications', 'page_classifications_pkey', 'site_id, url'),
      ('query_intel',          'query_intel_pkey',          'site_id, query'),
      ('pages',                'pages_pkey',                'site_id, path'),
      ('crawl_progress',       'crawl_progress_pkey',       'site_id, id'),
      ('linking_settings',     'linking_settings_pkey',     'site_id, id')
    ) AS v(tbl, conname, cols)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conname = r.conname AND a.attname = 'site_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY (%s)',
                     r.tbl, r.conname, r.cols);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Unique CONSTRAINT swaps (keep original names)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('link_exclude_list',    'link_exclude_list_pattern_unique',           'site_id, pattern'),
      ('url_blocklist',        'url_blocklist_pattern_unique',               'site_id, pattern'),
      ('watchlist_queries',    'watchlist_queries_query_unique',             'site_id, query'),
      ('page_target_keywords', 'page_target_keywords_url_keyword_unique',    'site_id, url, keyword')
    ) AS v(tbl, conname, cols)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conname = r.conname AND a.attname = 'site_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (%s)',
                     r.tbl, r.conname, r.cols);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Unique INDEX swaps (keep original names)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('link_graph',       'link_graph_uniq',           'site_id, source_url, target_url, anchor_text'),
      ('link_suggestions', 'link_suggestions_uniq',     'site_id, donor_url, receiver_url, anchor_text'),
      ('action_items',     'action_items_dedupe_uniq',  'site_id, dedupe_key'),
      ('health_snapshots', 'health_snapshots_date_uniq','site_id, snapshot_date'),
      ('digests',          'digests_week_uniq',         'site_id, week_of')
    ) AS v(tbl, idxname, cols)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE indexname = r.idxname AND indexdef NOT LIKE '%site_id%'
    ) THEN
      EXECUTE format('DROP INDEX %I', r.idxname);
    END IF;
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (%s)',
                   r.idxname, r.tbl, r.cols);
  END LOOP;
END $$;

COMMIT;
