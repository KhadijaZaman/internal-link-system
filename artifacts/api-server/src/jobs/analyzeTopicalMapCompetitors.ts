/**
 * analyze_topical_map_competitors
 *
 * Fetches live Google SERP data for every topic in a topical map and
 * stores the top-5 competitor domains per node. Uses the DataForSEO async
 * task pipeline (task_post → poll task_get) so it is cheap (~$0.0006/query)
 * and respects the site's per-site SERP budget caps.
 *
 * Correctness guarantees:
 *  - Un-scanned nodes (competitors IS NULL) are prioritised within the budget
 *    cap so repeat runs always make forward progress.
 *  - Task-to-query association uses fetch.keyword from the DataForSEO result
 *    as the authoritative mapping — never index-based correlation. This is safe
 *    even when DataForSEO partially rejects tasks in a batch.
 *  - Only nodes whose canonical query returned successful SERP results are
 *    updated. Nodes for budget-trimmed, timed-out, or poll-failed queries are
 *    left as-is so any previously stored competitor data is preserved.
 *  - A per-map heartbeat (updating competitor_scan_started_at every 2 minutes)
 *    lets the route detect truly stale scans vs. active long-running ones.
 *  - Status:
 *      complete — all unique canonical queries were processed.
 *      partial  — budget cap, task-level failures, or timeouts prevented full
 *                 coverage; re-run to make more progress once budget allows.
 *      failed   — fatal error (e.g. DataForSEO 402 out-of-funds).
 *
 * Flow triggered by POST /topical-map/runs/:mapId/analyze-competitors:
 *  1. Route sets competitor_scan_status = 'queued'.
 *  2. Job atomically claims the map (queued → running via FOR UPDATE SKIP LOCKED).
 *  3. SERP tasks are posted, polled, and top competitors stored per node.
 *  4. On completion: status → 'complete' or 'partial'.
 *  5. On failure (inc. DataForSEO 402): status → 'failed' + error message.
 *  6. After completing one map the job loops back to claim any additional queued
 *     maps for the same site.
 */

import { db, topicalMapsTable, topicalMapNodesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { postSerpTasks, fetchSerpTaskResult } from "../integrations/dataforseo";
import { withDbRetry } from "../lib/dbRetry";
import { budgetForSite } from "../lib/jobBudget";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";

const SERP_INITIAL_WAIT_MS = 30_000;
const SERP_SWEEP_INTERVAL_MS = 25_000;
const SERP_TIMEOUT_MS = 12 * 60_000;
const SERP_URLS_KEPT = 10;
const MAX_COMPETITORS_PER_NODE = 5;
/** US location code (matches the keyword-clustering default). */
const LOCATION_CODE = 2840;

/**
 * How often to update competitor_scan_started_at as a heartbeat during a scan.
 * The route's stale threshold is HEARTBEAT_MS * 3 so normal active scans are
 * never falsely marked stale.
 */
export const COMPETITOR_SCAN_HEARTBEAT_MS = 2 * 60_000; // 2 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StoredCompetitor {
  domain: string;
  url: string;
  bestPosition: number | null;
  matchedQuery: string;
}

async function updateScanStatus(
  mapId: number,
  fields: {
    competitorScanStatus?: string;
    competitorScanError?: string | null;
  },
): Promise<void> {
  await withDbRetry(
    () =>
      db
        .update(topicalMapsTable)
        .set(fields)
        .where(eq(topicalMapsTable.id, mapId)),
    { label: `competitor_scan_status:${mapId}` },
  );
}

/** Touch competitor_scan_started_at to prove the scan is still alive. */
async function heartbeatScan(mapId: number): Promise<void> {
  try {
    await db
      .update(topicalMapsTable)
      .set({ competitorScanStartedAt: new Date() })
      .where(
        and(
          eq(topicalMapsTable.id, mapId),
          eq(topicalMapsTable.competitorScanStatus, "running"),
        ),
      );
  } catch {
    // Non-fatal — the scan continues even if a heartbeat write fails.
  }
}

/**
 * Atomically claims one queued map for this site (queued → running).
 * Uses PostgreSQL's `FOR UPDATE SKIP LOCKED` so concurrent job invocations
 * can never double-claim the same row.
 *
 * Returns the claimed map row, or null if no queued maps exist.
 */
