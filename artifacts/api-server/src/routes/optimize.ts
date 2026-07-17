import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, optimizeQueueTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { AddOptimizeQueueItemBody } from "@workspace/api-zod";
import { processOptimizeItem } from "../jobs/optimizeUrls";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function serialize(q: typeof optimizeQueueTable.$inferSelect) {
  return {
    id: q.id,
    url: q.url,
    status: q.status,
    priority: q.priority,
    notes: q.notes,
    briefMarkdown: q.briefMarkdown,
    addedAt: (q.addedAt ?? new Date()).toISOString(),
    completedAt: q.completedAt?.toISOString() ?? null,
  };
}

router.get("/optimize-queue", requireAuth, async (_req, res) => {
  const rows = await db
    .select()
    .from(optimizeQueueTable)
    .orderBy(desc(optimizeQueueTable.addedAt));
  res.json(rows.map(serialize));
});

router.post("/optimize-queue", requireAuth, async (req, res) => {
  const parsed = AddOptimizeQueueItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const inserted = await db
    .insert(optimizeQueueTable)
    .values({
      url: parsed.data.url,
      priority: parsed.data.priority ?? "medium",
      notes: parsed.data.notes ?? null,
    })
    .returning();
  res.status(201).json(serialize(inserted[0]!));
});

router.post("/optimize-queue/:id/run", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const found = await db
    .select()
    .from(optimizeQueueTable)
    .where(eq(optimizeQueueTable.id, id))
    .limit(1);
  const item = found[0];
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (item.status === "optimizing") {
    res.status(409).json({ error: "Already running" });
    return;
  }
  void processOptimizeItem(item).catch((err) => {
    logger.error({ err, id }, "processOptimizeItem (per-row) failed");
  });
  res.status(202).json({ ...serialize(item), status: "optimizing" });
});

router.post("/optimize-queue/:id/requeue", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const updated = await db
    .update(optimizeQueueTable)
    .set({ status: "optimize", completedAt: null })
    .where(eq(optimizeQueueTable.id, id))
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serialize(updated[0]!));
});

export default router;
