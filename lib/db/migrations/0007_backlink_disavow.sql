-- Persisted per-site disavow decisions (accumulated across audit runs).
-- Applied in practice via `pnpm --filter db push` (see scripts/post-merge.sh);
-- kept here for documentation parity with the schema.
CREATE TABLE IF NOT EXISTS "backlink_disavow" (
  "id" serial PRIMARY KEY,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  "domain" text NOT NULL,
  "decision" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "backlink_disavow_site_domain_idx"
  ON "backlink_disavow" ("site_id", "domain");
