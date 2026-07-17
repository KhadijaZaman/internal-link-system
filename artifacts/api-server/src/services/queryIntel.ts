import { inArray, isNull, or, lt, sql } from "drizzle-orm";
import { db, queryIntelTable, type QueryIntel } from "@workspace/db";
import { embedBatch } from "../integrations/openaiEmbed";
import { fetchSearchVolumes } from "../integrations/dataforseo";
import { logger } from "../lib/logger";

/**
 * Cap on how many *new* embeddings or volume lookups we do per request,
 * so a single pruning recompute can't blow through quota in one shot.
 * Re-runs progressively fill the cache over time.
 */
const MAX_NEW_EMBEDDINGS_PER_RUN = 200;
const MAX_NEW_VOLUMES_PER_RUN = 500;

/** Volume cache TTL: refresh once a month. */
const VOLUME_TTL_DAYS = 30;

function normaliseQuery(q: string): string {
  return q.trim().toLowerCase();
}

/**
 * Ensure the `query_intel` cache has up-to-date entries for the given queries:
 *   - missing embeddings → embed in batch (capped per run)
 *   - missing or stale search volumes → fetch from DataForSEO (capped per run)
 *
 * Returns a Map of normalised-query → cache row. Entries that hit cache caps
 * this run are still returned with whatever data is already cached.
 */
export async function ensureQueryIntel(
  rawQueries: string[],
): Promise<Map<string, QueryIntel>> {
  const queries = Array.from(
    new Set(rawQueries.map(normaliseQuery).filter((q) => q.length > 0)),
  );
  if (queries.length === 0) return new Map();

  // 1. Insert any rows we've never seen so we can update them below.
  await db
    .insert(queryIntelTable)
    .values(queries.map((q) => ({ query: q })))
    .onConflictDoNothing();

  // 2. Load current state.
  const existing = await db
    .select()
    .from(queryIntelTable)
    .where(inArray(queryIntelTable.query, queries));
  const byQuery = new Map(existing.map((r) => [r.query, r]));

  // 3. Embeddings — only for rows still missing one, capped per run.
  const needEmbedding = existing
    .filter((r) => r.embedding === null)
    .slice(0, MAX_NEW_EMBEDDINGS_PER_RUN);

  if (needEmbedding.length > 0) {
    try {
      const embedded = await embedBatch(
        needEmbedding.map((r) => ({ id: r.query, text: r.query })),
        4,
      );
      const now = new Date();
      for (const [q, vec] of embedded.entries()) {
        await db
          .update(queryIntelTable)
          .set({ embedding: vec, embeddedAt: now })
          .where(sql`${queryIntelTable.query} = ${q}`);
        const prev = byQuery.get(q as string);
        if (prev) {
          byQuery.set(q as string, { ...prev, embedding: vec, embeddedAt: now });
        }
      }
      logger.info(
        { embedded: embedded.size, requested: needEmbedding.length },
        "queryIntel: embeddings refreshed",
      );
    } catch (e) {
      logger.warn({ err: e }, "queryIntel: embedding batch failed");
    }
  }

  // 4. Search volumes — missing OR older than VOLUME_TTL_DAYS, capped per run.
  const ttlCutoff = new Date(Date.now() - VOLUME_TTL_DAYS * 86_400_000);
  const needVolume = await db
    .select({ query: queryIntelTable.query })
    .from(queryIntelTable)
    .where(
      sql`${inArray(queryIntelTable.query, queries)} AND (${or(
        isNull(queryIntelTable.volumeFetchedAt),
        lt(queryIntelTable.volumeFetchedAt, ttlCutoff),
      )})`,
    )
    .limit(MAX_NEW_VOLUMES_PER_RUN);

  if (needVolume.length > 0) {
    try {
      // fetchSearchVolumes returns ONLY queries the API actually answered
      // (volume may legitimately be null = "no measurable demand"). Skipped
      // queries are not in the result, so their volumeFetchedAt stays null
      // and they'll be retried on the next recompute instead of being
      // stamped as "done" for 30 days against a transient API outage.
      const volumes = await fetchSearchVolumes(needVolume.map((r) => r.query));
      const now = new Date();
      for (const v of volumes) {
        const norm = normaliseQuery(v.query);
        await db
          .update(queryIntelTable)
          .set({
            searchVolume: v.searchVolume,
            volumeFetchedAt: now,
            volumeSource: "dataforseo",
          })
          .where(sql`${queryIntelTable.query} = ${norm}`);
        const prev = byQuery.get(norm);
        if (prev) {
          byQuery.set(norm, {
            ...prev,
            searchVolume: v.searchVolume,
            volumeFetchedAt: now,
            volumeSource: "dataforseo",
          });
        }
      }
      logger.info(
        {
          answered: volumes.length,
          requested: needVolume.length,
          skipped: needVolume.length - volumes.length,
        },
        "queryIntel: volumes refreshed (skipped = API didn't answer, will retry)",
      );
    } catch (e) {
      logger.warn({ err: e }, "queryIntel: volume batch failed");
    }
  }

  return byQuery;
}
