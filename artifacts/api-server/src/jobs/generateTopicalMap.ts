import {
  db,
  topicalMapsTable,
  topicalMapNodesTable,
  topicalMapBridgesTable,
  clusterRunsTable,
  clusterRunClustersTable,
  pagesTable,
  wpPostsTable,
  type TopicalMap,
} from "@workspace/db";
import { and, asc, desc, eq, isNotNull, lt, isNull, or, sql } from "drizzle-orm";
import {
  generateSkeleton,
  expandPillar,
  type TopicalMapCharter,
  type SiteDemandDigest,
  type TopicalNodeMeta,
  type TopicalPillar,
} from "../integrations/claudeTopicalMap";
import { embedBatch } from "../integrations/openaiEmbed";
import { canonicalPath } from "../lib/urlCanon";
import type { SiteContext } from "../lib/site";
import { budgetForSite, type JobBudget } from "../lib/jobBudget";
import { cosineSim } from "../lib/semanticScorer";
import { withDbRetry } from "../lib/dbRetry";
import { logger } from "../lib/logger";

const STALE_MS = 5 * 60_000;
const INTERRUPTED_MESSAGE =
  "The server restarted while this map was generating. Start a new generation to try again.";
/**
 * Embedding-match threshold. text-embedding-3-small cosines are compressed —
 * on/off-topic splits around ~0.42 (see knowledge graph SEMANTIC_THRESHOLD
 * rationale), but a query→page "this topic is already covered" claim needs a
 * much higher bar: at 0.5 a live run marked 305/316 topics published against
 * only 46 pages (median cosine 0.61), collapsing the gap analysis. 0.65 keeps
 * only genuinely on-topic pages as coverage.
 */
const EMBED_MATCH_THRESHOLD = 0.65;
/** Hard cap on total nodes persisted per map (runaway-model guard). */
const MAX_NODES = 500;

interface FlatNode {
  meta: TopicalNodeMeta;
  level: "pillar" | "core_topic" | "supporting" | "subtopic";
  section: "core" | "outer";
  /** Index into the flat array; -1 for pillars. */
  parentIdx: number;
  sortOrder: number;
  /** Match results filled by matchNodes(). */
  matchedPagePath: string | null;
  matchSource: "exact_slug" | "top_query" | "embedding" | null;
  matchConfidence: number | null;
}

interface BridgeSpec {
  sourceSlug: string;
  targetSlug: string;
  concept: string;
}

async function updateMap(
  mapId: number,
  set: Partial<typeof topicalMapsTable.$inferInsert>,
): Promise<void> {
  await withDbRetry(
    () =>
      db
        .update(topicalMapsTable)
        .set({ ...set, heartbeatAt: new Date() })
        .where(eq(topicalMapsTable.id, mapId)),
    { label: `topical_map_update:${mapId}` },
  );
}

/** Mark maps whose process died (stale heartbeat) as interrupted. */
export async function reconcileStaleTopicalMaps(): Promise<void> {
  const now = Date.now();
  await withDbRetry(
    () =>
      db
        .update(topicalMapsTable)
        .set({ status: "interrupted", error: INTERRUPTED_MESSAGE, finishedAt: new Date() })
        .where(
          or(
            and(
              eq(topicalMapsTable.status, "running"),
              or(
                lt(topicalMapsTable.heartbeatAt, new Date(now - STALE_MS)),
                isNull(topicalMapsTable.heartbeatAt),
              ),
            ),
            and(
              eq(topicalMapsTable.status, "queued"),
              or(
                lt(topicalMapsTable.heartbeatAt, new Date(now - STALE_MS * 2)),
                and(
                  isNull(topicalMapsTable.heartbeatAt),
                  lt(topicalMapsTable.createdAt, new Date(now - STALE_MS * 2)),
                ),
              ),
            ),
          ),
        ),
    { label: "topical_maps_reconcile" },
  );
}