async function claimNextQueuedMap(
  siteId: number,
): Promise<typeof topicalMapsTable.$inferSelect | null> {
  const result = await db.execute<typeof topicalMapsTable.$inferSelect>(sql`
    UPDATE topical_maps
    SET
      competitor_scan_status     = 'running',
      competitor_scan_started_at = NOW()
    WHERE id = (
      SELECT id FROM topical_maps
      WHERE site_id = ${siteId}
        AND competitor_scan_status = 'queued'
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  return result.rows[0] ?? null;
}

export async function scanOneMap(
  map: typeof topicalMapsTable.$inferSelect,
  site: SiteContext,
): Promise<void> {
  // Start a heartbeat interval so the route can distinguish active scans from
  // stale ones left by a crashed process.
  const heartbeatTimer = setInterval(() => {
    void heartbeatScan(map.id);
  }, COMPETITOR_SCAN_HEARTBEAT_MS);

  try {
    const budget = budgetForSite(site);

    // Load every node: id, canonical query, and existing competitors so we can
    // prioritise un-scanned nodes within the budget cap.
    const nodes = await db
      .select({
        id: topicalMapNodesTable.id,
        canonicalQuery: topicalMapNodesTable.canonicalQuery,
        competitors: topicalMapNodesTable.competitors,
      })
      .from(topicalMapNodesTable)
      .where(
        and(
          eq(topicalMapNodesTable.siteId, site.id),
          eq(topicalMapNodesTable.mapId, map.id),
        ),
      );

    if (nodes.length === 0) {
      await updateScanStatus(map.id, {
        competitorScanStatus: "complete",
        competitorScanError: null,
      });
      return;
    }

    // Deduplicate canonical queries (multiple nodes can share the same query).
    // Map: normalised query → nodeIds. Also track whether the query is un-scanned.
    const queryToNodeIds = new Map<string, number[]>();
    const queryIsUnscanned = new Map<string, boolean>();
    for (const node of nodes) {
      const q = node.canonicalQuery.trim().toLowerCase();
      if (!q) continue;
      const ids = queryToNodeIds.get(q) ?? [];
      ids.push(node.id);
      queryToNodeIds.set(q, ids);
      // Un-scanned if ANY node for this query has no stored competitor data.
      if (!queryIsUnscanned.has(q) || node.competitors == null) {
        queryIsUnscanned.set(q, node.competitors == null);
      }
    }

    // Sort: un-scanned queries first → repeat runs make forward progress.
    const unscannedQueries = [...queryToNodeIds.keys()].filter((q) => queryIsUnscanned.get(q));
    const alreadyScannedQueries = [...queryToNodeIds.keys()].filter(
      (q) => !queryIsUnscanned.get(q),
    );
    const allQueries = [...unscannedQueries, ...alreadyScannedQueries];
    const totalUnscannedCount = unscannedQueries.length;

    // Apply serpQueries budget cap before spending anything.
    let queriesToFetch = allQueries;
    let budgetTrimmedCount = 0;
    const remaining = budget.remaining("serpQueries");
    if (allQueries.length > remaining) {
      if (remaining === 0) {
        throw new Error(
          "SERP quota cap reached — the per-site SERP budget is exhausted for this run. Increase the spend limit or wait for the next billing period.",
        );
      }
      budgetTrimmedCount = allQueries.length - remaining;
      logger.warn(
        {
          mapId: map.id,
          requested: allQueries.length,
          allowed: remaining,
          trimmed: budgetTrimmedCount,
        },
        "Competitor scan: SERP budget cap — trimming query set",
      );
      queriesToFetch = allQueries.slice(0, remaining);
    }
    // Consume from the budget (best-effort; the cap check above already guarded it).
    budget.take("serpQueries", queriesToFetch.length);

    // How many un-scanned queries remain after the budget trim?
    const unscannedSkippedCount = Math.max(
      0,
      totalUnscannedCount - queriesToFetch.filter((q) => queryIsUnscanned.get(q)).length,
    );

    logger.info(
      {
        mapId: map.id,
        siteId: site.id,
        queries: queriesToFetch.length,
        total: allQueries.length,
        unscanned: totalUnscannedCount,
      },
      "Competitor scan: posting SERP tasks",
    );

    // ---- 1. Post SERP tasks ----
    // May throw with "DataForSEO account is out of funds (HTTP 402)" message.
    // postSerpTasks returns IDs only for tasks DataForSEO accepted; partial
    // acceptance (taskIds.length < queriesToFetch.length) means some queries
    // were rejected at post time — those nodes will remain unpopulated this run.
    const taskIds = await postSerpTasks(queriesToFetch, LOCATION_CODE);
    if (taskIds.length === 0) {
      throw new Error("DataForSEO accepted none of the SERP tasks.");
    }
    const postRejectedCount = queriesToFetch.length - taskIds.length;

    // ---- 2. Poll for results ----
    // Task-to-query association uses fetch.keyword as the authoritative source
    // from DataForSEO. This is safe even when DataForSEO partially rejects tasks
    // in a batch (which would make index-based mapping incorrect).
    await sleep(SERP_INITIAL_WAIT_MS);
    const results = new Map<string, Array<{ url: string; position: number }>>();
    const pending = new Set(taskIds);
    const deadline = Date.now() + SERP_TIMEOUT_MS;
    let pollErrorCount = 0;
    let serpFailedCount = 0;

    while (pending.size > 0 && Date.now() < deadline) {
      for (const taskId of [...pending]) {
        let fetch;
        try {
          fetch = await fetchSerpTaskResult(taskId);
        } catch {
          pending.delete(taskId);
          pollErrorCount++;
          continue;
        }
        if (fetch.status === "pending") continue;
        pending.delete(taskId);
        if (fetch.status === "failed") {
          serpFailedCount++;
        } else if (fetch.status === "ok") {
          // Use fetch.keyword as the authoritative canonical query mapping.
          const q = fetch.keyword.toLowerCase().trim();
          if (queryToNodeIds.has(q)) {
            results.set(q, fetch.urls.slice(0, SERP_URLS_KEPT));
          }
        }
      }
      if (pending.size > 0) await sleep(SERP_SWEEP_INTERVAL_MS);
    }
    const timedOutCount = pending.size; // tasks still pending after deadline

    logger.info(
      {
        mapId: map.id,
        fetched: results.size,
        timedOut: timedOutCount,
        pollErrors: pollErrorCount,
        serpFailed: serpFailedCount,
      },
      "Competitor scan: SERP results collected",
    );

    // ---- 3. Store competitors per node ----
    // IMPORTANT: only update nodes for queries that returned results. Nodes for
    // budget-trimmed, timed-out, or poll-failed queries are left as-is so any
    // previously stored competitor data is preserved.
    const ownHost = site.host.replace(/^www\./, "");
    const isOwn = (host: string) => {
      const h = host.replace(/^www\./, "");
      return h === ownHost || h.endsWith(`.${ownHost}`);
    };

    for (const [query, serpUrls] of results) {
      const nodeIds = queryToNodeIds.get(query);
      if (!nodeIds) continue;

      const byDomain = new Map<string, StoredCompetitor>();

      for (const s of serpUrls) {
        let parsed: URL;
        try {
          parsed = new URL(s.url);
        } catch {
          continue;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
        if (!parsed.host || isOwn(parsed.host)) continue;

        const domain = parsed.host.replace(/^www\./, "");
        const prev = byDomain.get(domain);
        if (
          !prev ||
          (s.position != null && (prev.bestPosition == null || s.position < prev.bestPosition))
        ) {
          byDomain.set(domain, {
            domain,
            url: s.url,
            bestPosition: s.position,
            matchedQuery: query,
          });
        }
      }

      const competitors: StoredCompetitor[] = [...byDomain.values()]
        .sort((a, b) => (a.bestPosition ?? 999) - (b.bestPosition ?? 999))
        .slice(0, MAX_COMPETITORS_PER_NODE);

      // Write to every node that shares this canonical query.
      for (const nodeId of nodeIds) {
        await withDbRetry(
          () =>
            db
              .update(topicalMapNodesTable)
              .set({ competitors: competitors.length > 0 ? competitors : null })
              .where(
                and(
                  eq(topicalMapNodesTable.siteId, site.id),
                  eq(topicalMapNodesTable.id, nodeId),
                ),
              ),
          { label: `competitor_scan_node:${nodeId}` },
        );
      }
    }

    // ---- 4. Determine final status ----
    // If any queries were skipped (budget, timeouts, DataForSEO failures), mark
    // 'partial' so the user knows they can re-run for more coverage.
    const partialReasons: string[] = [];

    if (unscannedSkippedCount > 0) {
      partialReasons.push(
        `${unscannedSkippedCount} un-scanned topic${unscannedSkippedCount === 1 ? "" : "s"} skipped — SERP budget cap reached. Increase the spend limit or re-run to scan the next batch.`,
      );
    } else if (budgetTrimmedCount > 0) {
      // Budget trimmed but only already-scanned topics were skipped — soft warning.
      partialReasons.push(
        `${budgetTrimmedCount} already-scanned topic${budgetTrimmedCount === 1 ? "" : "s"} not re-fetched — SERP budget cap reached.`,
      );
    }

    if (timedOutCount > 0) {
      partialReasons.push(
        `${timedOutCount} SERP task${timedOutCount === 1 ? "" : "s"} timed out. Re-run to retry those topics.`,
      );
    }
    if (postRejectedCount > 0) {
      partialReasons.push(
        `${postRejectedCount} SERP task${postRejectedCount === 1 ? "" : "s"} were rejected by DataForSEO at submission time. Re-run to retry those topics.`,
      );
    }
    if (serpFailedCount > 0) {
      partialReasons.push(
        `${serpFailedCount} SERP task${serpFailedCount === 1 ? "" : "s"} returned a DataForSEO error. Re-run to retry.`,
      );
    }
    if (pollErrorCount > 0) {
      partialReasons.push(
        `${pollErrorCount} SERP task${pollErrorCount === 1 ? "" : "s"} could not be retrieved during polling and were skipped.`,
      );
    }

    // 'partial' when any queries were not fully resolved this run (budget trim,
    // post rejections, DataForSEO task failures, poll errors, or timeouts).
    // 'complete' only when everything was submitted and settled without gaps.
    const isPartial =
      unscannedSkippedCount > 0 ||
      timedOutCount > 0 ||
      serpFailedCount > 0 ||
      pollErrorCount > 0 ||
      postRejectedCount > 0;
    const finalStatus = isPartial ? "partial" : "complete";
    const partialNote =
      partialReasons.length > 0
        ? `Scanned ${results.size} of ${queriesToFetch.length} submitted queries. ${partialReasons.join(" ")}`
        : null;

    await updateScanStatus(map.id, {
      competitorScanStatus: finalStatus,
      competitorScanError: partialNote,
    });

    logger.info(
      {
        mapId: map.id,
        siteId: site.id,
        status: finalStatus,
        stored: results.size,
        requested: queriesToFetch.length,
        timedOut: timedOutCount,
        pollErrors: pollErrorCount,
        serpFailed: serpFailedCount,
        budgetTrimmed: budgetTrimmedCount,
        unscannedSkipped: unscannedSkippedCount,
      },
      "Competitor scan settled",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: e, mapId: map.id, siteId: site.id }, "Competitor scan failed");
    await updateScanStatus(map.id, {
      competitorScanStatus: "failed",
      competitorScanError: msg,
    }).catch(() => {});
    throw e;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function runAnalyzeTopicalMapCompetitors(site: SiteContext): Promise<void> {
  // Process all queued maps for this site, one at a time.
  // Uses atomic claim (FOR UPDATE SKIP LOCKED) so concurrent job invocations
  // can never double-claim the same row, and so each map is correctly processed
  // even when multiple scans were queued while a job was already running.
  let map = await claimNextQueuedMap(site.id);
  while (map) {
    logger.info({ mapId: map.id, siteId: site.id }, "Competitor scan: claimed map");
    try {
      await scanOneMap(map, site);
    } catch {
      // scanOneMap already recorded 'failed' status. Continue to the next map.
    }
    // After finishing (success or failure), check if more maps are queued.
    map = await claimNextQueuedMap(site.id);
  }
}
