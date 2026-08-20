import { and, eq, inArray, sql } from "drizzle-orm";
import { db, queryIntelTable, type QueryIntel } from "@workspace/db";
import { embedBatch } from "../integrations/openaiEmbed";
import {
  fetchSearchVolumes,
  isDataForSeoOutOfFunds,
  type SearchVolumeMarket,
} from "../integrations/dataforseo";
import { logger } from "../lib/logger";
import { randomUUID } from "node:crypto";

/**
 * Cap on how many *new* embeddings or volume lookups we do per request,
 * so a single pruning recompute can't blow through quota in one shot.
 * Re-runs progressively fill the cache over time.
 */
const MAX_NEW_EMBEDDINGS_PER_RUN = 200;
const MAX_NEW_VOLUMES_PER_RUN = 500;

/** Volume cache TTL: refresh once a month. */
export const QUERY_VOLUME_TTL_DAYS = 30;
const VOLUME_CLAIM_TTL_MS = 10 * 60_000;

function normaliseQuery(q: string): string {
  return q.trim().toLowerCase();
}

async function ensureRows(
  rawQueries: string[],
  siteId: number,
): Promise<{ queries: string[]; byQuery: Map<string, QueryIntel> }> {
  const queries = Array.from(
    new Set(rawQueries.map(normaliseQuery).filter((q) => q.length > 0)),
  );
  if (queries.length === 0) return { queries, byQuery: new Map() };

  await db
    .insert(queryIntelTable)
    .values(queries.map((query) => ({ query, siteId })))
    .onConflictDoNothing();

  const existing = await db
    .select()
    .from(queryIntelTable)
    .where(and(inArray(queryIntelTable.query, queries), eq(queryIntelTable.siteId, siteId)));

  return {
    queries,
    byQuery: new Map(existing.map((row) => [row.query, row])),
  };
}

