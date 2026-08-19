import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, actionItemsTable, type ActionItem } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { ListActionsQueryParams, SetActionStatusBody } from "@workspace/api-zod";
import { loadGscWindow } from "../lib/gscWindow";

const router: IRouter = Router();

function serialize(a: ActionItem) {
  return {
    id: a.id,
    actionType: a.actionType,
    targetUrl: a.targetUrl,
    title: a.title,
    description: a.description,
    score: a.score,
    impressionsAtStake: a.impressionsAtStake,
    clicksAtStake: a.clicksAtStake,
    source: a.source ?? {},
    status: a.status,
    resolution: a.resolution,
    pinnedOpen: a.pinnedOpen,
    createdAt: (a.createdAt ?? new Date()).toISOString(),
    completedAt: a.completedAt?.toISOString() ?? null,
    dismissedAt: a.dismissedAt?.toISOString() ?? null,
    lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
  };
}

router.get("/actions", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = ListActionsQueryParams.safeParse(req.query);
  const status = parsed.success ? (parsed.data.status ?? "open") : "open";

  const [rows, countRows, gscWindow] = await Promise.all([
    status === "all"
      ? db
          .select()
          .from(actionItemsTable)
          .where(eq(actionItemsTable.siteId, site.id))
          .orderBy(desc(actionItemsTable.score))
      : db
          .select()
          .from(actionItemsTable)
          .where(and(eq(actionItemsTable.siteId, site.id), eq(actionItemsTable.status, status)))
          .orderBy(
            status === "open"
              ? desc(actionItemsTable.score)
              : desc(
                  sql`coalesce(${actionItemsTable.completedAt}, ${actionItemsTable.dismissedAt}, ${actionItemsTable.createdAt})`,
                ),
          ),
    db
      .select({ status: actionItemsTable.status, n: sql<number>`count(*)::int` })
      .from(actionItemsTable)
      .where(eq(actionItemsTable.siteId, site.id))
      .groupBy(actionItemsTable.status),
    loadGscWindow(site.id),
  ]);

  const counts = { open: 0, done: 0, dismissed: 0 };
  for (const c of countRows) {
    if (c.status === "open") counts.open = c.n;
    else if (c.status === "done") counts.done = c.n;
    else if (c.status === "dismissed") counts.dismissed = c.n;
  }

  res.json({
    generatedAt: new Date().toISOString(),
    counts,
    gscWindowStart: gscWindow.gscWindowStart,
    gscWindowEnd: gscWindow.gscWindowEnd,
    items: rows.map(serialize),
  });
});

router.post("/actions/:id/status", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = SetActionStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }
  const status = parsed.data.status;
  const now = new Date();
  // Reopening pins the item: recompute won't auto-close it again; a manual
  // Done/Dismiss clears the pin.
  const set =
    status === "done"
      ? { status, resolution: "manual", completedAt: now, dismissedAt: null, pinnedOpen: false }
      : status === "dismissed"
        ? { status, resolution: "manual", dismissedAt: now, completedAt: null, pinnedOpen: false }
        : { status, resolution: null, completedAt: null, dismissedAt: null, pinnedOpen: true };

  const updated = await db
    .update(actionItemsTable)
    .set(set)
    .where(and(eq(actionItemsTable.id, id), eq(actionItemsTable.siteId, site.id)))
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "Action not found" });
    return;
  }
  res.json(serialize(updated[0]!));
});

export default router;
