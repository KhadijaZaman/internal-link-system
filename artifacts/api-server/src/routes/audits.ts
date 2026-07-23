import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, auditReportsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";

const router: IRouter = Router();

const ALLOWED = new Set(["orphans", "over_linked", "broken_links"]);

router.get("/audits/:type", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const type = String(req.params.type ?? "");
  if (!ALLOWED.has(type)) {
    res.status(400).json({ error: "Invalid audit type" });
    return;
  }
  const rows = await db
    .select()
    .from(auditReportsTable)
    .where(
      and(
        eq(auditReportsTable.siteId, site.id),
        eq(auditReportsTable.type, type),
      ),
    )
    .orderBy(desc(auditReportsTable.runAt))
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.json({ type, runAt: null, itemCount: 0, items: [] });
    return;
  }
  res.json({
    type: row.type,
    runAt: row.runAt?.toISOString() ?? null,
    itemCount: row.itemCount,
    items: Array.isArray(row.payload) ? row.payload : [],
  });
});

export default router;
