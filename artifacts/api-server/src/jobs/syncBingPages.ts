import {
  db,
  pagesTable,
  bingPageStatsTable,
  bingQueryStatsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { fetchBingPageStats, fetchBingQueryStats } from "../integrations/bing";
import {
  aggregateByCanonical,
  canonicalPath,
  loadBlockRegexes,
} from "../lib/urlCanon";
import { withDbRetry } from "../lib/dbRetry";
import { logger } from "../lib/logger";

/**
 * Syncs the Bing Webmaster API's rolling ~6-month window of page and query
 * stats, then rolls page totals onto the canonical pages registry.
 *
 * The API has NO date-range params — every call returns the full window — so
 * each sync is a transactional delete-all + reinsert. Both fetches happen
 * BEFORE the transaction: if Bing is down, the previous data survives.
 *
 * URL hygiene: every page URL goes through canonicalPath + blocklist; rows
 * that collapse onto one canonical (path, bucketDate) are merged (summed
 * clicks/impressions, impression-weighted position). Rollups are UPDATE-only
 * — Bing pages never grow the registry.
 */
export async function runSyncBingPages(): Promise<void> {
  const [pageRows, queryRows, blockRegexes] = await Promise.all([
    fetchBingPageStats(),
    fetchBingQueryStats(),
    loadBlockRegexes(),
  ]);
  const now = new Date();

  // Collapse page rows per (bucketDate, canonicalPath).
  type Stat = { clicks: number; impressions: number; position: number | null };
  const pageInserts: Array<{
    bucketDate: string;
    path: string;
    clicks: number;
    impressions: number;
    position: number | null;
  }> = [];
  const byDate = new Map<string, typeof pageRows>();
  for (const r of pageRows) {
    const g = byDate.get(r.bucketDate);
    if (g) g.push(r);
    else byDate.set(r.bucketDate, [r]);
  }
  let droppedPageRows = 0;
  for (const [bucketDate, rows] of byDate) {
    const metricRows = rows.map((r) => ({
      raw: r,
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position ?? 0,
    }));
    const grouped = aggregateByCanonical(
      metricRows,
      (row) => canonicalPath(row.raw.key),
      blockRegexes,
    );
    let kept = 0;
    for (const [path, { rows: g, merged }] of grouped) {
      kept += g.length;
      // Impression-weighted position across ONLY the rows that reported one —
      // Bing returns -1/unknown as null, and counting those as 0 would dilute
      // the average toward a falsely "better" rank.
      let posSum = 0;
      let posWeight = 0;
      for (const r of g) {
        if (r.raw.position === null) continue;
        const w = Math.max(r.impressions, 1);
        posSum += r.raw.position * w;
        posWeight += w;
      }
      pageInserts.push({
        bucketDate,
        path,
        clicks: merged.clicks,
        impressions: merged.impressions,
        position: posWeight > 0 ? posSum / posWeight : null,
      });
    }
    droppedPageRows += rows.length - kept;
  }

  // Collapse query rows per (bucketDate, lowercased query).
  const queryKey = (q: string) => q.trim().toLowerCase();
  const queryGroups = new Map<string, { bucketDate: string; query: string; rows: Stat[] }>();
  for (const r of queryRows) {
    const key = `${r.bucketDate}\u0000${queryKey(r.key)}`;
    let g = queryGroups.get(key);
    if (!g) {
      g = { bucketDate: r.bucketDate, query: queryKey(r.key), rows: [] };
      queryGroups.set(key, g);
    }
    g.rows.push({
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position,
    });
  }
  const queryInserts = [...queryGroups.values()].map((g) => {
    let clicks = 0;
    let impressions = 0;
    let posSum = 0;
    let posWeight = 0;
    for (const r of g.rows) {
      clicks += r.clicks;
      impressions += r.impressions;
      if (r.position === null) continue;
      const w = Math.max(r.impressions, 1);
      posSum += r.position * w;
      posWeight += w;
    }
    return {
      bucketDate: g.bucketDate,
      query: g.query,
      clicks,
      impressions,
      position: posWeight > 0 ? posSum / posWeight : null,
    };
  });

  // Page rollups: whole-window totals per canonical path.
  const rollups = new Map<string, { clicks: number; impressions: number; posSum: number; posWeight: number }>();
  for (const ins of pageInserts) {
    let r = rollups.get(ins.path);
    if (!r) {
      r = { clicks: 0, impressions: 0, posSum: 0, posWeight: 0 };
      rollups.set(ins.path, r);
    }
    r.clicks += ins.clicks;
    r.impressions += ins.impressions;
    if (ins.position !== null) {
      const w = Math.max(ins.impressions, 1);
      r.posSum += ins.position * w;
      r.posWeight += w;
    }
  }

  let updated = 0;
  let unmatched = 0;
  await withDbRetry(
    () =>
      db.transaction(async (tx) => {
        updated = 0;
        unmatched = 0;
        await tx.delete(bingPageStatsTable);
        await tx.delete(bingQueryStatsTable);
        const CHUNK = 500;
        for (let i = 0; i < pageInserts.length; i += CHUNK) {
          await tx.insert(bingPageStatsTable).values(pageInserts.slice(i, i + CHUNK));
        }
        for (let i = 0; i < queryInserts.length; i += CHUNK) {
          await tx.insert(bingQueryStatsTable).values(queryInserts.slice(i, i + CHUNK));
        }
        // Reset + apply rollups (UPDATE-only; readers never see zeros).
        await tx
          .update(pagesTable)
          .set({ bingClicks: 0, bingImpressions: 0, bingPosition: null, bingSyncedAt: now });
        for (const [path, r] of rollups) {
          const result = await tx
            .update(pagesTable)
            .set({
              bingClicks: r.clicks,
              bingImpressions: r.impressions,
              bingPosition: r.posWeight > 0 ? r.posSum / r.posWeight : null,
              updatedAt: now,
            })
            .where(eq(pagesTable.path, path));
          if ((result.rowCount ?? 0) > 0) updated++;
          else unmatched++;
        }
      }),
    { label: "bing_sync:apply" },
  );

  logger.info(
    {
      apiPageRows: pageRows.length,
      apiQueryRows: queryRows.length,
      pageInserts: pageInserts.length,
      queryInserts: queryInserts.length,
      droppedPageRows,
      rollupPaths: rollups.size,
      updated,
      unmatched,
    },
    "sync_bing_pages complete",
  );
}

/**
 * Recompute the pages.ai_citations rollup from the newest "pages"-kind AI
 * citation upload. Called by the upload route after a successful insert.
 * UPDATE-only, transactional reset+apply — same shape as the Bing/GA4 sync.
 */
export async function applyAiCitationRollup(uploadId: number): Promise<{
  updated: number;
  unmatched: number;
}> {
  const now = new Date();
  let updated = 0;
  let unmatched = 0;
  await withDbRetry(
    () =>
      db.transaction(async (tx) => {
        updated = 0;
        unmatched = 0;
        await tx.update(pagesTable).set({ aiCitations: 0, aiCitationsAt: now });
        const rows = await tx.execute(sql`
          SELECT path, SUM(citations)::int AS citations
          FROM ai_citation_rows
          WHERE upload_id = ${uploadId} AND path IS NOT NULL
          GROUP BY path
        `);
        for (const row of rows.rows as Array<{ path: string; citations: number }>) {
          const result = await tx
            .update(pagesTable)
            .set({ aiCitations: row.citations, updatedAt: now })
            .where(eq(pagesTable.path, row.path));
          if ((result.rowCount ?? 0) > 0) updated++;
          else unmatched++;
        }
      }),
    { label: "ai_citations:rollup" },
  );
  return { updated, unmatched };
}
