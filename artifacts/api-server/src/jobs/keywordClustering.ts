import {
  db,
  clusterRunsTable,
  clusterRunClustersTable,
  type ClusterRun,
  type ClusterKeywordEntry,
  type ClusterRunParams,
  type ClusterGscPageEntry,
} from "@workspace/db";
import { and, asc, eq, lt, isNull, or } from "drizzle-orm";
import {
  queryGscDimension,
  queryGscQueryPage,
  QUERY_DIMENSION_PAGINATED_CAP,
  type GscDimensionRow,
  type GscQueryPageRow,
} from "../integrations/gsc";
import {
  buildGscPageClusters,
  pickTopic,
  assignQuadrants,
  normalizeQuery,
  selectEligibleQueries,
  computeRunWindow,
  weeklyChunks,
  classifyKeyword,
  aggregateClusterPrior,
  canonicalizePageUrl,
  DEFAULT_WEEKS,
  GSC_PAGE_ALGORITHM_VERSION,
  type GscPeriodMetrics,
} from "../services/clustering";
import { generateClusterLabels } from "../integrations/openaiClusterLabels";
import { withDbRetry } from "../lib/dbRetry";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";

const STALE_MS = 3 * 60_000;
const INTERRUPTED_MESSAGE =
  "The server restarted while this clustering run was in progress. Start a new run to try again.";

/**
 * Message thrown when a rebuild is attempted on a legacy SERP run.
 * Never delete old rows for this case.
 */
const LEGACY_SERP_REBUILD_MESSAGE =
  "This run was created with SERP-based clustering (DataForSEO) and cannot be " +
  "rebuilt by the GSC-only clustering job. Start a new GSC-only run instead.";

/** Derive the effective weeks count from run params (backward compat). */
function resolveWeeks(p: ClusterRunParams): number {
  if (p.weeks !== undefined && p.weeks > 0) return p.weeks;
  // Legacy: convert days to nearest multiple of 7 (min 4 weeks, max 52 weeks)
  if (p.days !== undefined && p.days > 0) {
    const w = Math.round(p.days / 7);
    return Math.max(4, Math.min(52, w || DEFAULT_WEEKS));
  }
  return DEFAULT_WEEKS;
}

async function updateRun(
  runId: number,
  set: Partial<typeof clusterRunsTable.$inferInsert>,
): Promise<void> {
  await withDbRetry(
    () =>
      db
        .update(clusterRunsTable)
        .set({ ...set, heartbeatAt: new Date() })
        .where(eq(clusterRunsTable.id, runId)),
    { label: `cluster_run_update:${runId}` },
  );
}

/** Mark runs whose process died (stale heartbeat) as interrupted. */
async function reconcileStaleRuns(siteId: number): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS);
  await withDbRetry(
    () =>
      db
        .update(clusterRunsTable)
        .set({
          status: "interrupted",
          error: INTERRUPTED_MESSAGE,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(clusterRunsTable.siteId, siteId),
            eq(clusterRunsTable.status, "running"),
            or(
              lt(clusterRunsTable.heartbeatAt, cutoff),
              isNull(clusterRunsTable.heartbeatAt),
            ),
          ),
        ),
    { label: "cluster_runs_reconcile" },
  );
}

/**
 * Rows per GSC API call for the weekly query-only fetch.
 * GSC's max is 25 000; using the maximum minimises the number of round trips
 * on large sites.
 */
const GSC_QUERY_PAGE_SIZE = 25_000;
const GSC_QUERY_CHUNK_CAP = 500_000;

interface GscPeriodResult {
  metrics: Map<string, GscPeriodMetrics>;
  aliases: Map<string, Set<string>>;
}

/**
 * Fetch all weekly GSC query-only chunks for a given date range and aggregate.
 *
 * Uses paginated queryGscDimension (paginated=true, rowLimit=25 000) per
 * weekly chunk so large sites are never silently truncated. A 500k per-chunk
 * cap and 2m whole-period cap bound memory and quota for long windows.
 *
 * Each chunk's rows are streamed immediately into the aggregate map so no
 * large intermediate arrays are retained after each chunk completes.
 *
 * Fail-closed: if ANY single chunk request fails the entire operation throws,
 * guaranteeing we never classify partial data.
 *
 * Note on dataState: we do NOT pass dataState, so GSC uses its default
 * "final" mode. The 3-day lag on the end window already ensures all data
 * in both windows is finalized.
 */
