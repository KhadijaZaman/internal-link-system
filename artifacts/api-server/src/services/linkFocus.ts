import { and, eq, gte, sql, isNotNull, inArray } from "drizzle-orm";
import {
  db,
  inventoryTable,
  linkStatsTable,
  linkGraphTable,
  wpPostsTable,
  gscSnapshotsTable,
} from "@workspace/db";
import { cosineSim } from "../lib/semanticScorer";
import { sectionFor } from "../lib/sections";

const GSC_LOOKBACK_DAYS = 90;
const MAX_RECOMMENDATIONS = 12;
const MIN_RECOMMENDATION_SIM = 0.55;

export type FocusDirection = "inbound" | "outbound" | "both" | "recommended";

export interface FocusNeighbor {
  url: string;
  title: string | null;
  direction: FocusDirection;
  anchorTexts: string[];
  similarity: number;
  pagerank: number;
  gscClicks: number;
  gscImpressions: number;
  relevanceScore: number;
  prominenceScore: number;
  popularityScore: number;
  totalScore: number;
}

export interface FocusSeed {
  url: string;
  title: string | null;
  section: string;
  pagerank: number;
  inboundCount: number;
  outboundCount: number;
  gscClicks: number;
  gscImpressions: number;
  hasEmbedding: boolean;
}

export interface FocusResult {
  found: boolean;
  seed: FocusSeed | null;
  neighbors: FocusNeighbor[];
}

function normalize(u: string): string {
  try {
    const p = new URL(u);
    const path = p.pathname.replace(/\/+$/, "") || "/";
    return `${p.protocol}//${p.host}${path}`;
  } catch {
    return u;
  }
}

async function loadGscAggregates(): Promise<
  Map<string, { clicks: number; impressions: number }>
