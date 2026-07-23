import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  topicalMapsTable,
  topicalMapNodesTable,
  topicalMapBridgesTable,
  pagesTable,
  type TopicalMap,
  type TopicalMapNode,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { GenerateTopicalMapBody, UpdateTopicalMapNodeBody } from "@workspace/api-zod";
import { runJob } from "../jobs/runner";
import { reconcileStaleTopicalMaps } from "../jobs/generateTopicalMap";

const router: IRouter = Router();

function serializeMap(map: TopicalMap) {
  return {
    id: map.id,
    status: map.status,
    phase: map.phase,
    progressDone: map.progressDone,
    progressTotal: map.progressTotal,
    error: map.error,
    sourceContext: map.sourceContext,
    centralEntity: map.centralEntity,
    entitySynonyms: map.entitySynonyms,
    centralSearchIntent: map.centralSearchIntent,
    bordersWill: map.bordersWill,
    bordersWillNot: map.bordersWillNot,
    stats: map.stats,
    createdAt: map.createdAt.toISOString(),
    startedAt: map.startedAt?.toISOString() ?? null,
    finishedAt: map.finishedAt?.toISOString() ?? null,
  };
}

interface JoinedNode extends TopicalMapNode {
  pageTitle: string | null;
  gscClicks: number | null;
  gscImpressions: number | null;
  gscPosition: number | null;
}

function serializeNode(n: JoinedNode) {
  return {
    id: n.id,
    mapId: n.mapId,
    parentId: n.parentId,
    level: n.level,
    section: n.section,
    title: n.title,
    canonicalQuery: n.canonicalQuery,
    attributeOwned: n.attributeOwned,
    intent: n.intent,
    predicate: n.predicate,
    funnelStage: n.funnelStage,
    pageType: n.pageType,
    suggestedSlug: n.suggestedSlug,
    suggestedTitle: n.suggestedTitle,
    informationGain: n.informationGain,
    borderNote: n.borderNote,
    priority: n.priority,
    status: n.status,
    matchedPagePath: n.matchedPagePath,
    matchSource: n.matchSource,
    matchConfidence: n.matchConfidence,
    sortOrder: n.sortOrder,
    pageTitle: n.pageTitle,
    gscClicks: n.gscClicks,
    gscImpressions: n.gscImpressions,
    gscPosition: n.gscPosition,
  };
}

async function fetchJoinedNodes(mapId: number, siteId: number): Promise<JoinedNode[]> {
  const rows = await db
    .select({
      node: topicalMapNodesTable,
      pageTitle: pagesTable.title,
      gscClicks: pagesTable.clicks,
      gscImpressions: pagesTable.impressions,
      gscPosition: pagesTable.position,
    })
    .from(topicalMapNodesTable)
    .leftJoin(
      pagesTable,
      and(
        eq(topicalMapNodesTable.matchedPagePath, pagesTable.path),
        eq(pagesTable.siteId, siteId),
      ),
    )
    .where(
      and(eq(topicalMapNodesTable.siteId, siteId), eq(topicalMapNodesTable.mapId, mapId)),
    )
    .orderBy(topicalMapNodesTable.id);
  return rows.map((r) => ({
    ...r.node,
    pageTitle: r.pageTitle ?? null,
    gscClicks: r.gscClicks ?? null,
    gscImpressions: r.gscImpressions ?? null,
    gscPosition: r.gscPosition ?? null,
  }));
}

function pct(published: number, gap: number): number {
  const denom = published + gap;
  return denom === 0 ? 0 : Math.round((published / denom) * 1000) / 10;
}

/** Coverage rollup: totals + per-pillar subtree stats (ignored excluded from %). */
function buildCoverage(nodes: JoinedNode[]) {
  const childrenOf = new Map<number, JoinedNode[]>();
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const list = childrenOf.get(n.parentId);
    if (list) list.push(n);
    else childrenOf.set(n.parentId, [n]);
  }
  const perPillar = nodes
    .filter((n) => n.level === "pillar")
    .map((pillar) => {
      let total = 0;
      let published = 0;
      let gap = 0;
      const stack: JoinedNode[] = [pillar];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (cur.status !== "ignored") {
          total++;
          if (cur.status === "published") published++;
          else gap++;
        }
        const kids = childrenOf.get(cur.id);
        if (kids) stack.push(...kids);
      }
      return {
        nodeId: pillar.id,
        title: pillar.title,
        section: pillar.section,
        total,
        published,
        coveragePct: pct(published, gap),
      };
    });

  const publishedNodes = nodes.filter((n) => n.status === "published").length;
  const gapNodes = nodes.filter((n) => n.status === "gap").length;
  const ignoredNodes = nodes.filter((n) => n.status === "ignored").length;
  return {
    totalNodes: nodes.length,
    publishedNodes,
    gapNodes,
    ignoredNodes,
    coveragePct: pct(publishedNodes, gapNodes),
    perPillar,
  };
}

