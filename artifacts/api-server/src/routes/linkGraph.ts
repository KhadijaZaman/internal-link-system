import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, inventoryTable, linkStatsTable, linkGraphTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { sectionFor } from "../lib/sections";
import { buildFocus } from "../services/linkFocus";
import { GetLinkGraphFocusQueryParams } from "@workspace/api-zod";
import {
  exportLinkMapSheet,
  getStoredLinkMapSheetUrl,
  isLinkMapSheetShared,
  NoLinkDataError,
} from "../services/linkMapSheet";

const router: IRouter = Router();

router.get("/link-graph", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const [stats, inv, edges] = await Promise.all([
    db.select().from(linkStatsTable).where(eq(linkStatsTable.siteId, site.id)),
    db.select().from(inventoryTable).where(eq(inventoryTable.siteId, site.id)),
    db.select().from(linkGraphTable).where(eq(linkGraphTable.siteId, site.id)),
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
    .map((e) => ({
      source: e.sourceUrl,
      target: e.targetUrl,
      anchorText: e.anchorText,
      // Where the link sits on the page: content (editorial) vs nav/header/footer chrome.
      placement: e.placement,
      // null = not audited yet (or chrome edge — audit only scores content links)
      auditFlags: e.auditFlags ?? null,
      auditSimilarity: e.auditSimilarity ?? null,
    }));
  // Audit summary over ALL content edges (source of truth, not just the ones
  // that survive the known-node filter above).
  const contentEdges = edges.filter((e) => e.placement === "content");
  let auditedEdges = 0;
  let offTopic = 0;
  let tierViolations = 0;
  let genericAnchors = 0;
  let latestAudit: Date | null = null;
  for (const e of contentEdges) {
    if (!e.auditedAt) continue;
    auditedEdges++;
    if (!latestAudit || e.auditedAt > latestAudit) latestAudit = e.auditedAt;
    const flags = e.auditFlags ?? [];
    if (flags.includes("off_topic")) offTopic++;
    if (flags.includes("tier_violation")) tierViolations++;
    if (flags.includes("generic_anchor")) genericAnchors++;
  }
  res.json({
    generatedAt: new Date().toISOString(),
    nodes,
    edges: filteredEdges,
    audit: {
      auditedAt: latestAudit?.toISOString() ?? null,
      contentEdges: contentEdges.length,
      auditedEdges,
      offTopic,
      tierViolations,
      genericAnchors,
    },
  });
});

// ─── Google Sheets export ─────────────────────────────────────────────────────

router.get("/link-graph/sheet-info", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const [url, sheetShared] = await Promise.all([
    getStoredLinkMapSheetUrl(site.id),
    isLinkMapSheetShared(site.id),
  ]);
  res.json({ url, sheetShared });
});

router.post("/link-graph/export-sheet", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const body = req.body ?? {};
  const showNav = body.showNav === true;
  const showFooter = body.showFooter === true;
  try {
    const result = await exportLinkMapSheet(site, { showNav, showFooter });
    req.log.info({ rowCount: result.rowCount, showNav, showFooter }, "exported link map sheet");
    res.json(result);
  } catch (err) {
    if (err instanceof NoLinkDataError) {
      res.status(400).json({ error: "No link graph data found for this site" });
      return;
    }
    req.log.error({ err }, "link map sheet export failed");
    res.status(502).json({ error: "Google Sheets request failed" });
  }
});

// ─── Focus subgraph ───────────────────────────────────────────────────────────

router.get("/link-graph/focus", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = GetLinkGraphFocusQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const result = await buildFocus(parsed.data.url, site.id);
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
