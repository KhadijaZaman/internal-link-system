import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, lt, or, asc } from "drizzle-orm";
import {
  db,
  clusterRunsTable,
  clusterRunClustersTable,
  type ClusterRun,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { StartClusterRunBody } from "@workspace/api-zod";
import { runJob } from "../jobs/runner";
import { withCache } from "../integrations/gsc";
import {
  buildCentroid,
  ensureQueryEmbeddings,
  DEFAULT_CORE_THRESHOLD,
} from "../services/authoritySnapshot";
import { cosineSim } from "../lib/semanticScorer";

const router: IRouter = Router();

interface ClusterCoreInfo {
  coreSimilarity: number | null;
  coreTag: "on_core" | "off_core" | null;
}

/**
 * Score each cluster's topical alignment against the site's central-entity
 * centroid: impression-weighted mean of the cluster's keyword embeddings vs
 * the pagerank-weighted page centroid. Uses stored query_intel embeddings
 * (progressively filling missing ones, capped per call — same policy as the
 * authority snapshot) and requires at least min(3, keywordCount) embedded
 * keywords before making a claim; otherwise the tag stays null (unknown).
 */
async function computeClusterCoreTags(
  siteId: number,
  rows: Array<{
    id: number;
    clusterKey: number;
    keywords: Array<{ query: string; impressions: number }>;
  }>,
): Promise<Map<number, ClusterCoreInfo>> {
  const result = new Map<number, ClusterCoreInfo>();
  const { centroid } = await buildCentroid(siteId);
  if (!centroid) return result;

  const uniqueQueries = new Set<string>();
  for (const r of rows) {
    if (r.clusterKey === -1) continue;
    for (const k of r.keywords) uniqueQueries.add(k.query.trim().toLowerCase());
  }
  const embByQuery = await ensureQueryEmbeddings(siteId, [...uniqueQueries]);

  const dim = centroid.length;
  for (const r of rows) {
    if (r.clusterKey === -1) continue;
    const mean = new Array<number>(dim).fill(0);
    let weightSum = 0;
    let embeddedCount = 0;
    for (const k of r.keywords) {
      const vec = embByQuery.get(k.query.trim().toLowerCase());
      if (!vec || vec.length !== dim) continue;
      embeddedCount++;
      const w = Math.max(k.impressions, 1);
      weightSum += w;
      for (let i = 0; i < dim; i++) mean[i]! += vec[i]! * w;
    }
    if (embeddedCount < Math.min(3, r.keywords.length) || weightSum === 0) {
      result.set(r.id, { coreSimilarity: null, coreTag: null });
      continue;
    }
    for (let i = 0; i < dim; i++) mean[i]! /= weightSum;
    const sim = Math.round(cosineSim(mean, centroid) * 1000) / 1000;
    result.set(r.id, {
      coreSimilarity: sim,
      coreTag: sim >= DEFAULT_CORE_THRESHOLD ? "on_core" : "off_core",
    });
  }
  return result;
}

const STALE_MS = 3 * 60_000;
const STALE_QUEUED_MS = 10 * 60_000;
const INTERRUPTED_MESSAGE =
  "The server restarted while this clustering run was in progress. Start a new run to try again.";

function serializeRun(run: ClusterRun) {
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    params: run.params,
    progressDone: run.progressDone,
    progressTotal: run.progressTotal,
    stats: run.stats ?? {},
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Mark orphaned rows as interrupted: "running" with a stale heartbeat (process
 * died mid-run) or "queued" rows that were never picked up (server restarted
 * between insert and job start). The jobs runner only repairs job_runs, not
 * this table, so both the POST route and the job itself reconcile.
 */
async function reconcileStaleRuns(siteId: number): Promise<void> {
  const now = Date.now();
  await db
    .update(clusterRunsTable)
    .set({ status: "interrupted", error: INTERRUPTED_MESSAGE, finishedAt: new Date() })
    .where(
      and(
        eq(clusterRunsTable.siteId, siteId),
        or(
          and(
            eq(clusterRunsTable.status, "running"),
            or(
              lt(clusterRunsTable.heartbeatAt, new Date(now - STALE_MS)),
              isNull(clusterRunsTable.heartbeatAt),
            ),
          ),
          and(
            eq(clusterRunsTable.status, "queued"),
            // Requeued rebuilds keep their original (old) createdAt, so staleness
            // must prefer heartbeatAt — set to now when a rebuild is queued.
            or(
              lt(clusterRunsTable.heartbeatAt, new Date(now - STALE_QUEUED_MS)),
              and(
                isNull(clusterRunsTable.heartbeatAt),
                lt(clusterRunsTable.createdAt, new Date(now - STALE_QUEUED_MS)),
              ),
            ),
          ),
        ),
      ),
    );
}

router.post("/clustering/runs", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = StartClusterRunBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const body = parsed.data;

  await reconcileStaleRuns(site.id);

  const active = await db
    .select({ id: clusterRunsTable.id })
    .from(clusterRunsTable)
    .where(
      and(
        eq(clusterRunsTable.siteId, site.id),
        or(eq(clusterRunsTable.status, "queued"), eq(clusterRunsTable.status, "running")),
      ),
    )
    .limit(1);
  if (active.length > 0) {
    res.status(409).json({ error: "A clustering run is already in progress." });
    return;
  }

  const [run] = await db
    .insert(clusterRunsTable)
    .values({
      siteId: site.id,
      status: "queued",
      params: {
        days: body.days ?? 90,
        country: body.country?.toLowerCase() ?? null,
        keywordLimit: body.keywordLimit ?? 250,
        locationCode: body.locationCode ?? 2840,
        excludeBrand: body.excludeBrand ?? true,
      },
    })
    .returning();
  if (!run) {
    res.status(500).json({ error: "Failed to create run" });
    return;
  }

  const result = await runJob("keyword_clustering", site);
  if (!result.started) {
    // Orphan-row race guard: nothing will pick this row up, so remove it.
    await db
      .delete(clusterRunsTable)
      .where(and(eq(clusterRunsTable.siteId, site.id), eq(clusterRunsTable.id, run.id)));
    res.status(409).json({ error: `Could not start clustering: ${result.reason}` });
    return;
  }

  res.status(202).json(serializeRun(run));
});

/**
 * Rebuild a run's clusters from its stored SERP data — re-filters junk
 * queries, re-clusters, and re-labels with AI. Free: no GSC or DataForSEO
 * calls. Allowed on complete runs (and interrupted ones that still have
 * stored rows, e.g. a rebuild cut short by a server restart).
 */
router.post("/clustering/runs/:runId/rebuild", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  await reconcileStaleRuns(site.id);

  const [run] = await db
    .select()
    .from(clusterRunsTable)
    .where(and(eq(clusterRunsTable.siteId, site.id), eq(clusterRunsTable.id, runId)))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (run.status !== "complete" && run.status !== "interrupted") {
    res.status(409).json({ error: "Only finished runs can be rebuilt." });
    return;
  }

  const active = await db
    .select({ id: clusterRunsTable.id })
    .from(clusterRunsTable)
    .where(
      and(
        eq(clusterRunsTable.siteId, site.id),
        or(eq(clusterRunsTable.status, "queued"), eq(clusterRunsTable.status, "running")),
      ),
    )
    .limit(1);
  if (active.length > 0) {
    res.status(409).json({ error: "A clustering run is already in progress." });
    return;
  }

  const [stored] = await db
    .select({ id: clusterRunClustersTable.id })
    .from(clusterRunClustersTable)
    .where(
      and(
        eq(clusterRunClustersTable.siteId, site.id),
        eq(clusterRunClustersTable.runId, runId),
      ),
    )
    .limit(1);
  if (!stored) {
    res.status(409).json({ error: "This run has no stored data to rebuild from." });
    return;
  }

  const [requeued] = await db
    .update(clusterRunsTable)
    .set({
      status: "queued",
      phase: null,
      params: { ...run.params, reprocess: true },
      error: null,
      finishedAt: null,
      // Fresh heartbeat so the queued-staleness reconciler doesn't instantly
      // mark this old-createdAt row as interrupted.
      heartbeatAt: new Date(),
    })
    .where(and(eq(clusterRunsTable.siteId, site.id), eq(clusterRunsTable.id, runId)))
    .returning();

  const result = await runJob("keyword_clustering", site);
  if (!result.started) {
    // Never delete the run — restore it so its stored (paid) data stays usable.
    await db
      .update(clusterRunsTable)
      .set({
        status: run.status,
        phase: run.phase,
        params: run.params,
        error: run.error,
        finishedAt: run.finishedAt,
      })
      .where(and(eq(clusterRunsTable.siteId, site.id), eq(clusterRunsTable.id, runId)));
    res.status(409).json({ error: `Could not start rebuild: ${result.reason}` });
    return;
  }

  res.status(202).json(serializeRun(requeued ?? run));
});

