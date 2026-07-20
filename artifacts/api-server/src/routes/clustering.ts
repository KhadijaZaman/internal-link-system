import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, lt, or, asc } from "drizzle-orm";
import {
  db,
  clusterRunsTable,
  clusterRunClustersTable,
  type ClusterRun,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { StartClusterRunBody } from "@workspace/api-zod";
import { runJob } from "../jobs/runner";

const router: IRouter = Router();

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
async function reconcileStaleRuns(): Promise<void> {
  const now = Date.now();
  await db
    .update(clusterRunsTable)
    .set({ status: "interrupted", error: INTERRUPTED_MESSAGE, finishedAt: new Date() })
    .where(
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
          lt(clusterRunsTable.createdAt, new Date(now - STALE_QUEUED_MS)),
        ),
      ),
    );
}

router.post("/clustering/runs", requireAuth, async (req, res) => {
  const parsed = StartClusterRunBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const body = parsed.data;

  await reconcileStaleRuns();

  const active = await db
    .select({ id: clusterRunsTable.id })
    .from(clusterRunsTable)
    .where(
      or(eq(clusterRunsTable.status, "queued"), eq(clusterRunsTable.status, "running")),
    )
    .limit(1);
  if (active.length > 0) {
    res.status(409).json({ error: "A clustering run is already in progress." });
    return;
  }

  const [run] = await db
    .insert(clusterRunsTable)
    .values({
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

  const result = await runJob("keyword_clustering");
  if (!result.started) {
    // Orphan-row race guard: nothing will pick this row up, so remove it.
    await db.delete(clusterRunsTable).where(eq(clusterRunsTable.id, run.id));
    res.status(409).json({ error: `Could not start clustering: ${result.reason}` });
    return;
  }

  res.status(202).json(serializeRun(run));
});

router.get("/clustering/runs", requireAuth, async (_req, res) => {
  // Self-heal after a mid-run server restart: the dashboard polls this list,
  // so reconciling here unsticks a permanently-"running" row (and the
  // disabled Start button) without requiring a manual POST.
  await reconcileStaleRuns();
  const rows = await db
    .select()
    .from(clusterRunsTable)
    .orderBy(desc(clusterRunsTable.createdAt))
    .limit(20);
  res.json(rows.map(serializeRun));
});

router.get("/clustering/runs/:runId", requireAuth, async (req, res) => {
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [run] = await db
    .select()
    .from(clusterRunsTable)
    .where(eq(clusterRunsTable.id, runId))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeRun(run));
});

router.get("/clustering/runs/:runId/clusters", requireAuth, async (req, res) => {
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [run] = await db
    .select({ id: clusterRunsTable.id })
    .from(clusterRunsTable)
    .where(eq(clusterRunsTable.id, runId))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await db
    .select()
    .from(clusterRunClustersTable)
    .where(eq(clusterRunClustersTable.runId, runId))
    .orderBy(desc(clusterRunClustersTable.totalImpressions), asc(clusterRunClustersTable.clusterKey));
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
      keywords: r.keywords,
      ownUrls: r.ownUrls,
      competitorUrls: r.competitorUrls,
    })),
  );
});

export default router;
