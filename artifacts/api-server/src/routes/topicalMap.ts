import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  db,
  topicalMapsTable,
  topicalMapNodesTable,
  topicalMapBridgesTable,
  pagesTable,
  wpPostsTable,
  clusterRunsTable,
  clusterRunClustersTable,
  queryIntelTable,
  type TopicalMap,
  type TopicalMapNode,
  type ClusterKeywordEntry,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { GenerateTopicalMapBody, UpdateTopicalMapNodeBody } from "@workspace/api-zod";
import { runJob } from "../jobs/runner";
import {
  estimateUsTrafficPotential,
  TOPICAL_MAP_TRAFFIC_CTR,
} from "../jobs/enrichTopicalMapDemand";
import { reconcileStaleTopicalMaps } from "../jobs/generateTopicalMap";
import { canonicalPath } from "../lib/urlCanon";
import {
  matchSimilarPagesByPillar,
  type EmbeddedSitePage,
  type PillarAnchorSet,
  type SimilarClusterPage,
} from "../services/topicalMapSimilarPages";

const router: IRouter = Router();
const SIMILAR_PAGES_CACHE_TTL_MS = 5 * 60_000;
const similarPagesCache = new Map<
  string,
  {
    expiresAt: number;
    value: Promise<Map<number, SimilarClusterPage[]>>;
  }
>();

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
    competitorScanStatus: map.competitorScanStatus ?? null,
    competitorScanError: map.competitorScanError ?? null,
    competitorScanStartedAt: map.competitorScanStartedAt?.toISOString() ?? null,
    demandStatus: map.demandStatus ?? null,
    demandError: map.demandError ?? null,
    demandStartedAt: map.demandStartedAt?.toISOString() ?? null,
    demandFetchedAt: map.demandFetchedAt?.toISOString() ?? null,
  };
}

interface JoinedNode extends TopicalMapNode {
  pageTitle: string | null;
  gscClicks: number | null;
  gscImpressions: number | null;
  gscPosition: number | null;
  usSearchVolume: number | null;
  globalSearchVolume: number | null;
  usVolumeFetchedAt: Date | null;
  globalVolumeFetchedAt: Date | null;
  // competitors is already on TopicalMapNode (from DB schema), re-declared here for clarity
}

function serializeNode(n: JoinedNode) {
  const isNewOpportunity = n.status === "gap";
  const demandFetchedAt =
    isNewOpportunity && n.usVolumeFetchedAt !== null && n.globalVolumeFetchedAt !== null
      ? new Date(
          Math.max(
            n.usVolumeFetchedAt.getTime(),
            n.globalVolumeFetchedAt.getTime(),
          ),
        ).toISOString()
      : null;
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
    usSearchVolume: isNewOpportunity ? n.usSearchVolume : null,
    globalSearchVolume: isNewOpportunity ? n.globalSearchVolume : null,
    estimatedUsTraffic: isNewOpportunity
      ? estimateUsTrafficPotential(
          n.usSearchVolume,
          n.usVolumeFetchedAt !== null,
        )
      : null,
    estimatedUsTrafficCtr: TOPICAL_MAP_TRAFFIC_CTR,
    usVolumeFetchedAt:
      isNewOpportunity ? n.usVolumeFetchedAt?.toISOString() ?? null : null,
    globalVolumeFetchedAt:
      isNewOpportunity ? n.globalVolumeFetchedAt?.toISOString() ?? null : null,
    demandFetchedAt,
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
      usSearchVolume: queryIntelTable.searchVolume,
      globalSearchVolume: queryIntelTable.globalSearchVolume,
      usVolumeFetchedAt: queryIntelTable.volumeFetchedAt,
      globalVolumeFetchedAt: queryIntelTable.globalVolumeFetchedAt,
    })
    .from(topicalMapNodesTable)
    .leftJoin(
      pagesTable,
      and(
        eq(topicalMapNodesTable.matchedPagePath, pagesTable.path),
        eq(pagesTable.siteId, siteId),
      ),
    )
    .leftJoin(
      queryIntelTable,
      and(
        eq(queryIntelTable.siteId, siteId),
        sql`${queryIntelTable.query} = lower(trim(${topicalMapNodesTable.canonicalQuery}))`,
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
    usSearchVolume: r.usSearchVolume ?? null,
    globalSearchVolume: r.globalSearchVolume ?? null,
    usVolumeFetchedAt: r.usVolumeFetchedAt ?? null,
    globalVolumeFetchedAt: r.globalVolumeFetchedAt ?? null,
  }));
}

