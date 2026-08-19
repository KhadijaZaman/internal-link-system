import {
  db,
  clusterRunsTable,
  clusterRunClustersTable,
  type ClusterRun,
  type ClusterKeywordEntry,
  type ClusterUrlEntry,
  type ClusterRunParams,
} from "@workspace/db";
import { and, asc, eq, lt, isNull, or } from "drizzle-orm";
import { queryGscDimension, type GscDimensionRow } from "../integrations/gsc";
import { postSerpTasks, fetchSerpTaskResult } from "../integrations/dataforseo";
import {
  buildClusters,
  pickTopic,
  assignQuadrants,
  isOperatorQuery,
  computeRunWindow,
  weeklyChunks,
  aggregateGscChunks,
  classifyKeyword,
  aggregateClusterPrior,
  DEFAULT_WEEKS,
  type RawGscRow,
  type GscPeriodMetrics,
} from "../services/clustering";
import { generateClusterLabels } from "../integrations/openaiClusterLabels";
import { withDbRetry } from "../lib/dbRetry";
import { budgetForSite, type JobBudget } from "../lib/jobBudget";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";

const STALE_MS = 3 * 60_000;
const INTERRUPTED_MESSAGE =
  "The server restarted while this clustering run was in progress. Start a new run to try again.";
const SERP_INITIAL_WAIT_MS = 30_000;
const SERP_SWEEP_INTERVAL_MS = 25_000;
const SERP_TIMEOUT_MS = 12 * 60_000;
const SERP_URLS_KEPT = 10;
const MAX_COMPETITOR_URLS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isOwnHost(host: string, site: string): boolean {
  return site !== "" && (host === site || host.endsWith(`.${site}`));
}

