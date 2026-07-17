import { Router, type IRouter } from "express";
import { db, inventoryTable, linkStatsTable, linkGraphTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { sectionFor } from "../lib/sections";
import { buildFocus } from "../services/linkFocus";
import { GetLinkGraphFocusQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/link-graph", requireAuth, async (_req, res) => {
  const [stats, inv, edges] = await Promise.all([
    db.select().from(linkStatsTable),
    db.select().from(inventoryTable),
    db.select().from(linkGraphTable),
  ]);
  const invMap = new Map(inv.map((i) => [i.url, i]));
  const nodes = stats.map((s) => {
    const i = invMap.get(s.url);
    return {
      id: s.url,
      title: i?.title ?? null,
      section: i?.section ?? sectionFor(s.url),
      isOrphan: s.isOrphan,
      isDeadEnd: s.isDeadEnd,
      pagerank: s.internalPagerank,
      inboundCount: s.inboundCount,
      outboundCount: s.outboundCount,
      topQuery: i?.topQuery ?? null,
      position: i?.position ?? null,
      impressions: i?.impressions ?? null,
      clicks: i?.clicks ?? null,
    };
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const filteredEdges = edges
    .filter((e) => nodeIds.has(e.sourceUrl) && nodeIds.has(e.targetUrl))
    .map((e) => ({ source: e.sourceUrl, target: e.targetUrl, anchorText: e.anchorText }));
  res.json({
    generatedAt: new Date().toISOString(),
    nodes,
    edges: filteredEdges,
  });
});

router.get("/link-graph/focus", requireAuth, async (req, res) => {
  const parsed = GetLinkGraphFocusQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const result = await buildFocus(parsed.data.url);
  if (!result.found || !result.seed) {
    res.status(404).json({ error: "URL not found in inventory" });
    return;
  }
  res.json({
    generatedAt: new Date().toISOString(),
    seed: result.seed,
    neighbors: result.neighbors,
  });
});

export default router;
