import {
  db,
  clusterRunsTable,
  clusterRunClustersTable,
  type ClusterRun,
  type ClusterKeywordEntry,
  type ClusterUrlEntry,
} from "@workspace/db";
import { and, asc, eq, lt, isNull, or } from "drizzle-orm";
import { queryGscDimension, type GscDimensionRow } from "../integrations/gsc";
import { postSerpTasks, fetchSerpTaskResult } from "../integrations/dataforseo";
import {
  buildClusters,
  pickTopic,
  assignQuadrants,
  isOperatorQuery,
} from "../services/clustering";
import { generateClusterLabels } from "../integrations/openaiClusterLabels";
import { withDbRetry } from "../lib/dbRetry";
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

function siteHost(): string {
  return (process.env["SITE_DOMAIN"] ?? "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
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
async function reconcileStaleRuns(): Promise<void> {
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

export async function runKeywordClustering(): Promise<void> {
  await reconcileStaleRuns();
  // Process queued runs one at a time until the queue is empty.
  for (;;) {
    const [run] = await withDbRetry(
      () =>
        db
          .select()
          .from(clusterRunsTable)
          .where(eq(clusterRunsTable.status, "queued"))
          .orderBy(asc(clusterRunsTable.createdAt))
          .limit(1),
      { label: "cluster_runs_pick" },
    );
    if (!run) return;
    const isRebuild = run.params.reprocess === true;
    try {
      if (isRebuild) await reprocessRun(run);
      else await processRun(run);
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
}

function aggregate(entriesIn: ClusterKeywordEntry[], site: string): PendingCluster {
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

  return {
    topic: pickTopic(entries.map((e) => e.query)),
    keywords: entries,
    totalClicks,
    totalImpressions,
    blendedCtr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
    avgPosition: posWeight > 0 ? Number((posSum / posWeight).toFixed(1)) : null,
    ownUrls: own,
    competitorUrls: comp.slice(0, MAX_COMPETITOR_URLS),
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

  const site = siteHost();
  const clusters = components.map((comp) =>
    aggregate(
      comp.map((idx) => clusterable[idx]!),
      site,
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
    const u = aggregate(unclustered, site);
    rows.push({
      runId: run.id,
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
async function reprocessRun(run: ClusterRun): Promise<void> {
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
        .where(eq(clusterRunClustersTable.runId, run.id)),
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
  });
}

async function processRun(run: ClusterRun): Promise<void> {
  const p = run.params;
  await updateRun(run.id, {
    status: "running",
    phase: "fetching_queries",
    startedAt: new Date(),
    error: null,
  });

  // ---- 1. Top GSC queries (search intent source) ----
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2); // GSC data lag
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (p.days - 1));

  const gscRows = await queryGscDimension({
    siteId: run.siteId,
    startDate: isoDay(start),
    endDate: isoDay(end),
    dimension: "query",
    rowLimit: Math.min(5000, p.keywordLimit * 3),
    ...(p.country ? { countryFilter: p.country } : {}),
  });

  const brandToken = p.excludeBrand ? siteHost().split(".")[0] ?? "" : "";
  const byImpressions = [...gscRows].sort((a, b) => b.impressions - a.impressions);
  const seen = new Set<string>();
  const selected: GscDimensionRow[] = [];
  let operatorFiltered = 0;
  for (const row of byImpressions) {
    const q = row.key.trim().toLowerCase();
    if (!q || seen.has(q)) continue;
    seen.add(q);
    if (brandToken && q.includes(brandToken)) continue;
    // Search-operator / boolean queries (AI-agent scrapes) are noise: skip
    // them BEFORE spending paid SERP credits, freeing slots for real queries.
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
  const queries = selected.map((r) => r.key.trim().toLowerCase());
  const gscByQuery = new Map(selected.map((r) => [r.key.trim().toLowerCase(), r]));

  // ---- 2. Post SERP scrape tasks to DataForSEO ----
  await updateRun(run.id, {
    phase: "posting_serp_tasks",
    progressTotal: queries.length,
    progressDone: 0,
  });
  const taskIds = await postSerpTasks(queries, p.locationCode);
  if (taskIds.length === 0) {
    throw new Error("DataForSEO accepted none of the SERP tasks.");
  }

  // ---- 3. Poll for SERP results ----
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

  // ---- 4-6. Cluster, label, persist (shared with rebuild) ----
  const entries: ClusterKeywordEntry[] = queries.map((q) => {
    const gsc = gscByQuery.get(q);
    return {
      query: q,
      clicks: Math.round(gsc?.clicks ?? 0),
      impressions: Math.round(gsc?.impressions ?? 0),
      ctr: gsc?.ctr ?? 0,
      position: gsc?.position ?? 0,
      serpUrls: serpByKeyword.get(q) ?? [],
    };
  });

  await clusterLabelAndPersist(run, entries, {
    serpsFetched: serpByKeyword.size,
    serpsFailed: failed,
    operatorFiltered,
  });
}
