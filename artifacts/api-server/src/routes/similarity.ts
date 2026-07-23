import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db, similarityRunsTable, type SimilarityRun } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { StartSimilarityRunBody } from "@workspace/api-zod";
import { runJob } from "../jobs/runner";

const router: IRouter = Router();

const STALE_MS = 3 * 60_000;
const STALE_QUEUED_MS = 10 * 60_000;
const INTERRUPTED_MESSAGE =
  "The server restarted while this analysis was in progress. Start a new analysis to try again.";
const MAX_URLS = 100;

function serializeRun(run: SimilarityRun, opts?: { omitResults?: boolean }) {
  return {
    id: run.id,
    status: run.status,
    urls: run.urls,
    progressDone: run.progressDone,
    progressTotal: run.progressTotal,
    // The list endpoint is polled every few seconds while a run is active, so
    // it omits the (potentially several-hundred-KB) results payload; clients
    // fetch the selected run's detail endpoint for results.
    results: opts?.omitResults ? null : run.results,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Mark orphaned rows as interrupted: "running" with a stale heartbeat (process
 * died mid-run) or "queued" rows never picked up (server restarted between
 * insert and job start). The jobs runner only repairs job_runs, not this
 * table, so the POST route, list route, and the job itself all reconcile.
 */
async function reconcileStaleRuns(siteId: number): Promise<void> {
  const now = Date.now();
  await db
    .update(similarityRunsTable)
    .set({ status: "interrupted", error: INTERRUPTED_MESSAGE, finishedAt: new Date() })
    .where(
      and(
        eq(similarityRunsTable.siteId, siteId),
        or(
          and(
            eq(similarityRunsTable.status, "running"),
            or(
              lt(similarityRunsTable.heartbeatAt, new Date(now - STALE_MS)),
              isNull(similarityRunsTable.heartbeatAt),
            ),
          ),
          and(
            eq(similarityRunsTable.status, "queued"),
            or(
              lt(similarityRunsTable.heartbeatAt, new Date(now - STALE_QUEUED_MS)),
              and(
                isNull(similarityRunsTable.heartbeatAt),
                lt(similarityRunsTable.createdAt, new Date(now - STALE_QUEUED_MS)),
              ),
            ),
          ),
        ),
      ),
    );
}

/**
 * Validate and normalize one input URL: http/https only, parseable, fragment
 * stripped (same document). Returns null for anything unusable.
 */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  return u.toString();
}

router.post("/similarity/runs", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = StartSimilarityRunBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const raw of parsed.data.urls) {
    const norm = normalizeUrl(raw);
    if (norm === null) {
      if (raw.trim()) invalid.push(raw.trim());
      continue;
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    urls.push(norm);
  }
  if (invalid.length > 0) {
    res.status(400).json({
      error: `Invalid URL${invalid.length > 1 ? "s" : ""} (must be http/https): ${invalid
        .slice(0, 3)
        .join(", ")}${invalid.length > 3 ? ` and ${invalid.length - 3} more` : ""}`,
    });
    return;
  }
  if (urls.length < 2) {
    res.status(400).json({ error: "Enter at least 2 distinct URLs to compare." });
    return;
  }
  if (urls.length > MAX_URLS) {
    res.status(400).json({ error: `Too many URLs — the limit is ${MAX_URLS}.` });
    return;
  }

  await reconcileStaleRuns(site.id);

  const active = await db
    .select({ id: similarityRunsTable.id })
    .from(similarityRunsTable)
    .where(
      and(
        eq(similarityRunsTable.siteId, site.id),
        or(
          eq(similarityRunsTable.status, "queued"),
          eq(similarityRunsTable.status, "running"),
        ),
      ),
    )
    .limit(1);
  if (active.length > 0) {
    res.status(409).json({ error: "A similarity analysis is already in progress." });
    return;
  }

  const [run] = await db
    .insert(similarityRunsTable)
    .values({ siteId: site.id, status: "queued", urls, progressTotal: urls.length })
    .returning();
  if (!run) {
    res.status(500).json({ error: "Failed to create run" });
    return;
  }

  const result = await runJob("analyze_similarity", site);
  if (!result.started) {
    // Orphan-row race guard: nothing will pick this row up, so remove it.
    await db
      .delete(similarityRunsTable)
      .where(and(eq(similarityRunsTable.siteId, site.id), eq(similarityRunsTable.id, run.id)));
    res.status(409).json({ error: `Could not start analysis: ${result.reason}` });
    return;
  }

  res.status(202).json(serializeRun(run));
});

router.get("/similarity/runs", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  // Self-heal after a mid-run server restart: the dashboard polls this list,
  // so reconciling here unsticks a permanently-"running" row.
  await reconcileStaleRuns(site.id);
  const rows = await db
    .select()
    .from(similarityRunsTable)
    .where(eq(similarityRunsTable.siteId, site.id))
    .orderBy(desc(similarityRunsTable.createdAt))
    .limit(10);
  res.json(rows.map((r) => serializeRun(r, { omitResults: true })));
});

router.get("/similarity/runs/:runId", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [run] = await db
    .select()
    .from(similarityRunsTable)
    .where(and(eq(similarityRunsTable.siteId, site.id), eq(similarityRunsTable.id, runId)))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeRun(run));
});

export default router;
