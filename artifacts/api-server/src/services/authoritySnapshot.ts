import { sql, desc, isNotNull, inArray, eq } from "drizzle-orm";
import {
  db,
  linkStatsTable,
  wpPostsTable,
  queryIntelTable,
  gscSnapshotsTable,
  pageClassificationsTable,
  linkExcludeListTable,
} from "@workspace/db";
import { cosineSim } from "../lib/semanticScorer";
import { compilePattern, isExcluded } from "../jobs/semanticLinking";
import { embedBatch } from "../integrations/openaiEmbed";
import { logger } from "../lib/logger";

/**
 * Default cosine threshold separating on-core from off-core query demand.
 *
 * Empirically tuned against the live corpus (text-embedding-3-small produces
 * compressed cosines — related-but-distinct topics cluster ~0.3-0.65). At 0.42
 * the off-core "startup / business ideas" lead-magnet family (~0.25-0.34)
 * cleanly separates from genuine on-core SEO / AI-visibility service demand
 * (~0.42-0.67). Callers may override via the `threshold` argument.
 */
export const DEFAULT_CORE_THRESHOLD = 0.42;

/** How many top pagerank pages define the central-entity centroid. */
const CENTROID_PAGE_COUNT = 20;

/** How many top queries by impressions we analyse for on/off-core demand. */
const TOP_QUERY_COUNT = 300;

/**
 * Cap on how many *new* query embeddings we create in a single snapshot run so
 * a cold cache can't blow through OpenAI quota in one shot. Already-embedded
 * queries are never re-embedded; re-runs progressively fill the rest.
 */
const MAX_NEW_EMBEDDINGS = 300;

/** Author archive pages are listing pages, not central-entity content. */
const AUTHOR_ARCHIVE_RE = /\/author\//i;

export interface AnchorPage {
  url: string;
  title: string | null;
  internalPagerank: number;
  inboundCount: number;
  tier: number | null;
}

export interface DemandQuery {
  query: string;
  impressions: number;
  similarity: number;
}