export async function runGenerateTopicalMap(site: SiteContext): Promise<void> {
  await reconcileStaleTopicalMaps();
  const budget = budgetForSite(site);
  for (;;) {
    const [map] = await withDbRetry(
      () =>
        db
          .select()
          .from(topicalMapsTable)
          .where(
            and(
              eq(topicalMapsTable.siteId, site.id),
              eq(topicalMapsTable.status, "queued"),
            ),
          )
          .orderBy(asc(topicalMapsTable.createdAt))
          .limit(1),
      { label: "topical_map_next_queued" },
    );
    if (!map) {
      if (budget.anyExhausted()) {
        logger.warn({ budget: budget.summary() }, "Topical map: budget exhausted");
      }
      return;
    }

    await updateMap(map.id, {
      status: "running",
      startedAt: new Date(),
      error: null,
      phase: "skeleton",
      progressDone: 0,
      progressTotal: 3,
    });
    try {
      const stats = await processMap(map, site, budget);
      await updateMap(map.id, {
        status: "complete",
        phase: null,
        stats,
        finishedAt: new Date(),
      });
      logger.info({ mapId: map.id, ...stats }, "Topical map generation complete");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ mapId: map.id, err: e }, "Topical map generation failed");
      await updateMap(map.id, {
        status: "failed",
        phase: null,
        error: msg,
        finishedAt: new Date(),
      });
    }
  }
}

/** Site-demand digest: latest complete cluster run + page sections + titles. */
async function buildDemandDigest(site: SiteContext): Promise<SiteDemandDigest> {
  const [latestClusterRun] = await db
    .select({ id: clusterRunsTable.id })
    .from(clusterRunsTable)
    .where(
      and(
        eq(clusterRunsTable.siteId, site.id),
        eq(clusterRunsTable.status, "complete"),
      ),
    )
    .orderBy(desc(clusterRunsTable.finishedAt))
    .limit(1);

  const clusters = latestClusterRun
    ? (
        await db
          .select({
            topic: clusterRunClustersTable.topic,
            keywordCount: clusterRunClustersTable.keywordCount,
            totalImpressions: clusterRunClustersTable.totalImpressions,
          })
          .from(clusterRunClustersTable)
          .where(
            and(
              eq(clusterRunClustersTable.siteId, site.id),
              eq(clusterRunClustersTable.runId, latestClusterRun.id),
              sql`${clusterRunClustersTable.clusterKey} >= 0`,
            ),
          )
          .orderBy(desc(clusterRunClustersTable.totalImpressions))
          .limit(40)
      ).map((c) => ({ ...c }))
    : [];

  const sections = await db
    .select({
      section: sql<string>`coalesce(${pagesTable.section}, 'uncategorized')`,
      pageCount: sql<number>`count(*)::int`,
    })
    .from(pagesTable)
    .where(eq(pagesTable.siteId, site.id))
    .groupBy(sql`coalesce(${pagesTable.section}, 'uncategorized')`)
    .orderBy(desc(sql`count(*)`));

  const titleRows = await db
    .select({ title: pagesTable.title })
    .from(pagesTable)
    .where(and(eq(pagesTable.siteId, site.id), isNotNull(pagesTable.title)))
    .orderBy(desc(pagesTable.impressions))
    .limit(60);

  return {
    clusters,
    sections,
    sampleTitles: titleRows.map((r) => r.title).filter((t): t is string => t !== null),
  };
}

function charterOf(map: TopicalMap): TopicalMapCharter {
  return {
    sourceContext: map.sourceContext,
    centralEntity: map.centralEntity,
    entitySynonyms: map.entitySynonyms,
    centralSearchIntent: map.centralSearchIntent,
    bordersWill: map.bordersWill,
    bordersWillNot: map.bordersWillNot,
  };
}

