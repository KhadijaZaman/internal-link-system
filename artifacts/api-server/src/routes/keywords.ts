import { Router, type IRouter } from "express";
import { desc, eq, and } from "drizzle-orm";
import { db, watchlistQueriesTable, pageTargetKeywordsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { AddWatchlistQueryBody, AddPageKeywordBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/watchlist", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const rows = await db
    .select()
    .from(watchlistQueriesTable)
    .where(eq(watchlistQueriesTable.siteId, site.id))
    .orderBy(desc(watchlistQueriesTable.addedAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      query: r.query,
      addedAt: r.addedAt?.toISOString() ?? null,
    })),
  );
});

router.post("/watchlist", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = AddWatchlistQueryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "query is required (1-200 chars)" });
    return;
  }
  const query = parsed.data.query.trim();
  if (query.length === 0) {
    res.status(400).json({ error: "query cannot be empty" });
    return;
  }
  const inserted = await db
    .insert(watchlistQueriesTable)
    .values({ query, siteId: site.id })
    .onConflictDoNothing({
      target: [watchlistQueriesTable.query, watchlistQueriesTable.siteId],
    })
    .returning();
  const row =
    inserted[0] ??
    (
      await db
        .select()
        .from(watchlistQueriesTable)
        .where(
          and(
            eq(watchlistQueriesTable.query, query),
            eq(watchlistQueriesTable.siteId, site.id),
          ),
        )
        .limit(1)
    )[0];
  if (!row) {
    res.status(500).json({ error: "Failed to add watchlist query" });
    return;
  }
  res.status(201).json({
    id: row.id,
    query: row.query,
    addedAt: row.addedAt?.toISOString() ?? null,
  });
});

router.delete("/watchlist/:id", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(watchlistQueriesTable)
    .where(and(eq(watchlistQueriesTable.siteId, site.id), eq(watchlistQueriesTable.id, id)));
  res.json({ ok: true });
});

router.get("/page-keywords", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const url = String(req.query["url"] ?? "").trim();
  if (url.length === 0) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  const rows = await db
    .select()
    .from(pageTargetKeywordsTable)
    .where(
      and(eq(pageTargetKeywordsTable.siteId, site.id), eq(pageTargetKeywordsTable.url, url)),
    )
    .orderBy(desc(pageTargetKeywordsTable.addedAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      url: r.url,
      keyword: r.keyword,
      addedAt: r.addedAt?.toISOString() ?? null,
    })),
  );
});

router.post("/page-keywords", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = AddPageKeywordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "url and keyword are required" });
    return;
  }
  const url = parsed.data.url.trim();
  const keyword = parsed.data.keyword.trim();
  if (url.length === 0 || keyword.length === 0) {
    res.status(400).json({ error: "url and keyword cannot be empty" });
    return;
  }
  const inserted = await db
    .insert(pageTargetKeywordsTable)
    .values({ url, keyword, siteId: site.id })
    .onConflictDoNothing({
      target: [
        pageTargetKeywordsTable.url,
        pageTargetKeywordsTable.keyword,
        pageTargetKeywordsTable.siteId,
      ],
    })
    .returning();
  const row =
    inserted[0] ??
    (
      await db
        .select()
        .from(pageTargetKeywordsTable)
        .where(
          and(
            eq(pageTargetKeywordsTable.url, url),
            eq(pageTargetKeywordsTable.keyword, keyword),
            eq(pageTargetKeywordsTable.siteId, site.id),
          ),
        )
        .limit(1)
    )[0];
  if (!row) {
    res.status(500).json({ error: "Failed to add target keyword" });
    return;
  }
  res.status(201).json({
    id: row.id,
    url: row.url,
    keyword: row.keyword,
    addedAt: row.addedAt?.toISOString() ?? null,
  });
});

router.delete("/page-keywords/:id", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(pageTargetKeywordsTable)
    .where(
      and(eq(pageTargetKeywordsTable.siteId, site.id), eq(pageTargetKeywordsTable.id, id)),
    );
  res.json({ ok: true });
});

export default router;