export async function refreshMarketVolumes(
  queries: string[],
  siteId: number,
  market: SearchVolumeMarket,
  byQuery: Map<string, QueryIntel>,
  throwOnFailure = false,
): Promise<void> {
  if (queries.length === 0) return;

  const ttlCutoff = new Date(Date.now() - QUERY_VOLUME_TTL_DAYS * 86_400_000);
  const claimCutoff = new Date(Date.now() - VOLUME_CLAIM_TTL_MS);
  const claimToken = randomUUID();
  const queryValues = sql.join(queries.map((query) => sql`${query}`), sql`, `);
  const claimResult =
    market === "us"
      ? await db.execute<{ query: string }>(sql`
          WITH claimable AS (
            SELECT query
            FROM query_intel
            WHERE site_id = ${siteId}
              AND query IN (${queryValues})
              AND (volume_fetched_at IS NULL OR volume_fetched_at < ${ttlCutoff})
              AND (volume_claimed_at IS NULL OR volume_claimed_at < ${claimCutoff})
            ORDER BY query
            LIMIT ${MAX_NEW_VOLUMES_PER_RUN}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE query_intel AS qi
          SET volume_claimed_at = NOW(), volume_claim_token = ${claimToken}
          FROM claimable
          WHERE qi.site_id = ${siteId}
            AND qi.query = claimable.query
          RETURNING qi.query
        `)
      : await db.execute<{ query: string }>(sql`
          WITH claimable AS (
            SELECT query
            FROM query_intel
            WHERE site_id = ${siteId}
              AND query IN (${queryValues})
              AND (global_volume_fetched_at IS NULL OR global_volume_fetched_at < ${ttlCutoff})
              AND (global_volume_claimed_at IS NULL OR global_volume_claimed_at < ${claimCutoff})
            ORDER BY query
            LIMIT ${MAX_NEW_VOLUMES_PER_RUN}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE query_intel AS qi
          SET global_volume_claimed_at = NOW(), global_volume_claim_token = ${claimToken}
          FROM claimable
          WHERE qi.site_id = ${siteId}
            AND qi.query = claimable.query
          RETURNING qi.query
        `);
  const needVolume = claimResult.rows;

  if (needVolume.length === 0) return;

  let preserveClaimUntilExpiry = false;
  try {
    const volumes = await fetchSearchVolumes(
      needVolume.map((row) => row.query),
      market,
    );
    const now = new Date();
    for (const volume of volumes) {
      const norm = normaliseQuery(volume.query);
      const values =
        market === "us"
          ? {
              searchVolume: volume.searchVolume,
              volumeFetchedAt: now,
              volumeSource: "dataforseo",
            }
          : {
              globalSearchVolume: volume.searchVolume,
              globalVolumeFetchedAt: now,
              globalVolumeSource: "dataforseo",
            };

      const updated = await db
        .update(queryIntelTable)
        .set(values)
        .where(
          and(
            eq(queryIntelTable.query, norm),
            eq(queryIntelTable.siteId, siteId),
            eq(
              market === "us"
                ? queryIntelTable.volumeClaimToken
                : queryIntelTable.globalVolumeClaimToken,
              claimToken,
            ),
          ),
        )
        .returning({ query: queryIntelTable.query });
      if (updated.length > 0) {
        const previous = byQuery.get(norm);
        if (previous) byQuery.set(norm, { ...previous, ...values });
      }
    }

    logger.info(
      {
        market,
        answered: volumes.length,
        requested: needVolume.length,
        skipped: needVolume.length - volumes.length,
      },
      "queryIntel: market volumes refreshed (skipped = API didn't answer, will retry)",
    );
  } catch (error) {
    // A timeout, transport/parse failure, or local cache-write failure can
    // happen after the provider accepted and charged the request. Retain the
    // claim so a normal retry cannot immediately buy the same lookup again.
    // A provider-confirmed out-of-funds response is known not to have run.
    preserveClaimUntilExpiry = !isDataForSeoOutOfFunds(error);
    logger.warn({ err: error, market }, "queryIntel: market volume batch failed");
    if (throwOnFailure) throw error;
  } finally {
    if (!preserveClaimUntilExpiry) {
      const claimedQueries = needVolume.map((row) => row.query);
      try {
        await db
          .update(queryIntelTable)
          .set(
            market === "us"
              ? { volumeClaimedAt: null, volumeClaimToken: null }
              : { globalVolumeClaimedAt: null, globalVolumeClaimToken: null },
          )
          .where(
            and(
              eq(queryIntelTable.siteId, siteId),
              inArray(queryIntelTable.query, claimedQueries),
              eq(
                market === "us"
                  ? queryIntelTable.volumeClaimToken
                  : queryIntelTable.globalVolumeClaimToken,
                claimToken,
              ),
            ),
          );
      } catch (error) {
        // Leave the durable claim in place until its TTL expires. That is safer
        // than risking a second paid lookup after a transient release failure.
        logger.warn(
          { err: error, market, siteId, claimed: claimedQueries.length },
          "queryIntel: failed to release market-volume claims",
        );
      }
    }
  }
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
  siteId: number,
): Promise<Map<string, QueryIntel>> {
  const { queries, byQuery } = await ensureRows(rawQueries, siteId);
  if (queries.length === 0) return byQuery;

  // Embeddings — only for rows still missing one, capped per run.
  const needEmbedding = [...byQuery.values()]
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
          .where(
            and(eq(queryIntelTable.query, q as string), eq(queryIntelTable.siteId, siteId)),
          );
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

  await refreshMarketVolumes(queries, siteId, "us", byQuery);

  return byQuery;
}

/**
 * Refresh both US and worldwide volume caches without creating embeddings.
 * Used by topical-map demand enrichment after page coverage is known.
 */
export async function ensureQueryMarketVolumes(
  rawQueries: string[],
  siteId: number,
): Promise<Map<string, QueryIntel>> {
  const { queries, byQuery } = await ensureRows(rawQueries, siteId);
  if (queries.length === 0) return byQuery;

  // Keep calls sequential: the paid Google Ads live endpoint is account-rate
  // limited, and this also makes US/worldwide failures independently retryable.
  const errors: unknown[] = [];
  for (const market of ["us", "global"] as const) {
    try {
      await refreshMarketVolumes(queries, siteId, market, byQuery, true);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 2) {
    const first = errors[0];
    throw first instanceof Error
      ? first
      : new Error("Both US and worldwide search-volume lookups failed.");
  }
  return byQuery;
}