async function processMap(
  map: TopicalMap,
  site: SiteContext,
  budget: JobBudget,
): Promise<Record<string, number>> {
  const charter = charterOf(map);
  const demand = await buildDemandDigest(site);

  // ---- Phase A: skeleton -------------------------------------------------
  if (!budget.take("llmCalls")) {
    throw new Error("LLM budget exhausted before skeleton generation.");
  }
  const skeleton = await generateSkeleton(charter, demand);
  const pillars = skeleton.pillars;
  await updateMap(map.id, {
    phase: "expanding",
    progressDone: 1,
    progressTotal: 1 + pillars.length + 1,
  });

  // ---- Phase B: expand each pillar (fail-soft per pillar) ------------------
  const nodes: FlatNode[] = [];
  const bridgeSpecs: BridgeSpec[] = [];
  let failedPillars = 0;

  const pushNode = (
    meta: TopicalNodeMeta,
    level: FlatNode["level"],
    section: FlatNode["section"],
    parentIdx: number,
    sortOrder: number,
  ): number => {
    if (nodes.length >= MAX_NODES) return -1;
    nodes.push({
      meta,
      level,
      section,
      parentIdx,
      sortOrder,
      matchedPagePath: null,
      matchSource: null,
      matchConfidence: null,
    });
    return nodes.length - 1;
  };

  let done = 1;
  for (let pi = 0; pi < pillars.length; pi++) {
    const pillar = pillars[pi]!;
    const pillarIdx = pushNode(pillar, "pillar", pillar.section, -1, pi);
    if (pillarIdx < 0) break;
    if (!budget.take("llmCalls")) {
      logger.warn(
        { mapId: map.id, pillar: pillar.suggested_slug },
        "LLM budget exhausted; keeping bare pillar node and stopping expansion",
      );
      break;
    }
    try {
      const expansion = await expandPillar(charter, demand, pillar, pillars);
      expansion.core_topics.forEach((core, ci) => {
        const coreIdx = pushNode(core, "core_topic", pillar.section, pillarIdx, ci);
        if (coreIdx < 0) return;
        core.supporting.forEach((supp, si) => {
          const suppIdx = pushNode(supp, "supporting", pillar.section, coreIdx, si);
          if (suppIdx < 0) return;
          supp.subtopics.forEach((sub, bi) => {
            pushNode(sub, "subtopic", pillar.section, suppIdx, bi);
          });
        });
      });
      for (const b of expansion.bridges) {
        bridgeSpecs.push({
          sourceSlug: b.source_slug,
          targetSlug: b.target_slug,
          concept: b.bridge_concept,
        });
      }
    } catch (e) {
      failedPillars++;
      logger.warn(
        { mapId: map.id, pillar: pillar.suggested_slug, err: e },
        "Pillar expansion failed; keeping bare pillar node",
      );
    }
    done++;
    await updateMap(map.id, { progressDone: done });
  }
  if (nodes.length === pillars.length && failedPillars === pillars.length) {
    throw new Error("Every pillar expansion failed — no map content was generated.");
  }

  // ---- Matching: existing coverage ----------------------------------------
  await updateMap(map.id, { phase: "matching" });
  await matchNodes(nodes, site, budget);
  await updateMap(map.id, { progressDone: done + 1 });

  // ---- Persist (transactional) ---------------------------------------------
  const slugToDbId = new Map<string, number>();
  let bridgeCount = 0;
  await withDbRetry(
    () =>
      db.transaction(async (tx) => {
        const idxToDbId: number[] = new Array<number>(nodes.length).fill(0);
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i]!;
          const [row] = await tx
            .insert(topicalMapNodesTable)
            .values({
              siteId: site.id,
              mapId: map.id,
              parentId: n.parentIdx >= 0 ? idxToDbId[n.parentIdx]! : null,
              level: n.level,
              section: n.section,
              title: n.meta.title,
              canonicalQuery: n.meta.canonical_query,
              attributeOwned: n.meta.attribute_owned,
              intent: n.meta.intent,
              predicate: n.meta.predicate,
              funnelStage: n.meta.funnel_stage,
              pageType: n.meta.page_type,
              suggestedSlug: n.meta.suggested_slug,
              suggestedTitle: n.meta.suggested_title,
              informationGain: n.meta.information_gain ?? null,
              borderNote: n.meta.border_note ?? null,
              priority: n.meta.priority,
              status: n.matchedPagePath !== null ? "published" : "gap",
              matchedPagePath: n.matchedPagePath,
              matchSource: n.matchSource,
              matchConfidence: n.matchConfidence,
              sortOrder: n.sortOrder,
            })
            .returning({ id: topicalMapNodesTable.id });
          idxToDbId[i] = row!.id;
          if (!slugToDbId.has(n.meta.suggested_slug)) {
            slugToDbId.set(n.meta.suggested_slug, row!.id);
          }
        }
        const seenPairs = new Set<string>();
        for (const b of bridgeSpecs) {
          const sourceId = slugToDbId.get(b.sourceSlug);
          const targetId = slugToDbId.get(b.targetSlug);
          if (sourceId === undefined || targetId === undefined || sourceId === targetId) continue;
          const key = `${sourceId}->${targetId}`;
          if (seenPairs.has(key)) continue;
          seenPairs.add(key);
          await tx.insert(topicalMapBridgesTable).values({
            siteId: site.id,
            mapId: map.id,
            sourceNodeId: sourceId,
            targetNodeId: targetId,
            bridgeConcept: b.concept,
          });
          bridgeCount++;
        }
      }),
    { label: `topical_map_persist:${map.id}`, retries: 0 },
  );

  const published = nodes.filter((n) => n.matchedPagePath !== null).length;
  return {
    pillars: pillars.length,
    failedPillars,
    totalNodes: nodes.length,
    publishedNodes: published,
    gapNodes: nodes.length - published,
    bridges: bridgeCount,
    matchedBySlug: nodes.filter((n) => n.matchSource === "exact_slug").length,
    matchedByQuery: nodes.filter((n) => n.matchSource === "top_query").length,
    matchedByEmbedding: nodes.filter((n) => n.matchSource === "embedding").length,
  };
}

