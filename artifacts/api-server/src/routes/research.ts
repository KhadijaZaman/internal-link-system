import { Router, type IRouter } from "express";
import { db, researchRunsTable, researchFindingsTable } from "@workspace/db";
import { and, eq, desc, asc } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { runDataResearch, type DetailRow } from "../services/dataResearch";

const router: IRouter = Router();

async function serializeRun(siteId: number, runId?: number) {
  const runQuery = db
    .select()
    .from(researchRunsTable)
    .where(
      runId == null
        ? and(eq(researchRunsTable.siteId, siteId), eq(researchRunsTable.status, "complete"))
        : and(eq(researchRunsTable.siteId, siteId), eq(researchRunsTable.id, runId)),
    )
    .orderBy(desc(researchRunsTable.startedAt))
    .limit(1);
  const [run] = await runQuery;
  if (!run) {
    return {
      available: false,
      runId: null,
      status: null,
      windowStart: null,
      windowEnd: null,
      finishedAt: null,
      findings: [],
    };
  }
  const findings = await db
    .select()
    .from(researchFindingsTable)
    .where(eq(researchFindingsTable.runId, run.id))
    .orderBy(asc(researchFindingsTable.id));
  return {
    available: true,
    runId: run.id,
    status: run.status,
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    findings: findings.map((f) => ({
      slug: f.slug,
      title: f.title,
      headlineStat: f.headlineStat,
      citation: f.citation,
      methodology: f.methodology,
      detail: (f.detail as DetailRow[] | null) ?? [],
    })),
  };
}

router.get("/research/latest", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  res.json(await serializeRun(site.id));
});

router.post("/research/run", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  try {
    const runId = await runDataResearch(site);
    res.json(await serializeRun(site.id, runId));
  } catch (err) {
    req.log.error({ err }, "Data research failed");
    res.status(502).json({ error: "Research run failed — check the GSC connection and try again" });
  }
});

export default router;
