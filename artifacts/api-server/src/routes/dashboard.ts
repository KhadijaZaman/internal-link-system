import { Router, type IRouter } from "express";
import { sql, eq, and, count } from "drizzle-orm";
import {
  db,
  inventoryTable,
  linkGraphTable,
  linkStatsTable,
  linkSuggestionsTable,
  queryLosersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { loadJobStatuses } from "../jobs/runner";

const router: IRouter = Router();

router.get("/dashboard/summary", requireAuth, async (_req, res) => {
  const [pages, links, orphans, deadEnds, pending, criticalLosers, coreCount, outerCount] =
    await Promise.all([
      db.select({ c: count() }).from(linkStatsTable),
      db.select({ c: count() }).from(linkGraphTable),
      db.select({ c: count() }).from(linkStatsTable).where(eq(linkStatsTable.isOrphan, true)),
      db.select({ c: count() }).from(linkStatsTable).where(eq(linkStatsTable.isDeadEnd, true)),
      db
        .select({ c: count() })
        .from(linkSuggestionsTable)
        .where(eq(linkSuggestionsTable.status, "pending_review")),
      db
        .select({ c: count() })
        .from(queryLosersTable)
        .where(eq(queryLosersTable.severity, "critical")),
      db.select({ c: count() }).from(inventoryTable).where(eq(inventoryTable.section, "core")),
      db.select({ c: count() }).from(inventoryTable).where(eq(inventoryTable.section, "outer")),
    ]);
  const jobs = await loadJobStatuses();
  res.json({
    totalPages: pages[0]?.c ?? 0,
    totalLinks: links[0]?.c ?? 0,
    orphanCount: orphans[0]?.c ?? 0,
    deadEndCount: deadEnds[0]?.c ?? 0,
    pendingSuggestionsCount: pending[0]?.c ?? 0,
    criticalLosersCount: criticalLosers[0]?.c ?? 0,
    sectionCounts: { core: coreCount[0]?.c ?? 0, outer: outerCount[0]?.c ?? 0 },
    jobs: jobs.map((j) => ({
      name: j.name,
      lastRunAt: j.lastRunAt?.toISOString() ?? null,
      lastStatus: j.lastStatus,
      lastDurationMs: j.lastDurationMs,
      lastError: j.lastError,
    })),
  });
});

export default router;