async function fetchEmbeddedSitePages(
  siteId: number,
  siteHost: string,
): Promise<EmbeddedSitePage[]> {
  const [posts, pages] = await Promise.all([
    db
      .select({
        url: wpPostsTable.url,
        title: wpPostsTable.title,
        embedding: wpPostsTable.embedding,
      })
      .from(wpPostsTable)
      .where(and(eq(wpPostsTable.siteId, siteId), isNotNull(wpPostsTable.embedding))),
    db
      .select({ path: pagesTable.path, title: pagesTable.title })
      .from(pagesTable)
      .where(eq(pagesTable.siteId, siteId)),
  ]);
  const registryByPath = new Map(pages.map((page) => [page.path, page.title]));

  return posts.flatMap((post) => {
    const path = canonicalPath(post.url, siteHost);
    if (path === null || post.embedding === null || !registryByPath.has(path)) return [];
    return [
      {
        path,
        title: registryByPath.get(path) ?? post.title ?? null,
        embedding: post.embedding,
      },
    ];
  });
}

function collectPillarAnchorSets(nodes: JoinedNode[]): PillarAnchorSet[] {
  const childrenOf = new Map<number, JoinedNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const children = childrenOf.get(node.parentId);
    if (children) children.push(node);
    else childrenOf.set(node.parentId, [node]);
  }

  return nodes
    .filter((node) => node.level === "pillar")
    .map((pillar) => {
      const anchorPaths = new Set<string>();
      const stack: JoinedNode[] = [pillar];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.status === "published" && node.matchedPagePath !== null) {
          anchorPaths.add(node.matchedPagePath);
        }
        const children = childrenOf.get(node.id);
        if (children) stack.push(...children);
      }
      return { nodeId: pillar.id, anchorPaths: [...anchorPaths] };
    });
}

async function getSimilarPagesByPillar(
  mapId: number,
  siteId: number,
  siteHost: string,
  nodes: JoinedNode[],
): Promise<Map<number, SimilarClusterPage[]>> {
  const pillars = collectPillarAnchorSets(nodes);
  const anchorSignature = pillars
    .map(
      (pillar) =>
        `${pillar.nodeId}:${[...pillar.anchorPaths].sort().join(",")}`,
    )
    .sort()
    .join("|");
  const cacheKey = `${siteId}:${mapId}:${siteHost}:${anchorSignature}`;
  const now = Date.now();
  const cached = similarPagesCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  for (const [key, entry] of similarPagesCache) {
    if (entry.expiresAt <= now) similarPagesCache.delete(key);
  }

  const hasAnchors = pillars.some((pillar) => pillar.anchorPaths.length > 0);
  const value = hasAnchors
    ? fetchEmbeddedSitePages(siteId, siteHost).then((pages) =>
        matchSimilarPagesByPillar(pillars, pages),
      )
    : Promise.resolve(
        new Map(pillars.map((pillar) => [pillar.nodeId, []])),
      );
  similarPagesCache.set(cacheKey, {
    expiresAt: now + SIMILAR_PAGES_CACHE_TTL_MS,
    value,
  });

  try {
    return await value;
  } catch (error) {
    if (similarPagesCache.get(cacheKey)?.value === value) {
      similarPagesCache.delete(cacheKey);
    }
    throw error;
  }
}

function pct(published: number, gap: number): number {
  const denom = published + gap;
  return denom === 0 ? 0 : Math.round((published / denom) * 1000) / 10;
}

