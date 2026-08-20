import {
  db,
  topicalMapsTable,
  topicalMapNodesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";
import { ensureQueryMarketVolumes } from "../services/queryIntel";
import { QUERY_VOLUME_TTL_DAYS } from "../services/queryIntel";

export const TOPICAL_MAP_TRAFFIC_CTR = 0.2;

export function estimateUsTrafficPotential(
  usSearchVolume: number | null,
  volumeWasFetched = false,
): number | null {
  return usSearchVolume === null
    ? volumeWasFetched
      ? 0
      : null
    : Math.round(usSearchVolume * TOPICAL_MAP_TRAFFIC_CTR);
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

async function updateDemandStatus(
  mapId: number,
  siteId: number,
  values: Partial<typeof topicalMapsTable.$inferInsert>,
): Promise<void> {
  await db
    .update(topicalMapsTable)
    .set(values)
    .where(
      and(eq(topicalMapsTable.id, mapId), eq(topicalMapsTable.siteId, siteId)),
    );
}

export async function enrichOneTopicalMapDemand(
  mapId: number,
  siteId: number,
): Promise<void> {
  await updateDemandStatus(mapId, siteId, {
    demandStatus: "running",
    demandError: null,
    demandStartedAt: new Date(),
  });
  const heartbeatTimer = setInterval(() => {
    void db
      .update(topicalMapsTable)
      .set({ demandStartedAt: new Date() })
      .where(
        and(
          eq(topicalMapsTable.id, mapId),
          eq(topicalMapsTable.siteId, siteId),
          eq(topicalMapsTable.demandStatus, "running"),
        ),
      )
      .catch(() => {});
  }, 60_000);

  try {
    if (!process.env["DATAFORSEO_LOGIN"] || !process.env["DATAFORSEO_PASSWORD"]) {
      throw new Error("DataForSEO credentials are not configured.");
    }

    const gapNodes = await db
      .select({ canonicalQuery: topicalMapNodesTable.canonicalQuery })
      .from(topicalMapNodesTable)
      .where(
        and(
          eq(topicalMapNodesTable.siteId, siteId),
          eq(topicalMapNodesTable.mapId, mapId),
          eq(topicalMapNodesTable.status, "gap"),
        ),
      );
    const uniqueQueries = Array.from(
      new Set(
        gapNodes
          .map((node) => normalizeQuery(node.canonicalQuery))
          .filter(Boolean),
      ),
    );

    if (uniqueQueries.length === 0) {
      await updateDemandStatus(mapId, siteId, {
        demandStatus: "complete",
        demandError: null,
        demandFetchedAt: new Date(),
      });
      return;
    }

    const intel = await ensureQueryMarketVolumes(uniqueQueries, siteId);
    const freshAfter = Date.now() - QUERY_VOLUME_TTL_DAYS * 86_400_000;
    const completeCount = uniqueQueries.filter((query) => {
      const row = intel.get(query);
      return Boolean(
        row?.volumeFetchedAt &&
          row.volumeFetchedAt.getTime() >= freshAfter &&
          row.globalVolumeFetchedAt &&
          row.globalVolumeFetchedAt.getTime() >= freshAfter,
      );
    }).length;
    const incompleteCount = uniqueQueries.length - completeCount;
    const status = incompleteCount === 0 ? "complete" : "partial";
    const error =
      incompleteCount === 0
        ? null
        : `${incompleteCount} of ${uniqueQueries.length} new topics are still waiting for complete US and global volume data. Refresh demand to retry them.`;

    await updateDemandStatus(mapId, siteId, {
      demandStatus: status,
      demandError: error,
      demandFetchedAt: new Date(),
    });
    logger.info(
      { mapId, siteId, queries: uniqueQueries.length, completeCount, incompleteCount },
      "Topical map demand enrichment complete",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateDemandStatus(mapId, siteId, {
      demandStatus: "failed",
      demandError: message,
    });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function claimNextQueuedMap(
  siteId: number,
): Promise<typeof topicalMapsTable.$inferSelect | null> {
  const result = await db.execute<typeof topicalMapsTable.$inferSelect>(sql`
    UPDATE topical_maps
    SET demand_status = 'running', demand_started_at = NOW(), demand_error = NULL
    WHERE id = (
      SELECT id FROM topical_maps
      WHERE site_id = ${siteId}
        AND demand_status = 'queued'
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  return result.rows[0] ?? null;
}

export async function runEnrichTopicalMapDemand(
  site: SiteContext,
): Promise<void> {
  for (;;) {
    const map = await claimNextQueuedMap(site.id);
    if (!map) return;
    try {
      await enrichOneTopicalMapDemand(map.id, site.id);
    } catch (error) {
      logger.warn(
        { err: error, mapId: map.id, siteId: site.id },
        "Topical map demand enrichment failed",
      );
    }
  }
}