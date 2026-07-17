import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, digestsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.get("/digests", requireAuth, async (_req, res) => {
  const rows = await db
    .select()
    .from(digestsTable)
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
