import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, digestsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";

const router: IRouter = Router();

router.get("/digests", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const rows = await db
    .select()
    .from(digestsTable)
    .where(eq(digestsTable.siteId, site.id))
    .orderBy(desc(digestsTable.weekOf))
    .limit(52);
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      weekOf: r.weekOf,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      payload: r.payload,
    })),
  });
});

export default router;
