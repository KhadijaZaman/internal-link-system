-- Backlink metric history: one row per (site, calendar date).
-- Applied via `pnpm --filter db push` (see scripts/post-merge.sh).
CREATE TABLE IF NOT EXISTS "backlink_history" (
  "id" serial PRIMARY KEY,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  "date" text NOT NULL,
  "rank" integer,
  "backlinks" integer,
  "referring_domains" integer,
  "dofollow" integer,
  "recorded_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "backlink_history_site_date_idx"
  ON "backlink_history" ("site_id", "date");
