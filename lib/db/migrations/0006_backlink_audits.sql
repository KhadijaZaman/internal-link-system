-- Persisted DataForSEO backlink-audit payloads (one row per site/target/kind).
-- Applied in practice via `pnpm --filter db push` (see scripts/post-merge.sh);
-- kept here for documentation parity with the schema.
CREATE TABLE IF NOT EXISTS "backlink_audits" (
  "id" serial PRIMARY KEY,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  "target" text NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "backlink_audits_site_target_kind_idx"
  ON "backlink_audits" ("site_id", "target", "kind");