/** Normalize a SERP URL for overlap matching: drop fragment, trailing slash. */
function normalizeSerpUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}${u.search}`;
  } catch {
    return raw;
  }
}

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
 * Fetch all weekly GSC chunks for a given date range and aggregate them.
 *
 * If ANY single chunk request fails the entire operation throws — this
 * guarantees we never classify partial data.
 *
 * Note on dataState: queryGscDimension supports `dataState: "all"` which
 * includes unfinalized rows for the most recent ~2 days. We do NOT pass
 * dataState here so GSC uses its default "final" mode. The 3-day lag on our
 * end window already ensures all data in both windows is finalized.
 */
async function fetchGscPeriodChunks(opts: {
  siteId: number;
  startDate: string;
  endDate: string;
  countryFilter?: string;
  rowLimit: number;
}): Promise<Map<string, GscPeriodMetrics>> {
  const chunks = weeklyChunks(opts.startDate, opts.endDate);
  const allChunkRows: RawGscRow[][] = [];

  for (const chunk of chunks) {
    let rows: GscDimensionRow[];
    try {
      rows = await queryGscDimension({
        siteId: opts.siteId,
        startDate: chunk.start,
        endDate: chunk.end,
        dimension: "query",
        rowLimit: opts.rowLimit,
        ...(opts.countryFilter ? { countryFilter: opts.countryFilter } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `GSC comparison fetch failed for chunk ${chunk.start}–${chunk.end}: ${msg}`,
      );
    }
    allChunkRows.push(rows);
  }

  return aggregateGscChunks(allChunkRows);
}

export async function runKeywordClustering(site: SiteContext): Promise<void> {
  await reconcileStaleRuns(site.id);
  const budget = budgetForSite(site);
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
      else await processRun(run, site, budget);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ err: e, runId: run.id, isRebuild }, "Clustering run failed");
      if (isRebuild) {
        // A failed rebuild must never lose the run (its stored SERP data is
        // paid for): restore it as complete with the old rows intact and
        // surface the error on the run itself.
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
  if (budget.anyExhausted()) {
    logger.warn({ budget: budget.summary() }, "Clustering: spend budget exhausted");
  }
}

interface PendingCluster {
  topic: string;
  keywords: ClusterKeywordEntry[];
  totalClicks: number;
  totalImpressions: number;
  blendedCtr: number;
  avgPosition: number | null;
  ownUrls: ClusterUrlEntry[];
  competitorUrls: ClusterUrlEntry[];
  // Prior-period cluster aggregates (always non-null in the job since
  // aggregate() is only called from fresh comparison runs, but typed to match
  // ClusterPriorStats which allows null for legacy-run compatibility)
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
  site: string,
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

  // Own vs competitor URL aggregation across the cluster's SERPs.
  const urlAgg = new Map<string, { count: number; best: number; sum: number }>();
  for (const e of entries) {
    for (const su of e.serpUrls) {
      const norm = normalizeSerpUrl(su.url);
      const agg = urlAgg.get(norm) ?? { count: 0, best: Infinity, sum: 0 };
      agg.count++;
      agg.best = Math.min(agg.best, su.position);
      agg.sum += su.position;
      urlAgg.set(norm, agg);
    }
  }
  const own: ClusterUrlEntry[] = [];
  const comp: ClusterUrlEntry[] = [];
  for (const [url, agg] of urlAgg) {
    const host = hostOf(url);
    const entry: ClusterUrlEntry = {
      url,
      domain: host,
      keywordCount: agg.count,
      bestPosition: Number.isFinite(agg.best) ? agg.best : null,
      avgPosition: agg.count > 0 ? Number((agg.sum / agg.count).toFixed(1)) : null,
    };
    if (isOwnHost(host, site)) own.push(entry);
    else comp.push(entry);
  }
  const byCoverage = (a: ClusterUrlEntry, b: ClusterUrlEntry) =>
    b.keywordCount - a.keywordCount ||
    (a.bestPosition ?? 999) - (b.bestPosition ?? 999);
  own.sort(byCoverage);
  comp.sort(byCoverage);

  // Prior-period cluster stats. This function is called from the job only for
  // fresh comparison runs (prior GSC data was just fetched), so isComparisonRun
  // is always true here. The route re-derives this from params.window when
  // serving the stored data.
  const priorStats = aggregateClusterPrior(entries, totalClicks, totalImpressions, true);

  return {
    topic: pickTopic(entries.map((e) => e.query)),
    keywords: entries,
    totalClicks,
    totalImpressions,
    blendedCtr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
    avgPosition: posWeight > 0 ? Number((posSum / posWeight).toFixed(1)) : null,
    ownUrls: own,
    competitorUrls: comp.slice(0, MAX_COMPETITOR_URLS),
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
 * Shared tail of both run types: cluster the entries by SERP overlap, label
 * clusters with AI (fail-soft to the TF-IDF keyword), assign quadrants, and
 * persist atomically (delete + insert in one transaction so a failed rebuild
 * never destroys the previously stored — and paid-for — SERP data).
 */
async function clusterLabelAndPersist(
  run: ClusterRun,
  entries: ClusterKeywordEntry[],
  baseStats: Record<string, number>,
  site: SiteContext,
): Promise<void> {
  await updateRun(run.id, { phase: "clustering" });

  const clusterable = entries.filter((e) => e.serpUrls.length > 0);
  const urlSets = clusterable.map(
    (e) => new Set(e.serpUrls.map((u) => normalizeSerpUrl(u.url))),
  );
  const components = buildClusters(urlSets);

  const clusteredQueries = new Set<string>();
  for (const comp of components) {
    for (const idx of comp) clusteredQueries.add(clusterable[idx]!.query);
  }
  const unclustered = entries.filter((e) => !clusteredQueries.has(e.query));

  const host = site.host;
  const clusters = components.map((comp) =>
    aggregate(
      comp.map((idx) => clusterable[idx]!),
      host,
    ),
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
      ownUrls: c.ownUrls,
      competitorUrls: c.competitorUrls,
    }))
    .sort((a, b) => b.totalImpressions - a.totalImpressions)
    .map((row, i) => ({ ...row, clusterKey: i }));

  if (unclustered.length > 0) {
    const u = aggregate(unclustered, host);
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
    params: { ...run.params, reprocess: false },
    progressDone: run.progressTotal > 0 ? run.progressTotal : entries.length,
    finishedAt: new Date(),
    error: null,
    stats: {
      ...baseStats,
      keywords: entries.length,
      clusters: clusters.length,
      unclustered: unclustered.length,
    },
  });
  logger.info(
    {
      runId: run.id,
      keywords: entries.length,
      clusters: clusters.length,
      unclustered: unclustered.length,
      operatorFiltered: baseStats["operatorFiltered"] ?? 0,
    },
    "Clustering run complete",
  );
}

/** Rebuild an existing run from its stored SERP data — no GSC or DataForSEO calls. */
async function reprocessRun(run: ClusterRun, site: SiteContext): Promise<void> {
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
  const byQuery = new Map<string, ClusterKeywordEntry>();
  for (const row of rows) {
    for (const k of row.keywords) {
      if (!byQuery.has(k.query)) byQuery.set(k.query, k);
    }
  }
  if (byQuery.size === 0) {
    throw new Error("This run has no stored keyword data to rebuild from.");
  }

  let operatorFiltered = 0;
  const entries: ClusterKeywordEntry[] = [];
  for (const e of byQuery.values()) {
    if (isOperatorQuery(e.query)) operatorFiltered++;
    else entries.push(e);
  }
  if (entries.length < 2) {
    throw new Error(
      "Not enough usable keywords left to rebuild after filtering search-operator queries.",
    );
  }

  const serpsFetched = entries.filter((e) => e.serpUrls.length > 0).length;
  await clusterLabelAndPersist(run, entries, {
    serpsFetched,
    serpsFailed: run.stats?.["serpsFailed"] ?? 0,
    operatorFiltered,
  }, site);
}

async function processRun(
  run: ClusterRun,
  site: SiteContext,
  budget: JobBudget,
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

  // Store exact date windows in params so rebuilds and the UI can display them.
  await updateRun(run.id, {
    params: {
      ...p,
      weeks,
      window,
    },
  });

  // ---- 2. Fetch current period as weekly GSC chunks ----
  // queryGscDimension uses default dataState (finalized). Our 3-day lag on
  // currentEnd ensures all data in both windows is finalized; no dataState
  // parameter is needed.
  const rowLimit = Math.min(5000, p.keywordLimit * 3);
  let currentMetrics: Map<string, GscPeriodMetrics>;
  try {
    currentMetrics = await fetchGscPeriodChunks({
      siteId: run.siteId,
      startDate: window.currentStart,
      endDate: window.currentEnd,
      countryFilter: p.country ?? undefined,
      rowLimit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish GSC not connected vs chunk fetch failure
    if (msg.toLowerCase().includes("not connected") || msg.toLowerCase().includes("no gsc")) {
      throw new Error(`Google Search Console is not connected. Connect GSC in Integrations and try again.`);
    }
    throw new Error(`GSC data fetch failed for current period: ${msg}`);
  }

  // ---- 3. Fetch prior period as weekly GSC chunks ----
  let priorMetrics: Map<string, GscPeriodMetrics>;
  try {
    priorMetrics = await fetchGscPeriodChunks({
      siteId: run.siteId,
      startDate: window.priorStart,
      endDate: window.priorEnd,
      countryFilter: p.country ?? undefined,
      rowLimit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GSC comparison fetch failed for prior period: ${msg}`);
  }

  // ---- 4. Select top queries from current period ----
  const brandToken = p.excludeBrand ? site.host.split(".")[0] ?? "" : "";
  const byImpressions = [...currentMetrics.entries()]
    .map(([q, m]) => ({ query: q, ...m }))
    .sort((a, b) => b.impressions - a.impressions);

  const seen = new Set<string>();
  const selected: Array<{ query: string } & GscPeriodMetrics> = [];
  let operatorFiltered = 0;
  for (const row of byImpressions) {
    const q = row.query.trim().toLowerCase();
    if (!q || seen.has(q)) continue;
    seen.add(q);
    if (brandToken && q.includes(brandToken)) continue;
    if (isOperatorQuery(q)) {
      operatorFiltered++;
      continue;
    }
    selected.push(row);
    if (selected.length >= p.keywordLimit) break;
  }
  if (selected.length < 2) {
    throw new Error(
      `Only ${selected.length} usable queries found in Search Console for this range — nothing to cluster.`,
    );
  }

  // Spend cap: one paid DataForSEO SERP task per query.
  let capApplied = false;
  if (!budget.take("serpQueries", selected.length)) {
    const allowed = budget.remaining("serpQueries");
    if (allowed < 2) {
      throw new Error(
        `SERP quota cap reached — only ${allowed} of the per-run SERP budget remains; a clustering run needs at least 2 queries.`,
      );
    }
    logger.warn(
      { runId: run.id, requested: selected.length, allowed },
      "Clustering: SERP quota cap — trimming keyword set to budget",
    );
    selected.length = allowed;
    budget.take("serpQueries", allowed);
    capApplied = true;
  }

  const queries = selected.map((r) => r.query);

  // ---- 5. Post SERP scrape tasks to DataForSEO ----
  await updateRun(run.id, {
    phase: "posting_serp_tasks",
    progressTotal: queries.length,
    progressDone: 0,
  });
  const taskIds = await postSerpTasks(queries, p.locationCode);
  if (taskIds.length === 0) {
    throw new Error("DataForSEO accepted none of the SERP tasks.");
  }

  // ---- 6. Poll for SERP results ----
  await updateRun(run.id, { phase: "fetching_serps" });
  await sleep(SERP_INITIAL_WAIT_MS);

  const serpByKeyword = new Map<string, Array<{ url: string; position: number }>>();
  let failed = 0;
  const pending = new Set(taskIds);
  const deadline = Date.now() + SERP_TIMEOUT_MS;

  while (pending.size > 0 && Date.now() < deadline) {
    for (const tid of [...pending]) {
      let result;
      try {
        result = await fetchSerpTaskResult(tid);
      } catch (e) {
        logger.warn({ err: e, taskId: tid }, "SERP task fetch error; will retry");
        continue;
      }
      if (result.status === "pending") continue;
      pending.delete(tid);
      if (result.status === "failed") {
        failed++;
        logger.warn({ taskId: tid, message: result.message }, "SERP task failed");
        continue;
      }
      const kw = result.keyword.trim().toLowerCase();
      if (kw) {
        serpByKeyword.set(kw, result.urls.slice(0, SERP_URLS_KEPT));
      }
    }
    await updateRun(run.id, {
      progressDone: serpByKeyword.size + failed,
    });
    if (pending.size > 0) await sleep(SERP_SWEEP_INTERVAL_MS);
  }
  // Timed-out tasks count as failures; keywords without SERPs become unclustered.
  failed += pending.size;
  if (serpByKeyword.size === 0) {
    throw new Error(
      "No SERP results came back from DataForSEO within the time limit. The tasks may still be processing — try again in a few minutes.",
    );
  }

  await updateRun(run.id, { progressDone: queries.length });

  // ---- 7. Build ClusterKeywordEntry list with prior comparison ----
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

    return {
      query: q,
      clicks: curMetrics.clicks,
      impressions: curMetrics.impressions,
      ctr: curMetrics.ctr,
      position: curMetrics.position,
      serpUrls: serpByKeyword.get(q) ?? [],
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

  await clusterLabelAndPersist(run, entries, {
    serpsFetched: serpByKeyword.size,
    serpsFailed: failed,
    operatorFiltered,
    serpCapApplied: capApplied ? 1 : 0,
  }, site);
}
