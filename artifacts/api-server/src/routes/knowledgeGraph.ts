import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  inventoryTable,
  linkStatsTable,
  linkGraphTable,
  wpPostsTable,
  queryLosersTable,
  actionItemsTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { louvain } from "../lib/louvain";
import { sectionFor } from "../lib/sections";
import { canonicalPath } from "../lib/urlCanon";
import { countContentPages, CONTENT_PAGES_FILTER_LABEL } from "../services/pageCounts";

const router: IRouter = Router();

/**
 * Minimum cosine similarity for a semantic edge. Embeddings from
 * text-embedding-3-small produce compressed cosines (on/off-topic splits
 * around ~0.42), so 0.45 keeps only genuinely related page pairs while
 * still surfacing cross-cluster bridges.
 */
const SEMANTIC_THRESHOLD = 0.45;
/** Top-K nearest neighbors considered per embedded page. */
const SEMANTIC_TOP_K = 6;
/** Clusters smaller than this are folded into a "Miscellaneous" bucket. */
const MIN_CLUSTER_SIZE = 3;
/**
 * Louvain resolution. 1.0 is standard modularity; raise above 1 if the
 * clustering ever collapses into too-few communities as the site grows.
 */
const LOUVAIN_RESOLUTION = 1.0;

/**
 * Normalize URL for cross-table matching (wp_posts vs link_stats forms).
 * Uses the shared canonicalizer so fragment/query/slash variants land on
 * the same node; falls back to simple cleanup for non-site URLs.
 */
function norm(url: string): string {
  const p = canonicalPath(url);
  if (p !== null) return p;
  return url.replace(/\/+$/, "").toLowerCase();
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

const STOP_TOKENS = new Set([
  "the", "and", "for", "with", "your", "you", "what", "how", "why", "when",
  "who", "can", "are", "does", "into", "from", "that", "this", "them",
  "guide", "best", "top", "vs", "versus", "a", "an", "of", "to", "in", "on",
  "is", "it", "its", "do", "not", "get", "use", "using", "2024", "2025",
  "2026", "com", "www",
]);

/** Human-readable topic label from member URLs (slug token frequency). */
function clusterLabel(
  memberUrls: string[],
  titleOf: (url: string) => string | null,
  rankOf: (url: string) => number,
  used: Set<string>,
): string {
  const counts = new Map<string, number>();
  for (const url of memberUrls) {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      path = url;
    }
    const seg = path.split("/").filter(Boolean).pop() ?? "";
    const seen = new Set<string>();
    for (const tok of seg.split(/[-_]/)) {
      const t = tok.toLowerCase();
      if (t.length < 3 || STOP_TOKENS.has(t) || /^\d+$/.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 4)
    .map(([t]) => t.charAt(0).toUpperCase() + t.slice(1));
  const take = (label: string): string => {
    used.add(label);
    return label;
  };
  // Try progressively longer token combos until the label is unique.
  for (let len = 2; len <= ranked.length; len++) {
    const candidate = ranked.slice(0, len).join(" · ");
    if (!used.has(candidate)) return take(candidate);
  }
  // Fallback: title of the highest-pagerank member.
  const top = [...memberUrls].sort((a, b) => rankOf(b) - rankOf(a))[0];
  const title = top ? titleOf(top) : null;
  if (title) {
    const t = title.length > 40 ? `${title.slice(0, 37)}…` : title;
    if (!used.has(t)) return take(t);
  }
  // Last resort: numeric suffix on the token label.
  const base = ranked.length > 0 ? ranked.slice(0, 2).join(" · ") : "Topic";
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!used.has(candidate)) return take(candidate);
  }
}