/** Coverage rollup: totals + per-pillar subtree stats (ignored excluded from %). */
function buildCoverage(
  nodes: JoinedNode[],
  similarPagesByPillar: Map<number, SimilarClusterPage[]> = new Map(),
) {
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
        similarPages: similarPagesByPillar.get(pillar.id) ?? [],
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

interface NodeCompetitor {
  domain: string;
  url: string;
  bestPosition: number | null;
  matchedQuery: string;
}

function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Which competitors already rank for each topic.
 *
 * Primary source: the node's own `competitors` JSONB column, populated by the
 * analyze_topical_map_competitors job (covers every topic, fresh SERP data).
 *
 * Fallback for nodes without stored data: SERP results stored by the latest
 * complete keyword-clustering run. This typically only covers the small set of
 * GSC queries that were clustered (~12 keywords), so competitor chips will be
 * sparse until the competitor-scan job runs.
 */
async function competitorsByNode(
  nodes: JoinedNode[],
  siteId: number,
  siteHost: string,
): Promise<Map<number, NodeCompetitor[]>> {
  const out = new Map<number, NodeCompetitor[]>();

  // --- Primary: use stored competitors from the analyze job ---
  const needsFallback: JoinedNode[] = [];
  for (const node of nodes) {
    const stored = node.competitors as NodeCompetitor[] | null | undefined;
    if (stored && stored.length > 0) {
      out.set(node.id, stored.slice(0, 5));
    } else {
      needsFallback.push(node);
    }
  }

  // --- Fallback: cluster-run SERP matching for nodes without stored data ---
  // Only legacy runs (evidenceSource absent or not "gsc_page") contain
  // serpUrls. GSC-page runs never populate that field, so filter them in SQL
  // and select the newest legacy report regardless of how many newer GSC runs
  // have completed.
  if (needsFallback.length === 0) return out;

  const [run] = await db
    .select({ id: clusterRunsTable.id })
    .from(clusterRunsTable)
    .where(
      and(
        eq(clusterRunsTable.siteId, siteId),
        eq(clusterRunsTable.status, "complete"),
        sql`${clusterRunsTable.params}->>'evidenceSource' is distinct from 'gsc_page'`,
      ),
    )
    .orderBy(desc(clusterRunsTable.id))
    .limit(1);
  if (!run) return out;

  const clusters = await db
    .select({ keywords: clusterRunClustersTable.keywords })
    .from(clusterRunClustersTable)
    .where(and(eq(clusterRunClustersTable.siteId, siteId), eq(clusterRunClustersTable.runId, run.id)));

  const ownHost = siteHost.replace(/^www\./, "");
  const isOwn = (host: string) => {
    const h = host.replace(/^www\./, "");
    return h === ownHost || h.endsWith(`.${ownHost}`);
  };

  // Pre-parse each keyword entry ONCE (URL parsing + own-host/scheme filtering
  // out of the node loop — nodes × keywords only does string matching below).
  const entries: { query: string; competitors: { domain: string; url: string; position: number | null }[] }[] = [];
  for (const c of clusters) {
    for (const kw of (c.keywords ?? []) as ClusterKeywordEntry[]) {
      if (!kw.serpUrls?.length) continue;
      const competitors: { domain: string; url: string; position: number | null }[] = [];
      for (const s of kw.serpUrls) {
        let parsed: URL;
        try {
          parsed = new URL(s.url);
        } catch {
          continue;
        }
        // Stored SERP data is untrusted; only http(s) links may reach the UI.
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
        if (!parsed.host || isOwn(parsed.host)) continue;
        competitors.push({
          domain: parsed.host.replace(/^www\./, ""),
          url: s.url,
          position: s.position ?? null,
        });
      }
      if (competitors.length > 0) entries.push({ query: normalizeQuery(kw.query), competitors });
    }
  }
  if (entries.length === 0) return out;

  for (const node of needsFallback) {
    const candidates = [node.canonicalQuery, node.title]
      .filter((s): s is string => !!s)
      .map(normalizeQuery)
      .filter((s) => s.length >= 4);
    const byDomain = new Map<string, NodeCompetitor>();
    for (const e of entries) {
      const matched = candidates.some((c) => c === e.query || c.includes(e.query) || e.query.includes(c));
      if (!matched) continue;
      for (const s of e.competitors) {
        const prev = byDomain.get(s.domain);
        if (!prev || (s.position != null && (prev.bestPosition == null || s.position < prev.bestPosition))) {
          byDomain.set(s.domain, { domain: s.domain, url: s.url, bestPosition: s.position, matchedQuery: e.query });
        }
      }
    }
    if (byDomain.size > 0) {
      out.set(
        node.id,
        [...byDomain.values()]
          .sort((a, b) => (a.bestPosition ?? 999) - (b.bestPosition ?? 999))
          .slice(0, 5),
      );
    }
  }
  return out;
}

async function buildDetail(map: TopicalMap, siteId: number, siteHost: string) {
  const [nodes, bridges] = await Promise.all([
    fetchJoinedNodes(map.id, siteId),
    db
      .select()
      .from(topicalMapBridgesTable)
      .where(
        and(
          eq(topicalMapBridgesTable.siteId, siteId),
          eq(topicalMapBridgesTable.mapId, map.id),
        ),
      )
      .orderBy(topicalMapBridgesTable.id),
  ]);
  const [similarPagesByPillar, competitors] = await Promise.all([
    getSimilarPagesByPillar(map.id, siteId, siteHost, nodes),
    competitorsByNode(nodes, siteId, siteHost).catch(
      () => new Map<number, NodeCompetitor[]>(),
    ),
  ]);
  return {
    map: serializeMap(map),
    nodes: nodes.map((n) => ({ ...serializeNode(n), competitors: competitors.get(n.id) ?? [] })),
    bridges: bridges.map((b) => ({
      id: b.id,
      sourceNodeId: b.sourceNodeId,
      targetNodeId: b.targetNodeId,
      bridgeConcept: b.bridgeConcept,
    })),
    coverage: buildCoverage(nodes, similarPagesByPillar),
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

  const result = await runJob("generate_topical_map", site);
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

router.post("/topical-map/runs/:mapId/analyze-competitors", requireAuth, requireSite, async (req, res) => {
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
  if (map.status !== "complete") {
    res.status(409).json({ error: "Competitor scan requires a complete map." });
    return;
  }

  // Stale-scan recovery: the job updates competitor_scan_started_at every
  // 2 minutes as a heartbeat. A running scan with a heartbeat older than
  // 6 minutes (3 missed heartbeats) is considered stale — the process likely
  // restarted mid-scan — and is reset so the user can re-trigger.
  const SCAN_HEARTBEAT_MS = 2 * 60_000; // must match job's HEARTBEAT_INTERVAL_MS
  const SCAN_STALE_MS = SCAN_HEARTBEAT_MS * 3; // 6 minutes
  if (map.competitorScanStatus === "running") {
    const startedAt = map.competitorScanStartedAt;
    const isStale = !startedAt || Date.now() - startedAt.getTime() > SCAN_STALE_MS;
    if (isStale) {
      const [reset] = await db
        .update(topicalMapsTable)
        .set({
          competitorScanStatus: "failed",
          competitorScanError:
            "The server restarted while the competitor scan was in progress. Trigger the scan again to retry.",
        })
        .where(
          and(
            eq(topicalMapsTable.siteId, site.id),
            eq(topicalMapsTable.id, mapId),
            eq(topicalMapsTable.competitorScanStatus, "running"),
          ),
        )
        .returning();
      if (reset) {
        // Successfully reset to 'failed' — fall through and let the new scan start.
        Object.assign(map, reset);
      }
    } else {
      // Scan is genuinely running (fresh heartbeat).
      res.status(409).json({ error: "A competitor scan is already running for this map." });
      return;
    }
  }

  // 'queued' (stuck after a process restart) or 'partial' (previous scan was
  // budget-limited): allow re-triggering. The job's atomic claim is idempotent —
  // if a running job already picked this map up it skips it; otherwise a new
  // job will claim and process it.
  if (map.competitorScanStatus === "queued" || map.competitorScanStatus === "partial") {
    // Fall through to runJob below — treat this as a recovery/continuation trigger.
  }

  // Check DataForSEO credentials are configured before queuing anything.
  if (!process.env["DATAFORSEO_LOGIN"] || !process.env["DATAFORSEO_PASSWORD"]) {
    res.status(422).json({ error: "DataForSEO credentials are not configured." });
    return;
  }

  // Conditionally transition to 'queued' — only from eligible statuses (never
  // from 'running'). A concurrent request that started a scan between the
  // freshness check above and this UPDATE will leave the row at 'running',
  // causing the UPDATE to match 0 rows, which we surface as a 409 below.
  const eligibleStatuses = ["queued", "partial", "complete", "failed"];
  const [updated] = await db
    .update(topicalMapsTable)
    .set({ competitorScanStatus: "queued", competitorScanError: null })
    .where(
      and(
        eq(topicalMapsTable.siteId, site.id),
        eq(topicalMapsTable.id, mapId),
        sql`competitor_scan_status IS NULL OR competitor_scan_status = ANY(${eligibleStatuses})`,
      ),
    )
    .returning();

  if (!updated) {
    res.status(500).json({ error: "Failed to queue competitor scan." });
    return;
  }

  const jobResult = await runJob("analyze_topical_map_competitors", site);
  if (!jobResult.started) {
    // Another scan job is already running for this site. The map is now 'queued'
    // and will be picked up when the running scan's job finishes. Return 202 so
    // the UI shows the queued state rather than an error.
    if (jobResult.reason === "Already running") {
      res.status(202).json(serializeMap(updated));
      return;
    }
    // Unexpected failure — revert so the user can retry.
    await db
      .update(topicalMapsTable)
      .set({ competitorScanStatus: null })
      .where(and(eq(topicalMapsTable.siteId, site.id), eq(topicalMapsTable.id, mapId)));
    res.status(409).json({ error: `Could not start competitor scan: ${jobResult.reason}` });
    return;
  }

  res.status(202).json(serializeMap(updated));
});

router.post("/topical-map/runs/:mapId/refresh-demand", requireAuth, requireSite, async (req, res) => {
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
  if (map.status !== "complete") {
    res.status(409).json({ error: "Demand refresh requires a complete map." });
    return;
  }
  const DEMAND_STALE_MS = 15 * 60_000;
  if (map.demandStatus === "running") {
    const isStale =
      !map.demandStartedAt ||
      Date.now() - map.demandStartedAt.getTime() > DEMAND_STALE_MS;
    if (!isStale) {
      res.status(409).json({ error: "Demand data is already refreshing for this map." });
      return;
    }
    const [reset] = await db
      .update(topicalMapsTable)
      .set({
        demandStatus: "failed",
        demandError:
          "The server restarted while demand data was refreshing. Refresh demand to retry.",
      })
      .where(
        and(
          eq(topicalMapsTable.siteId, site.id),
          eq(topicalMapsTable.id, mapId),
          eq(topicalMapsTable.demandStatus, "running"),
        ),
      )
      .returning();
    if (reset) Object.assign(map, reset);
  }
  if (!process.env["DATAFORSEO_LOGIN"] || !process.env["DATAFORSEO_PASSWORD"]) {
    res.status(422).json({ error: "DataForSEO credentials are not configured." });
    return;
  }

  const [updated] = await db
    .update(topicalMapsTable)
    .set({ demandStatus: "queued", demandError: null })
    .where(
      and(
        eq(topicalMapsTable.siteId, site.id),
        eq(topicalMapsTable.id, mapId),
        or(
          isNull(topicalMapsTable.demandStatus),
          inArray(topicalMapsTable.demandStatus, [
            "queued",
            "complete",
            "partial",
            "failed",
          ]),
        ),
      ),
    )
    .returning();
  if (!updated) {
    res.status(409).json({ error: "Demand data is already refreshing for this map." });
    return;
  }

  const result = await runJob("enrich_topical_map_demand", site);
  if (!result.started && result.reason !== "Already running") {
    await db
      .update(topicalMapsTable)
      .set({ demandStatus: map.demandStatus })
      .where(and(eq(topicalMapsTable.siteId, site.id), eq(topicalMapsTable.id, mapId)));
    res.status(409).json({ error: `Could not start demand refresh: ${result.reason}` });
    return;
  }
  res.status(202).json(serializeMap(updated));
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
  res.json(await buildDetail(map, site.id, site.host));
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
  res.json(await buildDetail(map, site.id, site.host));
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
      usSearchVolume: queryIntelTable.searchVolume,
      globalSearchVolume: queryIntelTable.globalSearchVolume,
      usVolumeFetchedAt: queryIntelTable.volumeFetchedAt,
      globalVolumeFetchedAt: queryIntelTable.globalVolumeFetchedAt,
    })
    .from(topicalMapNodesTable)
    .leftJoin(
      pagesTable,
      and(
        eq(topicalMapNodesTable.matchedPagePath, pagesTable.path),
        eq(pagesTable.siteId, site.id),
      ),
    )
    .leftJoin(
      queryIntelTable,
      and(
        eq(queryIntelTable.siteId, site.id),
        sql`${queryIntelTable.query} = lower(trim(${topicalMapNodesTable.canonicalQuery}))`,
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
      usSearchVolume: row!.usSearchVolume ?? null,
      globalSearchVolume: row!.globalSearchVolume ?? null,
      usVolumeFetchedAt: row!.usVolumeFetchedAt ?? null,
      globalVolumeFetchedAt: row!.globalVolumeFetchedAt ?? null,
    }),
  );
});

export default router;