export interface AuthoritySnapshot {
  generatedAt: string;
  threshold: number;
  health: {
    totalPages: number;
    pagesWithEmbedding: number;
    pagesTracked: number;
    orphanCount: number;
    deadEndCount: number;
    totalInternalLinks: number;
    avgInternalPagerank: number;
    lastCrawledAt: string | null;
  };
  centralEntity: {
    label: string | null;
    anchorPageCount: number;
    anchorPages: AnchorPage[];
  };
  demand: {
    queriesAnalyzed: number;
    totalImpressions: number;
    onCore: { queryCount: number; impressions: number; impressionsPct: number };
    offCore: { queryCount: number; impressions: number; impressionsPct: number };
    worstOffenders: DemandQuery[];
    topOnCore: DemandQuery[];
  };
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * Build the central-entity centroid as the pagerank-weighted mean of the
 * embeddings of the top pages by internal pagerank, excluding author archives,
 * exclude-list patterns (pricing / legal / terms), and pages without an
 * embedding. Returns the centroid vector plus the anchor pages used as
 * human-readable evidence of what the site is topically "about".
 */
async function buildCentroid(): Promise<{
  centroid: number[] | null;
  anchorPages: AnchorPage[];
}> {
  const [stats, posts, classifications, excludes] = await Promise.all([
    db.select().from(linkStatsTable).orderBy(desc(linkStatsTable.internalPagerank)),
    db
      .select({
        url: wpPostsTable.url,
        title: wpPostsTable.title,
        embedding: wpPostsTable.embedding,
      })
      .from(wpPostsTable)
      .where(isNotNull(wpPostsTable.embedding)),
    db
      .select({
        url: pageClassificationsTable.url,
        tier: pageClassificationsTable.tier,
        centralEntity: pageClassificationsTable.centralEntity,
      })
      .from(pageClassificationsTable),
    db.select().from(linkExcludeListTable),
  ]);

  const excludeRegexes = excludes.map((e) => compilePattern(e.pattern));
  const postByUrl = new Map(posts.map((p) => [p.url, p]));
  const classByUrl = new Map(classifications.map((c) => [c.url, c]));

  const anchorPages: AnchorPage[] = [];
  const vectors: { vec: number[]; weight: number }[] = [];
  for (const s of stats) {
    if (anchorPages.length >= CENTROID_PAGE_COUNT) break;
    if (isExcluded(s.url, excludeRegexes)) continue;
    if (AUTHOR_ARCHIVE_RE.test(s.url)) continue;
    const post = postByUrl.get(s.url);
    if (!post?.embedding) continue;
    const cls = classByUrl.get(s.url);
    anchorPages.push({
      url: s.url,
      title: post.title ?? null,
      internalPagerank: s.internalPagerank,
      inboundCount: s.inboundCount,
      tier: cls?.tier ?? null,
    });
    vectors.push({ vec: post.embedding, weight: Math.max(s.internalPagerank, 0) });
  }

  if (vectors.length === 0) return { centroid: null, anchorPages };

  const dim = vectors[0]!.vec.length;
  const centroid = new Array<number>(dim).fill(0);
  let weightSum = 0;
  for (const { vec, weight } of vectors) {
    const w = weight > 0 ? weight : 1e-9;
    weightSum += w;
    for (let i = 0; i < dim; i++) centroid[i]! += vec[i]! * w;
  }
  for (let i = 0; i < dim; i++) centroid[i]! /= weightSum;

  return { centroid, anchorPages };
}

/** Most common non-null central-entity label among the anchor pages. */
function dominantLabel(
  anchorPages: AnchorPage[],
  classByUrl: Map<string, string | null>,
): string | null {
  const counts = new Map<string, number>();
  for (const p of anchorPages) {
    const label = classByUrl.get(p.url);
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [label, n] of counts) {
    if (n > bestN) {
      best = label;
      bestN = n;
    }
  }
  return best;
}

/**
 * Ensure embeddings exist for the given queries (insert-if-missing, embed the
 * missing ones in batch, capped per run). Never re-embeds a query that already
 * has a vector. Returns a Map of query → embedding for those that have one.
 */
async function ensureQueryEmbeddings(
  queries: string[],
): Promise<Map<string, number[]>> {
  const byQuery = new Map<string, number[]>();
  if (queries.length === 0) return byQuery;

  await db
    .insert(queryIntelTable)
    .values(queries.map((query) => ({ query })))
    .onConflictDoNothing();

  const rows = await db
    .select({ query: queryIntelTable.query, embedding: queryIntelTable.embedding })
    .from(queryIntelTable)
    .where(inArray(queryIntelTable.query, queries));
  for (const r of rows) {
    if (r.embedding) byQuery.set(r.query, r.embedding);
  }

  const missing = queries.filter((q) => !byQuery.has(q)).slice(0, MAX_NEW_EMBEDDINGS);
  if (missing.length > 0) {
    try {
      const embedded = await embedBatch(
        missing.map((q) => ({ id: q, text: q })),
        4,
      );
      const now = new Date();
      for (const [q, vec] of embedded.entries()) {
        const query = q as string;
        await db
          .update(queryIntelTable)
          .set({ embedding: vec, embeddedAt: now })
          .where(eq(queryIntelTable.query, query));
        byQuery.set(query, vec);
      }
      logger.info(
        { embedded: embedded.size, requested: missing.length },
        "authoritySnapshot: query embeddings refreshed",
      );
    } catch (e) {
      logger.warn({ err: e }, "authoritySnapshot: embedding batch failed");
    }
  }

  return byQuery;
}

export async function computeAuthoritySnapshot(
  threshold: number = DEFAULT_CORE_THRESHOLD,
): Promise<AuthoritySnapshot> {
  const { centroid, anchorPages } = await buildCentroid();

  const classRows = await db
    .select({
      url: pageClassificationsTable.url,
      centralEntity: pageClassificationsTable.centralEntity,
    })
    .from(pageClassificationsTable);
  const labelByUrl = new Map(classRows.map((c) => [c.url, c.centralEntity]));
  const label = dominantLabel(anchorPages, labelByUrl);

  // Health metrics from the crawl + link graph.
  const [wpAgg] = await db
    .select({
      totalPages: sql<number>`count(*)::int`,
      pagesWithEmbedding: sql<number>`count(${wpPostsTable.embedding})::int`,
      lastCrawledAt: sql<Date | null>`max(${wpPostsTable.crawledAt})`,
    })
    .from(wpPostsTable);
  const [lsAgg] = await db
    .select({
      pagesTracked: sql<number>`count(*)::int`,
      orphanCount: sql<number>`count(*) filter (where ${linkStatsTable.isOrphan})::int`,
      deadEndCount: sql<number>`count(*) filter (where ${linkStatsTable.isDeadEnd})::int`,
      totalInternalLinks: sql<number>`coalesce(sum(${linkStatsTable.outboundCount}), 0)::int`,
      avgInternalPagerank: sql<number>`coalesce(avg(${linkStatsTable.internalPagerank}), 0)::float8`,
    })
    .from(linkStatsTable);

  // Top queries by impressions (normalised to match query_intel keys).
  const topQ = await db
    .select({
      query: sql<string>`lower(trim(${gscSnapshotsTable.query}))`,
      impressions: sql<number>`sum(${gscSnapshotsTable.impressions})::int`,
    })
    .from(gscSnapshotsTable)
    .where(isNotNull(gscSnapshotsTable.query))
    .groupBy(sql`lower(trim(${gscSnapshotsTable.query}))`)
    .orderBy(sql`sum(${gscSnapshotsTable.impressions}) desc`)
    .limit(TOP_QUERY_COUNT);

  const impByQuery = new Map<string, number>();
  for (const r of topQ) {
    const q = r.query?.trim();
    if (q) impByQuery.set(q, Number(r.impressions) || 0);
  }
  const queries = Array.from(impByQuery.keys());

  const embByQuery = centroid ? await ensureQueryEmbeddings(queries) : new Map<string, number[]>();

  const scored: DemandQuery[] = [];
  if (centroid) {
    for (const q of queries) {
      const emb = embByQuery.get(q);
      if (!emb) continue;
      scored.push({
        query: q,
        impressions: impByQuery.get(q) ?? 0,
        similarity: Math.round(cosineSim(emb, centroid) * 1000) / 1000,
      });
    }
  }

  const onCore = scored.filter((s) => s.similarity >= threshold);
  const offCore = scored.filter((s) => s.similarity < threshold);
  const onImp = onCore.reduce((a, s) => a + s.impressions, 0);
  const offImp = offCore.reduce((a, s) => a + s.impressions, 0);
  const totalImp = onImp + offImp;

  const byImpDesc = (a: DemandQuery, b: DemandQuery): number =>
    b.impressions - a.impressions;

  return {
    generatedAt: new Date().toISOString(),
    threshold,
    health: {
      totalPages: wpAgg?.totalPages ?? 0,
      pagesWithEmbedding: wpAgg?.pagesWithEmbedding ?? 0,
      pagesTracked: lsAgg?.pagesTracked ?? 0,
      orphanCount: lsAgg?.orphanCount ?? 0,
      deadEndCount: lsAgg?.deadEndCount ?? 0,
      totalInternalLinks: lsAgg?.totalInternalLinks ?? 0,
      avgInternalPagerank: lsAgg?.avgInternalPagerank ?? 0,
      lastCrawledAt: wpAgg?.lastCrawledAt
        ? new Date(wpAgg.lastCrawledAt).toISOString()
        : null,
    },
    centralEntity: {
      label,
      anchorPageCount: anchorPages.length,
      anchorPages,
    },
    demand: {
      queriesAnalyzed: scored.length,
      totalImpressions: totalImp,
      onCore: {
        queryCount: onCore.length,
        impressions: onImp,
        impressionsPct: pct(onImp, totalImp),
      },
      offCore: {
        queryCount: offCore.length,
        impressions: offImp,
        impressionsPct: pct(offImp, totalImp),
      },
      worstOffenders: offCore.sort(byImpDesc).slice(0, 15),
      topOnCore: onCore.sort(byImpDesc).slice(0, 15),
    },
  };
}