router.get("/knowledge-graph", requireAuth, async (_req, res) => {
  const [stats, inv, contentLinks, semRes, embStats, canonicalPageCount, loserRows, actionRows] = await Promise.all([
    db.select().from(linkStatsTable),
    db.select().from(inventoryTable),
    db
      .select({
        sourceUrl: linkGraphTable.sourceUrl,
        targetUrl: linkGraphTable.targetUrl,
      })
      .from(linkGraphTable)
      .where(eq(linkGraphTable.placement, "content")),
    db.execute(sql`
      SELECT a.url AS source, n.url AS target,
             1 - (a.embedding <=> n.embedding) AS sim
      FROM wp_posts a
      JOIN LATERAL (
        SELECT b.url, b.embedding
        FROM wp_posts b
        WHERE b.url <> a.url AND b.embedding IS NOT NULL
        ORDER BY b.embedding <=> a.embedding
        LIMIT ${SEMANTIC_TOP_K}
      ) n ON true
      WHERE a.embedding IS NOT NULL
    `) as unknown as Promise<{
      rows: Array<{ source: string; target: string; sim: string | number }>;
    }>,
    db
      .select({
        total: sql<number>`count(*)::int`,
        embedded: sql<number>`count(${wpPostsTable.embedding})::int`,
      })
      .from(wpPostsTable),
    countContentPages(),
    db
      .select({ url: queryLosersTable.url, severity: queryLosersTable.severity })
      .from(queryLosersTable)
      .where(
        eq(queryLosersTable.weekOf, sql`(SELECT max(week_of) FROM query_losers)`),
      ),
    db
      .select({
        targetUrl: actionItemsTable.targetUrl,
        n: sql<number>`count(*)::int`,
      })
      .from(actionItemsTable)
      .where(eq(actionItemsTable.status, "open"))
      .groupBy(actionItemsTable.targetUrl),
  ]);

  const invMap = new Map(inv.map((i) => [i.url, i]));
  const nodes = stats.map((s) => {
    const i = invMap.get(s.url);
    return {
      id: s.url,
      title: i?.title ?? null,
      section: i?.section ?? sectionFor(s.url),
      clusterId: 0, // assigned below
      pagerank: s.internalPagerank,
      inboundCount: s.inboundCount,
      outboundCount: s.outboundCount,
      impressions: i?.impressions ?? null,
      clicks: i?.clicks ?? null,
      topQuery: i?.topQuery ?? null,
      hasEmbedding: false, // assigned below
      loserSeverity: null as string | null, // assigned below
      openActions: 0, // assigned below
    };
  });

  // Map normalized URL -> canonical node id so wp_posts URL forms
  // (trailing slash, case) still land on the right node.
  const normToId = new Map<string, string>();
  for (const n of nodes) {
    if (!normToId.has(norm(n.id))) normToId.set(norm(n.id), n.id);
  }

  // Undirected content-link pairs.
  const linkPairs = new Set<string>();
  for (const e of contentLinks) {
    const a = normToId.get(norm(e.sourceUrl));
    const b = normToId.get(norm(e.targetUrl));
    if (!a || !b || a === b) continue;
    linkPairs.add(pairKey(a, b));
  }

  // Undirected semantic pairs above threshold (keep the max similarity).
  const semPairs = new Map<string, number>();
  const embeddedIds = new Set<string>();
  for (const r of semRes.rows) {
    const simNum = typeof r.sim === "number" ? r.sim : parseFloat(r.sim);
    const a = normToId.get(norm(r.source));
    const b = normToId.get(norm(r.target));
    if (a) embeddedIds.add(a);
    if (b) embeddedIds.add(b);
    if (!a || !b || a === b) continue;
    if (!Number.isFinite(simNum) || simNum < SEMANTIC_THRESHOLD) continue;
    const k = pairKey(a, b);
    semPairs.set(k, Math.max(semPairs.get(k) ?? 0, simNum));
  }
  for (const n of nodes) {
    if (embeddedIds.has(n.id)) n.hasEmbedding = true;
  }

  // ---- Issue overlay: worst latest-week loser severity + open action items. ----
  const SEV_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
  const nodeById2 = new Map(nodes.map((n) => [n.id, n]));
  for (const l of loserRows) {
    const id = normToId.get(norm(l.url));
    if (!id) continue;
    const sev = (l.severity ?? "low").toLowerCase();
    const rank = SEV_RANK[sev] ?? 0;
    const node = nodeById2.get(id);
    if (!node) continue;
    const cur = node.loserSeverity;
    if (cur === null || rank > (SEV_RANK[cur] ?? 0)) {
      node.loserSeverity = sev in SEV_RANK ? sev : "low";
    }
  }
  for (const a of actionRows) {
    const id = normToId.get(norm(a.targetUrl));
    if (!id) continue;
    const node = nodeById2.get(id);
    if (node) node.openActions += a.n;
  }

  // Combined edge list with kind.
  const edges: Array<{
    source: string;
    target: string;
    kind: "link" | "semantic" | "both";
    similarity: number | null;
  }> = [];
  for (const k of linkPairs) {
    const [a, b] = k.split("\u0000");
    const sim = semPairs.get(k);
    edges.push({
      source: a,
      target: b,
      kind: sim !== undefined ? "both" : "link",
      similarity: sim !== undefined ? Math.round(sim * 1000) / 1000 : null,
    });
  }
  for (const [k, sim] of semPairs) {
    if (linkPairs.has(k)) continue;
    const [a, b] = k.split("\u0000");
    edges.push({
      source: a,
      target: b,
      kind: "semantic",
      similarity: Math.round(sim * 1000) / 1000,
    });
  }

  // ---- Topic clustering: deterministic Louvain modularity detection. ----
  // Semantic edges weigh more than plain link edges because they encode
  // topical relatedness rather than navigation habits.
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const louvainLinks: Array<[number, number, number]> = edges.map((e) => [
    idx.get(e.source)!,
    idx.get(e.target)!,
    e.kind === "link" ? 1 : e.kind === "both" ? 3 : 2,
  ]);
  const labels = louvain(nodes.length, louvainLinks, LOUVAIN_RESOLUTION);

  // Group by final label; fold tiny clusters into "Miscellaneous".
  const groups = new Map<number, number[]>();
  labels.forEach((lab, i) => {
    const g = groups.get(lab);
    if (g) g.push(i);
    else groups.set(lab, [i]);
  });
  const rankOf = (url: string) => {
    const i = idx.get(url);
    return i === undefined ? 0 : nodes[i].pagerank;
  };
  const titleOf = (url: string) => {
    const i = idx.get(url);
    return i === undefined ? null : nodes[i].title;
  };
  const bigGroups = [...groups.entries()]
    .filter(([, members]) => members.length >= MIN_CLUSTER_SIZE)
    .sort((a, b) => b[1].length - a[1].length);
  const clusters: Array<{ id: number; label: string; size: number }> = [];
  const usedLabels = new Set<string>(["Miscellaneous"]);
  bigGroups.forEach(([, members], ci) => {
    for (const m of members) nodes[m].clusterId = ci;
    clusters.push({
      id: ci,
      label: clusterLabel(
        members.map((m) => nodes[m].id),
        titleOf,
        rankOf,
        usedLabels,
      ),
      size: members.length,
    });
  });
  const miscMembers = [...groups.entries()]
    .filter(([, members]) => members.length < MIN_CLUSTER_SIZE)
    .flatMap(([, members]) => members);
  if (miscMembers.length > 0) {
    const miscId = clusters.length;
    for (const m of miscMembers) nodes[m].clusterId = miscId;
    clusters.push({ id: miscId, label: "Miscellaneous", size: miscMembers.length });
  }

  res.json({
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    clusters,
    embeddedPages: embStats[0]?.embedded ?? 0,
    totalPosts: embStats[0]?.total ?? 0,
    totalPages: canonicalPageCount,
    pageFilterLabel: CONTENT_PAGES_FILTER_LABEL,
  });
});

export default router;
