import {
  pgTable,
  text,
  integer,
  timestamp,
  customType,
  index,
} from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.replace(/^\[|\]$/g, "").split(",").map(Number);
  },
});

/**
 * Cache of per-query intelligence:
 *   - `embedding` from OpenAI text-embedding-3-small (1536d) so we can compute
 *     cosine similarity between the query and the page's existing embedding to
 *     decide whether the query is on-intent for that page.
 *   - `searchVolume` from DataForSEO Keywords Data (Google Ads) so we can
 *     distinguish "no clicks because no demand" from "no clicks despite real
 *     demand".
 *
 * Keyed by `query` (the raw GSC query text, lower-cased and trimmed at the
 * write site) so every URL ranking for the same query reuses the same cache
 * entry. Refreshed on a rolling basis — see `services/queryIntel.ts`.
 */
export const queryIntelTable = pgTable(
  "query_intel",
  {
    query: text("query").primaryKey(),
    embedding: vector("embedding"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    searchVolume: integer("search_volume"),
    volumeFetchedAt: timestamp("volume_fetched_at", { withTimezone: true }),
    volumeSource: text("volume_source"), // e.g. "dataforseo"
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    embeddedAtIdx: index("query_intel_embedded_at_idx").on(t.embeddedAt),
    volumeFetchedAtIdx: index("query_intel_volume_fetched_at_idx").on(
      t.volumeFetchedAt,
    ),
  }),
);

export type QueryIntel = typeof queryIntelTable.$inferSelect;
