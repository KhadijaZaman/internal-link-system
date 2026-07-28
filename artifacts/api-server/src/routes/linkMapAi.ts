import { Router, type IRouter } from "express";
import { and, eq, desc, inArray } from "drizzle-orm";
import { db, linkMapRunsTable, inventoryTable, type LinkMapRunRow } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { GenerateLinkMapBody } from "@workspace/api-zod";
import { startLinkMapGeneration, loadClusterData, buildCoverage } from "../services/linkMapAi";

const router: IRouter = Router();

async function serializeRun(siteId: number, run: LinkMapRunRow | undefined) {
  if (!run) {
    return {
      available: false,
      runId: null,
      status: null,
      error: null,
      centralEntity: null,
      hubUrl: null,
      pageUrls: [],
      maxNewLinksPerPage: null,
      startedAt: null,
      finishedAt: null,
      coverage: [],
      proposals: [],
      flags: [],
      doNotLink: [],
    };
  }
  // Coverage is deterministic from the DB, so it's recomputed on read — it
  // stays correct as links get added after the run.
  const coverage = buildCoverage(await loadClusterData(siteId, run.pageUrls));
  return {
    available: true,
    runId: run.id,
    status: run.status,
    error: run.error,
    centralEntity: run.centralEntity,
    hubUrl: run.hubUrl,
    pageUrls: run.pageUrls,
    maxNewLinksPerPage: run.maxNewLinksPerPage,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    coverage,
    proposals: run.result?.proposals ?? [],
    flags: run.result?.flags ?? [],
    doNotLink: run.result?.doNotLink ?? [],
  };
}

/** A run is stale after 5 minutes — the AI call itself is capped at 2. */
const STALE_RUN_MS = 5 * 60 * 1000;

async function latestRun(siteId: number): Promise<LinkMapRunRow | undefined> {
  const [run] = await db
    .select()
    .from(linkMapRunsTable)
    .where(eq(linkMapRunsTable.siteId, siteId))
    .orderBy(desc(linkMapRunsTable.startedAt))
    .limit(1);
  // Self-heal: a crashed background task (or process restart) leaves the row
  // "running" forever, which would keep the dashboard polling and its
  // Generate button disabled. Flip stale rows to error on read.
  if (run && run.status === "running" && Date.now() - run.startedAt.getTime() > STALE_RUN_MS) {
    run.status = "error";
    run.error = "The run was interrupted (server restarted or timed out) — try again";
    run.finishedAt = new Date();
    await db
      .update(linkMapRunsTable)
      .set({ status: run.status, error: run.error, finishedAt: run.finishedAt })
      .where(eq(linkMapRunsTable.id, run.id));
  }
  return run;
}

router.get("/link-map/generations/latest", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  res.json(await serializeRun(site.id, await latestRun(site.id)));
});

router.post("/link-map/generate", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = GenerateLinkMapBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const centralEntity = parsed.data.centralEntity.trim();
  if (centralEntity.length < 2) {
    res.status(400).json({ error: "Central entity is required" });
    return;
  }
  const pageUrls = [...new Set(parsed.data.pageUrls.map((u) => u.trim()).filter(Boolean))];
  const hubUrl = parsed.data.hubUrl?.trim() || null;
  if (pageUrls.length < 2 || pageUrls.length > 30) {
    res.status(400).json({ error: "Select between 2 and 30 pages" });
    return;
  }
  if (hubUrl && !pageUrls.includes(hubUrl)) {
    res.status(400).json({ error: "The hub URL must be one of the selected pages" });
    return;
  }
  // Only pages this site actually has — blocks cross-site URLs outright.
  const known = await db
    .select({ url: inventoryTable.url })
    .from(inventoryTable)
    .where(and(eq(inventoryTable.siteId, site.id), inArray(inventoryTable.url, pageUrls)));
  const knownSet = new Set(known.map((k) => k.url));
  const missing = pageUrls.filter((u) => !knownSet.has(u));
  if (missing.length > 0) {
    res.status(400).json({ error: `Not in this site's inventory: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}` });
    return;
  }
  const running = await latestRun(site.id);
  // Consider a run stale after 5 minutes (the AI call is capped at 2).
  if (
    running?.status === "running" &&
    Date.now() - running.startedAt.getTime() < 5 * 60 * 1000
  ) {
    res.status(409).json({ error: "A link map generation is already running" });
    return;
  }
  await startLinkMapGeneration(site, {
    centralEntity,
    hubUrl,
    pageUrls,
    maxNewLinksPerPage: parsed.data.maxNewLinksPerPage ?? 4,
  });
  res.status(202).json(await serializeRun(site.id, await latestRun(site.id)));
});

export default router;