function lastSegment(slug: string): string {
  const parts = slug.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function normQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Match generated nodes against the existing site, three tiers:
 *  1. exact_slug — a registry page whose path's last segment equals the
 *     node's suggested-slug last segment.
 *  2. top_query — a registry page whose GSC top query equals the node's
 *     canonical query (normalized).
 *  3. embedding — cosine between the node's (query + title) embedding and
 *     wp_posts body embeddings; best match above threshold wins.
 * Mutates `nodes` in place. Embedding tier is fail-soft.
 */
async function matchNodes(
  nodes: FlatNode[],
  site: SiteContext,
  budget: JobBudget,
): Promise<void> {
  const pages = await db
    .select({
      path: pagesTable.path,
      topQuery: pagesTable.topQuery,
    })
    .from(pagesTable)
    .where(eq(pagesTable.siteId, site.id));

  const bySegment = new Map<string, string>();
  const byQuery = new Map<string, string>();
  for (const p of pages) {
    const seg = lastSegment(p.path);
    if (seg && !bySegment.has(seg)) bySegment.set(seg, p.path);
    if (p.topQuery !== null) {
      const q = normQuery(p.topQuery);
      if (q && !byQuery.has(q)) byQuery.set(q, p.path);
    }
  }
  const pagePaths = new Set(pages.map((p) => p.path));

  const unmatched: FlatNode[] = [];
  for (const n of nodes) {
    const seg = lastSegment(n.meta.suggested_slug);
    const slugHit = seg ? bySegment.get(seg) : undefined;
    if (slugHit !== undefined) {
      n.matchedPagePath = slugHit;
      n.matchSource = "exact_slug";
      n.matchConfidence = null;
      continue;
    }
    const queryHit = byQuery.get(normQuery(n.meta.canonical_query));
    if (queryHit !== undefined) {
      n.matchedPagePath = queryHit;
      n.matchSource = "top_query";
      n.matchConfidence = null;
      continue;
    }
    unmatched.push(n);
  }
  if (unmatched.length === 0) return;

  // Embedding tier — load site embeddings once, compare in memory.
  try {
    const posts = await db
      .select({
        url: wpPostsTable.url,
        embedding: wpPostsTable.embedding,
      })
      .from(wpPostsTable)
      .where(and(eq(wpPostsTable.siteId, site.id), isNotNull(wpPostsTable.embedding)));
    const sitePosts = posts
      .map((p) => ({ path: canonicalPath(p.url, site.host), embedding: p.embedding }))
      .filter(
        (p): p is { path: string; embedding: number[] } =>
          p.path !== null && p.embedding !== null && pagePaths.has(p.path),
      );
    if (sitePosts.length === 0) return;

    if (!budget.take("llmCalls")) {
      logger.warn(
        { unmatched: unmatched.length },
        "LLM budget exhausted; skipping embedding match tier, leaving nodes unmatched",
      );
      return;
    }
    const inputs = unmatched.map((n, i) => ({
      id: i,
      text: `${n.meta.canonical_query}\n${n.meta.suggested_title}`,
    }));
    const vectors = await embedBatch(inputs);
    for (let i = 0; i < unmatched.length; i++) {
      const vec = vectors.get(i);
      if (!vec) continue;
      let bestPath: string | null = null;
      let bestSim = 0;
      for (const post of sitePosts) {
        const sim = cosineSim(vec, post.embedding);
        if (sim > bestSim) {
          bestSim = sim;
          bestPath = post.path;
        }
      }
      if (bestPath !== null && bestSim >= EMBED_MATCH_THRESHOLD) {
        const n = unmatched[i]!;
        n.matchedPagePath = bestPath;
        n.matchSource = "embedding";
        n.matchConfidence = Math.round(bestSim * 1000) / 1000;
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "Topical map embedding match tier failed; gaps kept as-is");
  }
}
