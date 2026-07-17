import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, inventoryTable, linkStatsTable, linkGraphTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { sectionFor } from "../lib/sections";
import { GetInventoryPageQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/inventory", requireAuth, async (req, res) => {
  const parsed = GetInventoryPageQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const url = parsed.data.url;
  const [invRows, statRows, inbound, outbound] = await Promise.all([
    db.select().from(inventoryTable).where(eq(inventoryTable.url, url)).limit(1),
    db.select().from(linkStatsTable).where(eq(linkStatsTable.url, url)).limit(1),
    db.select().from(linkGraphTable).where(eq(linkGraphTable.targetUrl, url)),
    db.select().from(linkGraphTable).where(eq(linkGraphTable.sourceUrl, url)),
  ]);
  const inv = invRows[0];
  const stat = statRows[0];
  if (!inv && !stat) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({
    url,
    title: inv?.title ?? null,
    h1: inv?.h1 ?? null,
    section: inv?.section ?? sectionFor(url),
    topQuery: inv?.topQuery ?? null,
    position: inv?.position ?? null,
    impressions: inv?.impressions ?? null,
    clicks: inv?.clicks ?? null,
    lastUpdated: inv?.lastUpdated?.toISOString() ?? null,
    inboundCount: stat?.inboundCount ?? inbound.length,
    outboundCount: stat?.outboundCount ?? outbound.length,
    pagerank: stat?.internalPagerank ?? 0,
    isOrphan: stat?.isOrphan ?? false,
    isDeadEnd: stat?.isDeadEnd ?? false,
    inboundLinks: inbound.map((l) => ({ url: l.sourceUrl, anchorText: l.anchorText })),
    outboundLinks: outbound.map((l) => ({ url: l.targetUrl, anchorText: l.anchorText })),
  });
});

export default router;
