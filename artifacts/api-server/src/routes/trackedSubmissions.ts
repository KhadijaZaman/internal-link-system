import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, trackedSubmissionsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  CreateTrackedSubmissionsBody,
  UpdateTrackedSubmissionBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function serialize(t: typeof trackedSubmissionsTable.$inferSelect) {
  return {
    id: t.id,
    url: t.url,
    label: t.label,
    note: t.note,
    status: t.status,
    createdAt: (t.createdAt ?? new Date()).toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
  };
}

router.get("/tracked-submissions", requireAuth, async (_req, res) => {
  const rows = await db
    .select()
    .from(trackedSubmissionsTable)
    .orderBy(desc(trackedSubmissionsTable.createdAt));
  res.json(rows.map(serialize));
});

router.post("/tracked-submissions", requireAuth, async (req, res) => {
  const parsed = CreateTrackedSubmissionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const note = parsed.data.note?.trim() || null;
  const seen = new Set<string>();
  const values = parsed.data.urls
    .map((u) => u.trim())
    .filter((u) => u.length > 0 && isHttpUrl(u))
    .filter((u) => {
      const key = u.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((url) => ({ url, note }));
  if (values.length === 0) {
    res.status(400).json({ error: "No valid http(s) URLs" });
    return;
  }
  const inserted = await db
    .insert(trackedSubmissionsTable)
    .values(values)
    .returning();
  res.status(201).json(inserted.map(serialize));
});

router.patch("/tracked-submissions/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = UpdateTrackedSubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const updated = await db
    .update(trackedSubmissionsTable)
    .set({
      status: parsed.data.status,
      completedAt: parsed.data.status === "done" ? new Date() : null,
    })
    .where(eq(trackedSubmissionsTable.id, id))
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serialize(updated[0]!));
});

router.delete("/tracked-submissions/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(trackedSubmissionsTable)
    .where(eq(trackedSubmissionsTable.id, id));
  res.json({ ok: true });
});

export default router;
