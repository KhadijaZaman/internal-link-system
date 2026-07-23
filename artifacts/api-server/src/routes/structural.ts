import { Router, type IRouter } from "express";
import { and, or, eq, sql } from "drizzle-orm";
import { db, linkStatsTable, wpPostsTable, linkSuggestionsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { SuggestStructuralLinksBody } from "@workspace/api-zod";
import { runStructuralLinking, STRUCTURAL_ENGINE_VERSION } from "../jobs/structuralLinking";

const router: IRouter = Router();

router.get("/structural/targets", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const stats = await db
    .select()
    .from(linkStatsTable)
    .where(
      and(
        or(eq(linkStatsTable.isOrphan, true), eq(linkStatsTable.isDeadEnd, true)),
        eq(linkStatsTable.siteId, site.id),
      ),
    );

  const posts = await db
    .select({
      url: wpPostsTable.url,
      title: wpPostsTable.title,
      hasEmbedding: sql<boolean>`${wpPostsTable.embedding} is not null`,
    })
    .from(wpPostsTable)
    .where(eq(wpPostsTable.siteId, site.id));
  const postByUrl = new Map(posts.map((p) => [p.url, p]));

  const sugg = await db
    .select({
      donorUrl: linkSuggestionsTable.donorUrl,
      receiverUrl: linkSuggestionsTable.receiverUrl,
      status: linkSuggestionsTable.status,
      engineVersion: linkSuggestionsTable.engineVersion,
    })
    .from(linkSuggestionsTable)
    .where(eq(linkSuggestionsTable.siteId, site.id));
  const pendingByUrl = new Map<string, number>();
  for (const s of sugg) {
    if (s.engineVersion !== STRUCTURAL_ENGINE_VERSION) continue;
    if (s.status !== "pending_review") continue;
    pendingByUrl.set(s.donorUrl, (pendingByUrl.get(s.donorUrl) ?? 0) + 1);
    pendingByUrl.set(s.receiverUrl, (pendingByUrl.get(s.receiverUrl) ?? 0) + 1);
  }

  let orphanCount = 0;
  let deadEndCount = 0;
  let bothCount = 0;
  const items = stats.map((s) => {
    if (s.isOrphan) orphanCount++;
    if (s.isDeadEnd) deadEndCount++;
    if (s.isOrphan && s.isDeadEnd) bothCount++;
    const post = postByUrl.get(s.url);
    return {
      url: s.url,
      title: post?.title ?? null,
      isOrphan: s.isOrphan,
      isDeadEnd: s.isDeadEnd,
      inboundCount: s.inboundCount,
      outboundCount: s.outboundCount,
      internalPagerank: s.internalPagerank,
      hasEmbedding: post?.hasEmbedding ?? false,
      pendingSuggestions: pendingByUrl.get(s.url) ?? 0,
    };
  });

  // Orphans first (they leak the most authority), each side ranked by pagerank.
  items.sort((a, b) => {
    if (a.isOrphan !== b.isOrphan) return a.isOrphan ? -1 : 1;
    return b.internalPagerank - a.internalPagerank;
  });

  res.json({ orphanCount, deadEndCount, bothCount, items });
});

router.post("/structural/suggest", requireAuth, async (req, res) => {
  const parsed = SuggestStructuralLinksBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  try {
    const result = await runStructuralLinking(parsed.data.url);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Structural linking failed");
    res.status(502).json({ error: "Failed to generate structural suggestions" });
  }
});

export default router;
