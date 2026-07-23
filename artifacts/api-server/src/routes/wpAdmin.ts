import { Router, type IRouter } from "express";
import { and, eq, desc } from "drizzle-orm";
import {
  db,
  pageClassificationsTable,
  linkExcludeListTable,
  wpPostsTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { canonicalPath, canonicalUrl } from "../lib/urlCanon";

const router: IRouter = Router();

router.get("/wp/classifications", requireAuth, async (_req, res) => {
  const rows = await db
    .select({
      url: pageClassificationsTable.url,
      tier: pageClassificationsTable.tier,
      centralEntity: pageClassificationsTable.centralEntity,
      subEntity: pageClassificationsTable.subEntity,
      parentRootUrl: pageClassificationsTable.parentRootUrl,
      canonicalQuery: pageClassificationsTable.canonicalQuery,
      anchorVariants: pageClassificationsTable.anchorVariants,
      linkQuotaMin: pageClassificationsTable.linkQuotaMin,
      linkQuotaMax: pageClassificationsTable.linkQuotaMax,
      topicalBordersMatch: pageClassificationsTable.topicalBordersMatch,
      manuallyEdited: pageClassificationsTable.manuallyEdited,
      classifiedAt: pageClassificationsTable.classifiedAt,
      title: wpPostsTable.title,
      wordCount: wpPostsTable.wordCount,
    })
    .from(pageClassificationsTable)
    .leftJoin(wpPostsTable, eq(wpPostsTable.url, pageClassificationsTable.url))
    .orderBy(pageClassificationsTable.url)
    .limit(1000);
  res.json({
    items: rows.map((r) => ({
      ...r,
      anchorVariants: r.anchorVariants ?? [],
      classifiedAt: r.classifiedAt?.toISOString() ?? null,
    })),
  });
});

router.patch("/wp/classifications", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const body = req.body as {
    url?: string;
    tier?: number;
    centralEntity?: string;
    subEntity?: string | null;
    parentRootUrl?: string | null;
    canonicalQuery?: string;
    anchorVariants?: string[];
    topicalBordersMatch?: boolean;
  };
  if (!body.url || typeof body.url !== "string") {
    res.status(400).json({ error: "url required" });
    return;
  }
  // Canonicalize before upserting so non-canonical URL forms can't re-enter
  // the migrated page_classifications table.
  const canonPath = canonicalPath(body.url, site.host);
  if (!canonPath) {
    res.status(400).json({ error: "url is not a valid page on this site" });
    return;
  }
  const canonUrl = canonicalUrl(canonPath, site.host);
  const updates: Record<string, unknown> = { manuallyEdited: true };
  if (body.tier && body.tier >= 1 && body.tier <= 4) updates["tier"] = body.tier;
  if (typeof body.centralEntity === "string") updates["centralEntity"] = body.centralEntity;
  if (body.subEntity !== undefined) updates["subEntity"] = body.subEntity;
  if (body.parentRootUrl !== undefined) updates["parentRootUrl"] = body.parentRootUrl;
  if (typeof body.canonicalQuery === "string") updates["canonicalQuery"] = body.canonicalQuery;
  if (Array.isArray(body.anchorVariants)) updates["anchorVariants"] = body.anchorVariants.slice(0, 5);
  if (typeof body.topicalBordersMatch === "boolean")
    updates["topicalBordersMatch"] = body.topicalBordersMatch;

  await db
    .insert(pageClassificationsTable)
    .values({ url: canonUrl, siteId: site.id, ...updates })
    .onConflictDoUpdate({
      target: [pageClassificationsTable.url, pageClassificationsTable.siteId],
      set: updates,
    });
  res.json({ ok: true });
});

router.get("/wp/exclude-list", requireAuth, async (_req, res) => {
  const rows = await db
    .select()
    .from(linkExcludeListTable)
    .orderBy(desc(linkExcludeListTable.createdAt));
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      note: r.note,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
  });
});

router.post("/wp/exclude-list", requireAuth, async (req, res) => {
  const body = req.body as { pattern?: string; note?: string };
  if (!body.pattern || typeof body.pattern !== "string" || !body.pattern.trim()) {
    res.status(400).json({ error: "pattern required" });
    return;
  }
  const pattern = body.pattern.trim().slice(0, 500);
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  try {
    const [row] = await db
      .insert(linkExcludeListTable)
      .values({ pattern, note })
      .returning();
    res.status(201).json({
      id: row!.id,
      pattern: row!.pattern,
      note: row!.note,
      createdAt: row!.createdAt?.toISOString() ?? null,
    });
  } catch {
    res.status(409).json({ error: "Pattern already exists" });
  }
});

router.delete("/wp/exclude-list/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(linkExcludeListTable).where(eq(linkExcludeListTable.id, id));
  res.json({ ok: true });
});

export default router;
