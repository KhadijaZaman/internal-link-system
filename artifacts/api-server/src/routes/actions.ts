import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, actionItemsTable, type ActionItem } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import {
  BatchReviewActionsBody,
  ExportOpportunitiesSheetBody,
  ListActionsQueryParams,
  SetActionStatusBody,
  UpdateActionBody,
} from "@workspace/api-zod";
import { loadGscWindow } from "../lib/gscWindow";
import {
  applyActionReviews,
  exportOpportunitiesSheet,
  getOpportunitiesSheetInfo,
  syncOpportunitiesSheet,
} from "../services/opportunitiesSheet";

const router: IRouter = Router();

function calendarDate(value: Date | string | null | undefined): string | null | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

function serialize(a: ActionItem) {
  return {
    id: a.id,
    actionType: a.actionType,
    category: a.category,
    targetUrl: a.targetUrl,
    title: a.title,
    description: a.description,
    score: a.score,
    impressionsAtStake: a.impressionsAtStake,
    clicksAtStake: a.clicksAtStake,
    source: a.source ?? {},
    sourceRecords: a.sourceRecords ?? [],
    scoreComponents: a.scoreComponents ?? {},
    owner: a.owner,
    dueDate: a.dueDate,
    market: a.market,
    freshness: a.freshness,
    sourceObservedAt: a.sourceObservedAt?.toISOString() ?? null,
    version: a.version,
    status: a.status,
    resolution: a.resolution,
    pinnedOpen: a.pinnedOpen,
    createdAt: (a.createdAt ?? new Date()).toISOString(),
    completedAt: a.completedAt?.toISOString() ?? null,
    dismissedAt: a.dismissedAt?.toISOString() ?? null,
    lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
    updatedAt: a.updatedAt.toISOString(),
  };
}

router.get("/actions", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = ListActionsQueryParams.safeParse(req.query);
  const status = parsed.success ? (parsed.data.status ?? "open") : "open";
  const category = parsed.success ? (parsed.data.category ?? "all") : "all";
  const market = parsed.success ? parsed.data.market : undefined;
  const filters = [
    eq(actionItemsTable.siteId, site.id),
    ...(status === "all" ? [] : [eq(actionItemsTable.status, status)]),
    ...(category === "all" ? [] : [eq(actionItemsTable.category, category)]),
    ...(market ? [eq(actionItemsTable.market, market)] : []),
  ];

  const [rows, countRows, gscWindow] = await Promise.all([
    db
      .select()
      .from(actionItemsTable)
      .where(and(...filters))
      .orderBy(
        status === "open" || status === "all"
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

router.get("/actions/sheet-info", requireAuth, requireSite, async (req, res) => {
  res.json(await getOpportunitiesSheetInfo(getSite(req).id));
});

router.post("/actions/export-sheet", requireAuth, requireSite, async (req, res) => {
  const parsed = ExportOpportunitiesSheetBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid Google Sheets spreadsheet id or URL" });
    return;
  }
  try {
    res.json(await exportOpportunitiesSheet(
      getSite(req),
      parsed.data.spreadsheetId,
      parsed.data.confirmConflictOverwrite,
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    req.log.error({ err: error }, "opportunities sheet export failed");
    res.status(
      /Unresolved spreadsheet conflicts/.test(message)
        ? 409
        : /Invalid|already bound/.test(message)
          ? 400
          : 502,
    ).json({ error: message });
  }
});

router.post("/actions/sync-sheet", requireAuth, requireSite, async (req, res) => {
  try {
    const result = await syncOpportunitiesSheet(getSite(req).id);
    if (!result) {
      res.status(409).json({ error: "No Opportunities sheet is bound to this site" });
      return;
    }
    res.json(result);
  } catch (error) {
    req.log.error({ err: error }, "opportunities sheet import failed");
    res.status(400).json({ error: error instanceof Error ? error.message : "Sheet import failed" });
  }
});

router.post("/actions/batch-review", requireAuth, requireSite, async (req, res) => {
  const parsed = BatchReviewActionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid batch review" });
    return;
  }
  const reviews = parsed.data.items.map((item) => ({
    id: item.id,
    expectedVersion: item.expectedVersion,
    status: item.status,
    owner: item.owner,
    dueDate: item.dueDate === undefined ? undefined : (calendarDate(item.dueDate) ?? null),
    market: item.market,
  }));
  res.json(await applyActionReviews(getSite(req).id, reviews));
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
    .set({
      ...set,
      version: sql`${actionItemsTable.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(actionItemsTable.id, id), eq(actionItemsTable.siteId, site.id)))
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "Action not found" });
    return;
  }
  res.json(serialize(updated[0]!));
});

router.patch("/actions/:id", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const id = Number(req.params.id);
  const parsed = UpdateActionBody.safeParse(req.body);
  if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
    res.status(400).json({ error: "Invalid opportunity review" });
    return;
  }
  const [current] = await db
    .select()
    .from(actionItemsTable)
    .where(and(eq(actionItemsTable.siteId, site.id), eq(actionItemsTable.id, id)))
    .limit(1);
  if (!current) {
    res.status(404).json({ error: "Action not found" });
    return;
  }
  const body = parsed.data;
  const result = await applyActionReviews(site.id, [{
    id,
    expectedVersion: body.expectedVersion,
    status: body.status ?? (current.status as "open" | "done" | "dismissed"),
    owner: body.owner === undefined ? current.owner : body.owner,
    dueDate: body.dueDate === undefined ? current.dueDate : (calendarDate(body.dueDate) ?? null),
    market: body.market ?? current.market,
  }]);
  if (result.stale) {
    res.status(409).json({ error: "Opportunity changed; reload before saving" });
    return;
  }
  const [updated] = await db
    .select()
    .from(actionItemsTable)
    .where(and(eq(actionItemsTable.siteId, site.id), eq(actionItemsTable.id, id)))
    .limit(1);
  res.json(serialize(updated!));
});

export default router;