router.get("/clustering/runs", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  // Self-heal after a mid-run server restart: the dashboard polls this list,
  // so reconciling here unsticks a permanently-"running" row (and the
  // disabled Start button) without requiring a manual POST.
  await reconcileStaleRuns(site.id);
  const rows = await db
    .select()
    .from(clusterRunsTable)
    .where(eq(clusterRunsTable.siteId, site.id))
    .orderBy(desc(clusterRunsTable.createdAt))
    .limit(20);
  res.json(rows.map(serializeRun));
});

router.get("/clustering/runs/:runId", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [run] = await db
    .select()
    .from(clusterRunsTable)
    .where(and(eq(clusterRunsTable.siteId, site.id), eq(clusterRunsTable.id, runId)))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeRun(run));
});

router.get("/clustering/runs/:runId/clusters", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [run] = await db
    .select({ id: clusterRunsTable.id, finishedAt: clusterRunsTable.finishedAt })
    .from(clusterRunsTable)
    .where(and(eq(clusterRunsTable.siteId, site.id), eq(clusterRunsTable.id, runId)))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await db
    .select()
    .from(clusterRunClustersTable)
    .where(
      and(
        eq(clusterRunClustersTable.siteId, site.id),
        eq(clusterRunClustersTable.runId, runId),
      ),
    )
    .orderBy(desc(clusterRunClustersTable.totalImpressions), asc(clusterRunClustersTable.clusterKey));

  // Cache key includes finishedAt so a rebuild (same runId, new finish time)
  // invalidates immediately instead of waiting out the TTL.
  const coreTags = await withCache(
    `s${site.id}|cluster-core:v1|${runId}|${run.finishedAt?.getTime() ?? 0}`,
    30 * 60 * 1000,
    () => computeClusterCoreTags(site.id, rows),
  ).catch((e) => {
    req.log.warn({ err: e }, "cluster core-tag enrichment failed; serving untagged");
    return new Map<number, ClusterCoreInfo>();
  });

  res.json(
    rows.map((r) => ({
      id: r.id,
      clusterKey: r.clusterKey,
      topic: r.topic,
      quadrant: r.quadrant,
      isOutlier: r.isOutlier,
      keywordCount: r.keywordCount,
      totalClicks: r.totalClicks,
      totalImpressions: r.totalImpressions,
      blendedCtr: r.blendedCtr,
      avgPosition: r.avgPosition,
      coreSimilarity: coreTags.get(r.id)?.coreSimilarity ?? null,
      coreTag: coreTags.get(r.id)?.coreTag ?? null,
      keywords: r.keywords,
      ownUrls: r.ownUrls,
      competitorUrls: r.competitorUrls,
    })),
  );
});

export default router;