async function fetchGscPeriodChunks(opts: {
  siteId: number;
  startDate: string;
  endDate: string;
  countryFilter?: string;
  collectAliases?: boolean;
}): Promise<GscPeriodResult> {
  const chunks = weeklyChunks(opts.startDate, opts.endDate);
  // Stream each chunk directly into the aggregator to avoid retaining all
  // raw weekly arrays in memory simultaneously.
  const acc = new Map<
    string,
    { clicks: number; impressions: number; posSum: number; posWeight: number }
  >();
  const aliases = new Map<string, Set<string>>();
  let totalRows = 0;

  for (const chunk of chunks) {
    const remainingRows = QUERY_DIMENSION_PAGINATED_CAP - totalRows;
    if (remainingRows <= 0) {
      throw new Error(
        `GSC weekly query fetch exceeded the whole-period safety cap of ` +
          `${QUERY_DIMENSION_PAGINATED_CAP} rows. Reduce the date range or add a country filter.`,
      );
    }
    let rows: GscDimensionRow[];
    try {
      rows = await queryGscDimension({
        siteId: opts.siteId,
        startDate: chunk.start,
        endDate: chunk.end,
        dimension: "query",
        rowLimit: GSC_QUERY_PAGE_SIZE,
        paginated: true,
        paginatedCap: Math.min(GSC_QUERY_CHUNK_CAP, remainingRows),
        ...(opts.countryFilter ? { countryFilter: opts.countryFilter } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `GSC comparison fetch failed for chunk ${chunk.start}–${chunk.end}: ${msg}`,
      );
    }
    totalRows += rows.length;
    if (totalRows > QUERY_DIMENSION_PAGINATED_CAP) {
      throw new Error(
        `GSC weekly query fetch exceeded the whole-period safety cap of ` +
          `${QUERY_DIMENSION_PAGINATED_CAP} rows. Reduce the date range or add a country filter.`,
      );
    }
    // Inline aggregate: same logic as aggregateGscChunks but without
    // collecting all chunk arrays into memory first.
    for (const r of rows) {
      const q = normalizeQuery(r.key);
      if (!q) continue;
      if (opts.collectAliases) {
        let rawAliases = aliases.get(q);
        if (!rawAliases) {
          rawAliases = new Set<string>();
          aliases.set(q, rawAliases);
        }
        rawAliases.add(r.key);
      }
      const existing = acc.get(q);
      if (existing) {
        existing.clicks += r.clicks;
        existing.impressions += r.impressions;
        existing.posSum += r.position * Math.max(r.impressions, 0);
        existing.posWeight += Math.max(r.impressions, 0);
      } else {
        acc.set(q, {
          clicks: r.clicks,
          impressions: r.impressions,
          posSum: r.position * Math.max(r.impressions, 0),
          posWeight: Math.max(r.impressions, 0),
        });
      }
    }
  }

  const result = new Map<string, GscPeriodMetrics>();
  for (const [q, v] of acc) {
    result.set(q, {
      clicks: Math.round(v.clicks),
      impressions: Math.round(v.impressions),
      ctr: v.impressions > 0 ? v.clicks / v.impressions : 0,
      position: v.posWeight > 0 ? v.posSum / v.posWeight : 0,
    });
  }
  return { metrics: result, aliases };
}

/**
 * Expression-length budget for a single GSC query-regex batch (RE2 safe).
 * Conservative to stay well within GSC's 4 096-byte limit for the full
 * request body, accounting for JSON encoding overhead.
 */
const QUERY_REGEX_BATCH_CHARS = 3_500;
const QUERY_REGEX_WRAPPER_CHARS = 4; // ^( ... )$

/**
 * Per-run hard row cap for the query×page evidence fetch.
 * 500 000 rows keeps memory bounded for a 52-week × country-filtered run
 * on a large site.
 */
const QUERY_PAGE_RUN_CAP = 500_000;

/**
 * Build batches of selected-query aliases into RE2-safe "|"-joined regexes,
 * each staying under QUERY_REGEX_BATCH_CHARS characters.
 *
 * @param queryAliasMap  Map from normalizedQuery → Set of raw alias strings
 *   (all the raw forms seen in GSC for that normalized key).
 * @returns Array of { regex, queriesInBatch } batches.
 */
export function buildQueryRegexBatches(
  queryAliasMap: Map<string, Set<string>>,
): Array<{ regex: string; queriesInBatch: Set<string> }> {
  /**
   * Escape a single raw query string for use as a literal RE2 alternative.
   * RE2 metacharacters that need escaping: . * + ? ^ $ { } ( ) | [ ] \
   */
  function escapeRe2(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const batches: Array<{ regex: string; queriesInBatch: Set<string> }> = [];
  let currentAlts: string[] = [];
  let currentNorm: Set<string> = new Set();
  let currentLen = 0;

  function flushBatch(): void {
    if (currentAlts.length === 0) return;
    batches.push({
      regex: `^(${currentAlts.join("|")})$`,
      queriesInBatch: currentNorm,
    });
    currentAlts = [];
    currentNorm = new Set();
    currentLen = 0;
  }

  for (const [normalizedQ, aliases] of queryAliasMap) {
    for (const alias of aliases) {
      const escaped = escapeRe2(alias);
      if (escaped.length + QUERY_REGEX_WRAPPER_CHARS > QUERY_REGEX_BATCH_CHARS) {
        throw new Error(
          `A selected GSC query is too long to safely batch (${alias.length} characters).`,
        );
      }
      // +1 for the "|" separator that will precede it (if not first in batch).
      const addLen = escaped.length + (currentAlts.length > 0 ? 1 : 0);
      if (
        currentAlts.length > 0 &&
        currentLen + addLen + QUERY_REGEX_WRAPPER_CHARS > QUERY_REGEX_BATCH_CHARS
      ) {
        flushBatch();
      }
      currentAlts.push(escaped);
      currentNorm.add(normalizedQ);
      currentLen += escaped.length + (currentAlts.length > 1 ? 1 : 0);
    }
  }
  flushBatch();
  return batches;
}

/**
 * Fetch GSC query×page evidence scoped to the selected queries, weekly
 * per chunk, with per-batch regex filtering.
 *
 * Algorithm:
 *  1. Collect all raw alias forms for each selected normalized query from
 *     the current-period query-only rows (queryMetrics map keyed by normalized
 *     query). For each normalized key, the canonical form is the only alias
 *     stored; callers may extend this map if they have additional raw forms.
 *  2. Batch aliases into RE2-safe regex alternatives (≤ QUERY_REGEX_BATCH_CHARS
 *     chars each). Each batch is sent as a separate GSC request so no single
 *     request carries a gigantic regex.
 *  3. For each weekly chunk × each batch, fetch paginated query×page rows
 *     filtered by both the query regex AND the country (AND-combined).
 *  4. Aggregate incrementally into the result map without retaining all raw
 *     weekly arrays.
 *  5. Fail closed: throws if any chunk-batch request fails OR if the
 *     total accumulated row count exceeds QUERY_PAGE_RUN_CAP.
 */
async function fetchGscQueryPageChunks(opts: {
  siteId: number;
  startDate: string;
  endDate: string;
  countryFilter?: string;
  /** Map: normalizedQuery → Set of raw GSC aliases (usually just the canonical form). */
  queryAliasMap: Map<string, Set<string>>;
}): Promise<Map<string, Map<string, ClusterGscPageEntry>>> {
  const chunks = weeklyChunks(opts.startDate, opts.endDate);
  const batches = buildQueryRegexBatches(opts.queryAliasMap);

  if (batches.length === 0) {
    return new Map();
  }

  // Accumulate result inline: normalizedQuery → page → metrics acc.
  const acc = new Map<
    string,
    Map<string, { clicks: number; impressions: number; posSum: number; posWeight: number }>
  >();
  let totalRows = 0;

  for (const chunk of chunks) {
    for (const batch of batches) {
      const remainingRows = QUERY_PAGE_RUN_CAP - totalRows;
      if (remainingRows <= 0) {
        throw new Error(
          `GSC query+page evidence fetch exceeded the per-run safety cap of ` +
            `${QUERY_PAGE_RUN_CAP} rows. Reduce the keyword limit or narrow the ` +
            `date range to proceed.`,
        );
      }
      let rows: GscQueryPageRow[];
      try {
        rows = await queryGscQueryPage({
          siteId: opts.siteId,
          startDate: chunk.start,
          endDate: chunk.end,
          countryFilter: opts.countryFilter,
          queryRegex: batch.regex,
          maxRows: remainingRows,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `GSC query+page fetch failed for chunk ${chunk.start}–${chunk.end}: ${msg}`,
        );
      }

      for (const r of rows) {
        // Only accumulate rows whose query normalizes to a selected query.
        const normalizedQ = normalizeQuery(r.query);
        if (!normalizedQ || !batch.queriesInBatch.has(normalizedQ)) continue;

        const canonPage = canonicalizePageUrl(r.page);
        if (!canonPage) continue;

        let pageMap = acc.get(normalizedQ);
        if (!pageMap) {
          pageMap = new Map();
          acc.set(normalizedQ, pageMap);
        }
        const existing = pageMap.get(canonPage);
        if (existing) {
          existing.clicks += r.clicks;
          existing.impressions += r.impressions;
          existing.posSum += r.position * Math.max(r.impressions, 0);
          existing.posWeight += Math.max(r.impressions, 0);
        } else {
          pageMap.set(canonPage, {
            clicks: r.clicks,
            impressions: r.impressions,
            posSum: r.position * Math.max(r.impressions, 0),
            posWeight: Math.max(r.impressions, 0),
          });
        }
      }

      totalRows += rows.length;
      if (totalRows > QUERY_PAGE_RUN_CAP) {
        throw new Error(
          `GSC query+page evidence fetch exceeded the per-run safety cap of ` +
            `${QUERY_PAGE_RUN_CAP} rows. Reduce the keyword limit or narrow the ` +
            `date range to proceed.`,
        );
      }
    }
  }

  // Convert accumulators to ClusterGscPageEntry maps.
  const result = new Map<string, Map<string, ClusterGscPageEntry>>();
  for (const [q, pageMap] of acc) {
    const pages = new Map<string, ClusterGscPageEntry>();
    for (const [page, v] of pageMap) {
      pages.set(page, {
        url: page,
        clicks: Math.round(v.clicks),
        impressions: Math.round(v.impressions),
        position: v.posWeight > 0 ? v.posSum / v.posWeight : 0,
      });
    }
    result.set(q, pages);
  }
  return result;
}

export async function runKeywordClustering(site: SiteContext): Promise<void> {
  await reconcileStaleRuns(site.id);
  // Process queued runs one at a time until the queue is empty.
  for (;;) {
    const [run] = await withDbRetry(
      () =>
        db
          .select()
          .from(clusterRunsTable)
          .where(
            and(
              eq(clusterRunsTable.siteId, site.id),
              eq(clusterRunsTable.status, "queued"),
            ),
          )
          .orderBy(asc(clusterRunsTable.createdAt))
          .limit(1),
      { label: "cluster_runs_pick" },
    );
    if (!run) break;
    const isRebuild = run.params.reprocess === true;
    try {
      if (isRebuild) await reprocessRun(run, site);
      else await processRun(run, site);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ err: e, runId: run.id, isRebuild }, "Clustering run failed");
      if (isRebuild) {
        // A failed rebuild must never lose the run (its stored data is
        // the source of truth): restore it as complete with the old rows
        // intact and surface the error on the run itself.
        await updateRun(run.id, {
          status: "complete",
          phase: "done",
          params: { ...run.params, reprocess: false },
          error: `Rebuild failed — previous clusters kept: ${msg}`,
          finishedAt: new Date(),
        });
      } else {
        await updateRun(run.id, {
          status: "failed",
          error: msg,
          finishedAt: new Date(),
        });
      }
    }
  }
}

interface PendingCluster {
  topic: string;
  keywords: ClusterKeywordEntry[];
  totalClicks: number;
  totalImpressions: number;
  blendedCtr: number;
  avgPosition: number | null;
  // Prior-period cluster aggregates
  priorTotalClicks: number | null;
  priorTotalImpressions: number | null;
  priorBlendedCtr: number | null;
  priorAvgPosition: number | null;
  clickDeltaAbs: number | null;
  impressionDeltaAbs: number | null;
  clickDeltaRatio: number | null;
  impressionDeltaRatio: number | null;
  stateCounts: Record<string, number> | null;
}

function aggregate(
  entriesIn: ClusterKeywordEntry[],
): PendingCluster {
  const entries = [...entriesIn].sort((a, b) => b.impressions - a.impressions);
  const totalClicks = entries.reduce((s, e) => s + e.clicks, 0);
  const totalImpressions = entries.reduce((s, e) => s + e.impressions, 0);
  const posWeight = entries.reduce(
    (s, e) => s + (e.position > 0 ? e.impressions : 0),
    0,
  );
  const posSum = entries.reduce(
    (s, e) => s + (e.position > 0 ? e.position * e.impressions : 0),
    0,
  );

  // Prior-period cluster stats.
  const priorStats = aggregateClusterPrior(entries, totalClicks, totalImpressions, true);

  return {
    topic: pickTopic(entries.map((e) => e.query)),
    keywords: entries,
    totalClicks,
    totalImpressions,
    blendedCtr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
    avgPosition: posWeight > 0 ? Number((posSum / posWeight).toFixed(1)) : null,
    priorTotalClicks: priorStats.priorTotalClicks,
    priorTotalImpressions: priorStats.priorTotalImpressions,
    priorBlendedCtr: priorStats.priorBlendedCtr,
    priorAvgPosition: priorStats.priorAvgPosition,
    clickDeltaAbs: priorStats.clickDeltaAbs,
    impressionDeltaAbs: priorStats.impressionDeltaAbs,
    clickDeltaRatio: priorStats.clickDeltaRatio,
    impressionDeltaRatio: priorStats.impressionDeltaRatio,
    stateCounts: priorStats.stateCounts,
  };
}

/**
 * Shared tail of GSC-page runs: cluster entries by GSC page evidence, label
 * clusters with AI (fail-soft to the TF-IDF keyword), assign quadrants, and
 * persist atomically.
 *
 * @param effectiveParams  The fully-resolved params to write on the final run
 *   row (reprocess cleared).  Fresh runs pass their updated params
 *   (window/evidenceSource/algorithmVersion already set); rebuilds pass the
 *   stored run.params unchanged so they never overwrite what was stored.
 */
async function clusterLabelAndPersist(
  run: ClusterRun,
  entries: ClusterKeywordEntry[],
  baseStats: Record<string, number>,
  site: SiteContext,
  queryPageEvidence: Map<string, Map<string, ClusterGscPageEntry>>,
  effectiveParams: ClusterRunParams,
): Promise<void> {
  await updateRun(run.id, { phase: "clustering" });

  // Use gscPages from entries as clustering evidence (populated earlier).
  const eligibleQueries = entries.map((e) => e.query);
  const components = buildGscPageClusters(eligibleQueries, queryPageEvidence);

  const clusteredQueries = new Set<string>();
  for (const comp of components) {
    for (const idx of comp) clusteredQueries.add(eligibleQueries[idx]!);
  }
  const unclustered = entries.filter((e) => !clusteredQueries.has(e.query));

  const clusters = components.map((comp) =>
    aggregate(comp.map((idx) => entries[idx]!)),
  );

  // ---- AI topic labels (fail-soft: keeps pickTopic fallback) ----
  await updateRun(run.id, { phase: "labeling" });
  const labels = await generateClusterLabels(
    clusters.map((c) => ({
      fallback: c.topic,
      keywords: c.keywords.map((k) => k.query),
    })),
  );
  for (let i = 0; i < clusters.length; i++) {
    clusters[i]!.topic = labels[i] ?? clusters[i]!.topic;
  }

  const { quadrants, isOutlier } = assignQuadrants(
    clusters.map((c) => ({
      impressions: c.totalImpressions,
      ctrPercent: c.blendedCtr,
    })),
  );

  // ---- Persist ----
  await updateRun(run.id, { phase: "saving" });

  const rows: Array<typeof clusterRunClustersTable.$inferInsert> = clusters
    .map((c, i) => ({
      runId: run.id,
      siteId: site.id,
      clusterKey: i,
      topic: c.topic,
      quadrant: quadrants[i]!,
      isOutlier: isOutlier[i]!,
      keywordCount: c.keywords.length,
      totalClicks: c.totalClicks,
      totalImpressions: c.totalImpressions,
      blendedCtr: Number(c.blendedCtr.toFixed(2)),
      avgPosition: c.avgPosition,
      keywords: c.keywords,
      // GSC-page runs: no SERP-based URL aggregates.
      ownUrls: [],
      competitorUrls: [],
    }))
    .sort((a, b) => b.totalImpressions - a.totalImpressions)
    .map((row, i) => ({ ...row, clusterKey: i }));

  if (unclustered.length > 0) {
    const u = aggregate(unclustered);
    rows.push({
      runId: run.id,
      siteId: site.id,
      clusterKey: -1,
      topic: "Unclustered",
      quadrant: null,
      isOutlier: false,
      keywordCount: u.keywords.length,
      totalClicks: u.totalClicks,
      totalImpressions: u.totalImpressions,
      blendedCtr: Number(u.blendedCtr.toFixed(2)),
      avgPosition: u.avgPosition,
      keywords: u.keywords,
      ownUrls: [],
      competitorUrls: [],
    });
  }

  await withDbRetry(
    () =>
      db.transaction(async (tx) => {
        await tx
          .delete(clusterRunClustersTable)
          .where(eq(clusterRunClustersTable.runId, run.id));
        for (let i = 0; i < rows.length; i += 50) {
          await tx.insert(clusterRunClustersTable).values(rows.slice(i, i + 50));
        }
      }),
    { label: `cluster_rows_persist:${run.id}` },
  );

  await updateRun(run.id, {
    status: "complete",
    phase: "done",
    params: { ...effectiveParams, reprocess: false },
    progressDone: run.progressTotal > 0 ? run.progressTotal : entries.length,
    finishedAt: new Date(),
    error: null,
    stats: {
      ...baseStats,
      gscQueriesFetched: entries.length,
      clusters: clusters.length,
      unclustered: unclustered.length,
    },
  });
  logger.info(
    {
      runId: run.id,
      gscQueriesFetched: entries.length,
      clusters: clusters.length,
      unclustered: unclustered.length,
      operatorFiltered: baseStats["operatorFiltered"] ?? 0,
    },
    "GSC-page clustering run complete",
  );
}

/**
 * Rebuild an existing GSC-page run from its stored gscPages evidence.
 *
 * Guards:
 *  - Legacy SERP runs (no evidenceSource='gsc_page') → throw with a clear
 *    message directing the user to start a new GSC-page run.
 *  - Re-applies normalization, dedupe, brand exclusion, operator filtering,
 *    and the same threshold logic as processRun.
 */
async function reprocessRun(run: ClusterRun, site: SiteContext): Promise<void> {
  // Guard: refuse to reprocess legacy SERP runs.
  if (run.params.evidenceSource !== "gsc_page") {
    throw new Error(LEGACY_SERP_REBUILD_MESSAGE);
  }

  await updateRun(run.id, {
    status: "running",
    phase: "clustering",
    startedAt: new Date(),
    error: null,
  });

  const rows = await withDbRetry(
    () =>
      db
        .select()
        .from(clusterRunClustersTable)
        .where(
          and(
            eq(clusterRunClustersTable.siteId, site.id),
            eq(clusterRunClustersTable.runId, run.id),
          ),
        ),
    { label: `cluster_rows_load:${run.id}` },
  );

  // Reconstruct a de-duplicated map of stored keyword entries, keyed by
  // normalized query (first-seen wins when the same normalized form appears
  // in multiple cluster rows).
  const byQuery = new Map<string, ClusterKeywordEntry>();
  for (const row of rows) {
    for (const k of row.keywords) {
      const normalized = normalizeQuery(k.query);
      if (!normalized) continue;
      if (!byQuery.has(normalized)) {
        byQuery.set(normalized, { ...k, query: normalized });
      }
    }
  }
  if (byQuery.size === 0) {
    throw new Error("This run has no stored keyword data to rebuild from.");
  }

  // Run the shared eligibility pipeline: normalize/dedupe/brand/operator.
  // No limit on rebuild — use all stored queries that pass the filters.
  const brandToken = run.params.excludeBrand
    ? normalizeQuery(site.host.split(".")[0] ?? "")
    : "";
  const eligible = selectEligibleQueries(
    // byQuery values are already normalized; selectEligibleQueries will re-normalize
    // (idempotent) and perform dedup, brand, and operator checks.
    byQuery.values(),
    brandToken,
  );
  const {
    queries: eligibleKeys,
    duplicatesRemoved,
    brandFiltered,
    operatorFiltered,
  } = eligible;

  if (eligibleKeys.length < 2) {
    throw new Error(
      "Not enough usable keywords left to rebuild after filtering search-operator queries.",
    );
  }

  // Reconstruct entry array in the order returned by the pipeline.
  const entries: ClusterKeywordEntry[] = eligibleKeys.map(
    (q) => byQuery.get(q)!,
  );

  // Rebuild queryPageEvidence from stored gscPages.
  const queryPageEvidence = new Map<string, Map<string, ClusterGscPageEntry>>();
  for (const e of entries) {
    if (!e.gscPages || e.gscPages.length === 0) continue;
    const pageMap = new Map<string, ClusterGscPageEntry>();
    for (const p of e.gscPages) {
      const canonUrl = canonicalizePageUrl(p.url);
      if (p.impressions > 0) {
        pageMap.set(canonUrl, { ...p, url: canonUrl });
      }
    }
    if (pageMap.size > 0) {
      queryPageEvidence.set(e.query, pageMap);
    }
  }

  await clusterLabelAndPersist(
    run,
    entries,
    { duplicatesRemoved, brandFiltered, operatorFiltered },
    site,
    queryPageEvidence,
    // Rebuild retains exactly the stored params (window/evidenceSource/
    // algorithmVersion already written on the original run).
    run.params,
  );
}

async function processRun(
  run: ClusterRun,
  site: SiteContext,
): Promise<void> {
  const p = run.params;
  await updateRun(run.id, {
    status: "running",
    phase: "fetching_queries",
    startedAt: new Date(),
    error: null,
  });

  // ---- 1. Compute date windows ----
  const weeks = resolveWeeks(p);
  const window = computeRunWindow(weeks);

  // Build the effective params object once so every subsequent DB write
  // (intermediate heartbeats AND the final complete row) uses the same object.
  // This prevents clusterLabelAndPersist from re-reading run.params and
  // writing a stale copy that erases window/evidenceSource/algorithmVersion.
  const effectiveParams: ClusterRunParams = {
    ...p,
    weeks,
    window,
    evidenceSource: "gsc_page",
    algorithmVersion: GSC_PAGE_ALGORITHM_VERSION,
  };

  // Store exact date windows in params, set evidenceSource and algorithmVersion.
  await updateRun(run.id, { params: effectiveParams });

  // ---- 2. Fetch current period as weekly GSC query-only chunks ----
  // Uses paginated fetch-to-exhaustion (25 000 rows/call) with a global cap
  // to avoid silently truncating large sites.
  let currentPeriod: GscPeriodResult;
  try {
    currentPeriod = await fetchGscPeriodChunks({
      siteId: run.siteId,
      startDate: window.currentStart,
      endDate: window.currentEnd,
      countryFilter: p.country ?? undefined,
      collectAliases: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("not connected") || msg.toLowerCase().includes("no gsc")) {
      throw new Error(`Google Search Console is not connected. Connect GSC in Integrations and try again.`);
    }
    throw new Error(`GSC data fetch failed for current period: ${msg}`);
  }
  const currentMetrics = currentPeriod.metrics;

  // ---- 3. Fetch prior period as weekly GSC query-only chunks ----
  let priorPeriod: GscPeriodResult;
  try {
    priorPeriod = await fetchGscPeriodChunks({
      siteId: run.siteId,
      startDate: window.priorStart,
      endDate: window.priorEnd,
      countryFilter: p.country ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GSC comparison fetch failed for prior period: ${msg}`);
  }
  const priorMetrics = priorPeriod.metrics;

  // ---- 4. Select top queries from current period via the shared eligibility pipeline ----
  const brandToken = p.excludeBrand
    ? normalizeQuery(site.host.split(".")[0] ?? "")
    : "";
  // Sort by impressions descending before passing to the pipeline so the limit
  // picks the most-visible queries. Keys from fetchGscPeriodChunks are already
  // normalized, but selectEligibleQueries re-normalizes for safety.
  const byImpressions = [...currentMetrics.entries()]
    .map(([q, m]) => ({ query: q, ...m }))
    .sort((a, b) => b.impressions - a.impressions);

  const eligible = selectEligibleQueries(byImpressions, brandToken, p.keywordLimit);
  const { queries, duplicatesRemoved, brandFiltered, operatorFiltered } = eligible;

  if (queries.length < 2) {
    throw new Error(
      `Only ${queries.length} usable queries found in Search Console for this range — nothing to cluster.`,
    );
  }

  await updateRun(run.id, {
    phase: "fetching_pages",
    progressTotal: queries.length,
    progressDone: 0,
  });

  // ---- 5. Build queryAliasMap from selected queries ----
  // Preserve every raw GSC form that collapsed into each selected normalized
  // query. Exact regex filtering must use the raw forms (case, whitespace and
  // compatibility characters included), while post-fetch matching uses the
  // normalized key.
  const queryAliasMap = new Map<string, Set<string>>();
  for (const q of queries) {
    const rawAliases = currentPeriod.aliases.get(q);
    queryAliasMap.set(
      q,
      rawAliases && rawAliases.size > 0 ? new Set(rawAliases) : new Set([q]),
    );
  }

  // ---- 6. Fetch current-window query+page evidence (weekly, batched, scoped) ----
  let queryPageEvidence: Map<string, Map<string, ClusterGscPageEntry>>;
  try {
    queryPageEvidence = await fetchGscQueryPageChunks({
      siteId: run.siteId,
      startDate: window.currentStart,
      endDate: window.currentEnd,
      countryFilter: p.country ?? undefined,
      queryAliasMap,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GSC query+page evidence fetch failed: ${msg}`);
  }

  await updateRun(run.id, { progressDone: queries.length });

  // ---- 6. Build ClusterKeywordEntry list with gscPages evidence ----
  const entries: ClusterKeywordEntry[] = queries.map((q) => {
    const cur = currentMetrics.get(q);
    const prior = priorMetrics.get(q) ?? null;

    const curMetrics: GscPeriodMetrics = cur ?? {
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    };

    const classification = classifyKeyword(curMetrics, prior);

    // Build gscPages from the evidence map for this query.
    const pageMap = queryPageEvidence.get(q);
    const gscPages: ClusterGscPageEntry[] = pageMap
      ? [...pageMap.values()]
          .filter((p) => p.impressions > 0)
          .sort(
            (a, b) =>
              b.impressions - a.impressions ||
              b.clicks - a.clicks ||
              a.url.localeCompare(b.url),
          )
      : [];

    return {
      query: q,
      clicks: curMetrics.clicks,
      impressions: curMetrics.impressions,
      ctr: curMetrics.ctr,
      position: curMetrics.position,
      gscPages,
      // Prior fields
      priorClicks: prior?.clicks ?? null,
      priorImpressions: prior?.impressions ?? null,
      priorCtr: prior?.ctr ?? null,
      priorPosition: prior?.position ?? null,
      // Deltas and state
      clickDelta: classification.clickDelta,
      impressionDelta: classification.impressionDelta,
      clickDeltaAbs: classification.clickDeltaAbs,
      impressionDeltaAbs: classification.impressionDeltaAbs,
      state: classification.state,
    };
  });

  await clusterLabelAndPersist(
    run,
    entries,
    {
      duplicatesRemoved,
      brandFiltered,
      operatorFiltered,
      gscPagesFetched: [...queryPageEvidence.values()].reduce(
        (s, m) => s + m.size,
        0,
      ),
    },
    site,
    queryPageEvidence,
    // Pass the effectiveParams built in step 1 so the final DB row always
    // carries the resolved window/evidenceSource/algorithmVersion, never the
    // stale run.params snapshot that predates step 1's updateRun().
    effectiveParams,
  );
}