async function buildDetail(map: TopicalMap, siteId: number) {
  const nodes = await fetchJoinedNodes(map.id, siteId);
  const bridges = await db
    .select()
    .from(topicalMapBridgesTable)
    .where(
      and(eq(topicalMapBridgesTable.siteId, siteId), eq(topicalMapBridgesTable.mapId, map.id)),
    )
    .orderBy(topicalMapBridgesTable.id);
  return {
    map: serializeMap(map),
    nodes: nodes.map(serializeNode),
    bridges: bridges.map((b) => ({
      id: b.id,
      sourceNodeId: b.sourceNodeId,
      targetNodeId: b.targetNodeId,
      bridgeConcept: b.bridgeConcept,
    })),
    coverage: buildCoverage(nodes),
  };
}

router.post("/topical-map/generate", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = GenerateTopicalMapBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const input = parsed.data;

  await reconcileStaleTopicalMaps();

  const active = await db
    .select({ id: topicalMapsTable.id, status: topicalMapsTable.status })
    .from(topicalMapsTable)
    .where(and(eq(topicalMapsTable.siteId, site.id), eq(topicalMapsTable.status, "running")))
    .limit(1);
  const queued = await db
    .select({ id: topicalMapsTable.id })
    .from(topicalMapsTable)
    .where(and(eq(topicalMapsTable.siteId, site.id), eq(topicalMapsTable.status, "queued")))
    .limit(1);
  if (active.length > 0 || queued.length > 0) {
    res.status(409).json({ error: "A map generation is already in progress." });
    return;
  }

  const clean = (arr: string[] | undefined): string[] =>
    (arr ?? []).map((s) => s.trim()).filter((s) => s.length > 0);

  const [map] = await db
    .insert(topicalMapsTable)
    .values({
      siteId: site.id,
      status: "queued",
      sourceContext: input.sourceContext.trim(),
      centralEntity: input.centralEntity.trim(),
      entitySynonyms: clean(input.entitySynonyms),
      centralSearchIntent: input.centralSearchIntent.trim(),
      bordersWill: clean(input.bordersWill),
      bordersWillNot: clean(input.bordersWillNot),
    })
    .returning();
  if (!map) {
    res.status(500).json({ error: "Failed to create map run" });
    return;
  }

  const result = await runJob("generate_topical_map");
  if (!result.started) {
    // Orphan-row race guard: nothing will pick this row up, so remove it.
    await db
      .delete(topicalMapsTable)
      .where(and(eq(topicalMapsTable.siteId, site.id), eq(topicalMapsTable.id, map.id)));
    res.status(409).json({ error: `Could not start generation: ${result.reason}` });
    return;
  }

  res.status(202).json(serializeMap(map));
});

router.get("/topical-map/runs", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  // Self-heal after a mid-run server restart: the dashboard polls this list.
  await reconcileStaleTopicalMaps();
  const rows = await db
    .select()
    .from(topicalMapsTable)
    .where(eq(topicalMapsTable.siteId, site.id))
    .orderBy(desc(topicalMapsTable.createdAt))
    .limit(10);
  res.json(rows.map(serializeMap));
});

router.get("/topical-map/runs/:mapId", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const mapId = Number(req.params.mapId);
  if (!Number.isInteger(mapId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [map] = await db
    .select()
    .from(topicalMapsTable)
    .where(and(eq(topicalMapsTable.siteId, site.id), eq(topicalMapsTable.id, mapId)))
    .limit(1);
  if (!map) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(await buildDetail(map, site.id));
});

router.get("/topical-map/latest", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const [map] = await db
    .select()
    .from(topicalMapsTable)
    .where(and(eq(topicalMapsTable.siteId, site.id), eq(topicalMapsTable.status, "complete")))
    .orderBy(desc(topicalMapsTable.finishedAt))
    .limit(1);
  if (!map) {
    res.status(404).json({ error: "No complete topical map yet" });
    return;
  }
  res.json(await buildDetail(map, site.id));
});

router.patch("/topical-map/nodes/:nodeId", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const nodeId = Number(req.params.nodeId);
  if (!Number.isInteger(nodeId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const parsed = UpdateTopicalMapNodeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const [node] = await db
    .select()
    .from(topicalMapNodesTable)
    .where(and(eq(topicalMapNodesTable.siteId, site.id), eq(topicalMapNodesTable.id, nodeId)))
    .limit(1);
  if (!node) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (node.status === "published") {
    res.status(400).json({ error: "Published nodes cannot be dismissed." });
    return;
  }
  await db
    .update(topicalMapNodesTable)
    .set({ status: parsed.data.status })
    .where(and(eq(topicalMapNodesTable.siteId, site.id), eq(topicalMapNodesTable.id, nodeId)));

  const [row] = await db
    .select({
      node: topicalMapNodesTable,
      pageTitle: pagesTable.title,
      gscClicks: pagesTable.clicks,
      gscImpressions: pagesTable.impressions,
      gscPosition: pagesTable.position,
    })
    .from(topicalMapNodesTable)
    .leftJoin(
      pagesTable,
      and(
        eq(topicalMapNodesTable.matchedPagePath, pagesTable.path),
        eq(pagesTable.siteId, site.id),
      ),
    )
    .where(and(eq(topicalMapNodesTable.siteId, site.id), eq(topicalMapNodesTable.id, nodeId)))
    .limit(1);
  res.json(
    serializeNode({
      ...row!.node,
      pageTitle: row!.pageTitle ?? null,
      gscClicks: row!.gscClicks ?? null,
      gscImpressions: row!.gscImpressions ?? null,
      gscPosition: row!.gscPosition ?? null,
    }),
  );
});

export default router;