> {
  const cutoff = new Date(Date.now() - GSC_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .select({
      url: gscSnapshotsTable.url,
      clicks: sql<number>`COALESCE(SUM(${gscSnapshotsTable.clicks}), 0)::int`,
      impressions: sql<number>`COALESCE(SUM(${gscSnapshotsTable.impressions}), 0)::int`,
    })
    .from(gscSnapshotsTable)
    .where(gte(gscSnapshotsTable.snapshotDate, cutoff))
    .groupBy(gscSnapshotsTable.url);
  const m = new Map<string, { clicks: number; impressions: number }>();
  for (const r of rows) {
    m.set(r.url, {
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
    });
  }
  return m;
}

function popularityFromGsc(
  agg: { clicks: number; impressions: number } | undefined,
  maxLogClicks: number,
  maxLogImpr: number,
): number {
  if (!agg) return 0;
  const c = maxLogClicks > 0 ? Math.log1p(agg.clicks) / maxLogClicks : 0;
  const i = maxLogImpr > 0 ? Math.log1p(agg.impressions) / maxLogImpr : 0;
  return 0.7 * c + 0.3 * i;
}

export async function buildFocus(rawUrl: string): Promise<FocusResult> {
  const seedUrl = rawUrl.trim();
  if (!seedUrl) return { found: false, seed: null, neighbors: [] };
  const seedNorm = normalize(seedUrl);

  const [invRows, statRows, inboundEdges, outboundEdges, allPosts, gscAggs] =
    await Promise.all([
      db.select().from(inventoryTable).where(eq(inventoryTable.url, seedUrl)).limit(1),
      db.select().from(linkStatsTable).where(eq(linkStatsTable.url, seedUrl)).limit(1),
      // Focus view only considers content (body) edges — the goal is to
      // surface editorial linking relationships, not sitewide chrome.
      db
        .select()
        .from(linkGraphTable)
        .where(and(eq(linkGraphTable.targetUrl, seedUrl), eq(linkGraphTable.placement, "content"))),
      db
        .select()
        .from(linkGraphTable)
        .where(and(eq(linkGraphTable.sourceUrl, seedUrl), eq(linkGraphTable.placement, "content"))),
      db.select().from(wpPostsTable).where(isNotNull(wpPostsTable.embedding)),
      loadGscAggregates(),
    ]);

  const inv = invRows[0];
  const stat = statRows[0];
  const seedPost = allPosts.find((p) => normalize(p.url) === seedNorm) ?? null;

  if (!inv && !stat) {
    return { found: false, seed: null, neighbors: [] };
  }

  // Build neighbor URL set from existing edges
  const anchorMap = new Map<
    string,
    { dir: Set<FocusDirection>; anchors: Map<string, string> }
  >();
  const addAnchor = (url: string, dir: "inbound" | "outbound", anchor: string | null) => {
    let entry = anchorMap.get(url);
    if (!entry) {
      entry = { dir: new Set(), anchors: new Map() };
      anchorMap.set(url, entry);
    }
    entry.dir.add(dir);
    const a = anchor?.trim() ?? "";
    const lower = a.toLowerCase();
    if (a && lower !== "wp:auto" && lower !== "auto" && !entry.anchors.has(lower)) {
      entry.anchors.set(lower, a);
    }
  };
  for (const e of inboundEdges) addAnchor(e.sourceUrl, "inbound", e.anchorText);
  for (const e of outboundEdges) addAnchor(e.targetUrl, "outbound", e.anchorText);

  // Load inventory + linkStats rows for all neighbor URLs in one shot
  const neighborUrls = Array.from(anchorMap.keys());
  const [neighborInv, neighborStats] = await Promise.all([
    neighborUrls.length
      ? db.select().from(inventoryTable).where(inArray(inventoryTable.url, neighborUrls))
      : Promise.resolve([] as (typeof inventoryTable.$inferSelect)[]),
    neighborUrls.length
      ? db.select().from(linkStatsTable).where(inArray(linkStatsTable.url, neighborUrls))
      : Promise.resolve([] as (typeof linkStatsTable.$inferSelect)[]),
  ]);
  const invByUrl = new Map(neighborInv.map((r) => [r.url, r]));
  const statByUrl = new Map(neighborStats.map((r) => [r.url, r]));
  const postByNorm = new Map(allPosts.map((p) => [normalize(p.url), p]));

  // Build the raw neighbor list (existing + recommended)
  type Raw = {
    url: string;
    title: string | null;
    direction: FocusDirection;
    anchorTexts: string[];
    similarity: number;
    pagerank: number;
    gscClicks: number;
    gscImpressions: number;
  };

  const raws: Raw[] = [];

  for (const [url, info] of anchorMap.entries()) {
    const dir: FocusDirection =
      info.dir.has("inbound") && info.dir.has("outbound")
        ? "both"
        : info.dir.has("inbound")
          ? "inbound"
          : "outbound";
    const post = postByNorm.get(normalize(url)) ?? null;
    const sim = seedPost?.embedding && post?.embedding
      ? cosineSim(seedPost.embedding, post.embedding)
      : 0;
    const agg = gscAggs.get(url);
    raws.push({
      url,
      title: invByUrl.get(url)?.title ?? post?.title ?? null,
      direction: dir,
      anchorTexts: Array.from(info.anchors.values()).slice(0, 5),
      similarity: Math.max(0, sim),
      pagerank: statByUrl.get(url)?.internalPagerank ?? 0,
      gscClicks: agg?.clicks ?? 0,
      gscImpressions: agg?.impressions ?? 0,
    });
  }

  // Recommendations: top-similar wp_posts NOT already linked in either direction
  if (seedPost?.embedding) {
    const linkedNorm = new Set([
      seedNorm,
      ...Array.from(anchorMap.keys()).map((u) => normalize(u)),
    ]);
    const recScored: Array<Raw & { _sim: number }> = [];
    for (const p of allPosts) {
      if (!p.embedding) continue;
      const n = normalize(p.url);
      if (linkedNorm.has(n)) continue;
      const sim = cosineSim(seedPost.embedding, p.embedding);
      if (sim < MIN_RECOMMENDATION_SIM) continue;
      recScored.push({
        url: p.url,
        title: p.title ?? p.h1 ?? null,
        direction: "recommended",
        anchorTexts: [],
        similarity: sim,
        pagerank: 0,
        gscClicks: gscAggs.get(p.url)?.clicks ?? 0,
        gscImpressions: gscAggs.get(p.url)?.impressions ?? 0,
        _sim: sim,
      });
    }
    recScored.sort((a, b) => b._sim - a._sim);
    // Fill pagerank for recs (lookup linkStats for top N)
    const top = recScored.slice(0, MAX_RECOMMENDATIONS);
    if (top.length) {
      const recUrls = top.map((r) => r.url);
      const recStats = await db
        .select()
        .from(linkStatsTable)
        .where(inArray(linkStatsTable.url, recUrls));
      const recStatMap = new Map(recStats.map((r) => [r.url, r]));
      for (const r of top) {
        r.pagerank = recStatMap.get(r.url)?.internalPagerank ?? 0;
      }
    }
    raws.push(...top.map(({ _sim: _, ...rest }) => rest));
  }

  // Normalize prominence + popularity over the combined set
  const maxPagerank = raws.reduce((m, r) => Math.max(m, r.pagerank), 0);
  let maxLogClicks = 0;
  let maxLogImpr = 0;
  for (const r of raws) {
    maxLogClicks = Math.max(maxLogClicks, Math.log1p(r.gscClicks));
    maxLogImpr = Math.max(maxLogImpr, Math.log1p(r.gscImpressions));
  }

  const neighbors: FocusNeighbor[] = raws.map((r) => {
    const prominence = maxPagerank > 0 ? r.pagerank / maxPagerank : 0;
    const popularity = popularityFromGsc(
      { clicks: r.gscClicks, impressions: r.gscImpressions },
      maxLogClicks,
      maxLogImpr,
    );
    const relevance = r.similarity;
    const total = 0.5 * relevance + 0.25 * prominence + 0.25 * popularity;
    return {
      url: r.url,
      title: r.title,
      direction: r.direction,
      anchorTexts: r.anchorTexts,
      similarity: relevance,
      pagerank: r.pagerank,
      gscClicks: r.gscClicks,
      gscImpressions: r.gscImpressions,
      relevanceScore: relevance,
      prominenceScore: prominence,
      popularityScore: popularity,
      totalScore: total,
    };
  });

  neighbors.sort((a, b) => b.totalScore - a.totalScore);

  const seedGsc = gscAggs.get(seedUrl);
  const seed: FocusSeed = {
    url: seedUrl,
    title: inv?.title ?? seedPost?.title ?? null,
    section: inv?.section ?? sectionFor(seedUrl),
    pagerank: stat?.internalPagerank ?? 0,
    inboundCount: stat?.inboundCount ?? inboundEdges.length,
    outboundCount: stat?.outboundCount ?? outboundEdges.length,
    gscClicks: seedGsc?.clicks ?? inv?.clicks ?? 0,
    gscImpressions: seedGsc?.impressions ?? inv?.impressions ?? 0,
    hasEmbedding: !!seedPost?.embedding,
  };

  return { found: true, seed, neighbors };
}
