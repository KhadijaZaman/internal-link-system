import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  wpPostsTable,
  optimizeQueueTable,
  linkGraphTable,
  linkStatsTable,
  inventoryTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";

const router: IRouter = Router();

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const MAX_ANCHORS = 5;

function parseDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.trunc(n)));
}

/** Build a url -> title lookup from wp_posts (preferred) then inventory. */
async function loadTitles(siteId: number, urls: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (urls.length === 0) return map;
  const unique = Array.from(new Set(urls));
  const [posts, inv] = await Promise.all([
    db
      .select({ url: wpPostsTable.url, title: wpPostsTable.title, h1: wpPostsTable.h1 })
      .from(wpPostsTable)
      .where(and(eq(wpPostsTable.siteId, siteId), inArray(wpPostsTable.url, unique))),
    db
      .select({ url: inventoryTable.url, title: inventoryTable.title })
      .from(inventoryTable)
      .where(and(eq(inventoryTable.siteId, siteId), inArray(inventoryTable.url, unique))),
  ]);
  // wp_posts is the crawl source of truth, so it wins; inventory only fills gaps.
  for (const p of posts) {
    const t = p.title ?? p.h1 ?? null;
    if (t) map.set(p.url, t);
  }
  for (const r of inv) {
    if (!map.get(r.url) && r.title) map.set(r.url, r.title);
  }
  return map;
}

/**
 * Daily activity feed: pages PUBLISHED (wp_posts.publish_date) and pages
 * OPTIMIZED (optimize_queue rows that actually completed, status = "done").
 * "skipped_no_gsc" rows also stamp completed_at but are NOT optimizations, so
 * they are excluded. Items are returned newest-first; the client groups by day.
 */
router.get("/alerts/daily", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const days = parseDays(req.query.days);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [published, optimized] = await Promise.all([
    db
      .select({
        url: wpPostsTable.url,
        title: wpPostsTable.title,
        publishDate: wpPostsTable.publishDate,
      })
      .from(wpPostsTable)
      .where(
        and(
          eq(wpPostsTable.siteId, site.id),
          isNotNull(wpPostsTable.publishDate),
          gte(wpPostsTable.publishDate, cutoff),
        ),
      )
      .orderBy(desc(wpPostsTable.publishDate)),
    db
      .select({
        url: optimizeQueueTable.url,
        completedAt: optimizeQueueTable.completedAt,
      })
      .from(optimizeQueueTable)
      .where(
        and(
          eq(optimizeQueueTable.siteId, site.id),
          eq(optimizeQueueTable.status, "done"),
          isNotNull(optimizeQueueTable.completedAt),
          gte(optimizeQueueTable.completedAt, cutoff),
        ),
      )
      .orderBy(desc(optimizeQueueTable.completedAt)),
  ]);

  const titles = await loadTitles(site.id, optimized.map((o) => o.url));

  type Item = {
    kind: "published" | "optimized";
    url: string;
    title: string | null;
    timestamp: string;
  };
  const items: Item[] = [];

  for (const p of published) {
    if (!p.publishDate) continue;
    items.push({
      kind: "published",
      url: p.url,
      title: p.title ?? null,
      timestamp: p.publishDate.toISOString(),
    });
  }
  for (const o of optimized) {
    if (!o.completedAt) continue;
    items.push({
      kind: "optimized",
      url: o.url,
      title: titles.get(o.url) ?? null,
      timestamp: o.completedAt.toISOString(),
    });
  }

  items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  res.json({ generatedAt: new Date().toISOString(), items });
});

/**
 * Same-domain in-body internal link breakdown for a single URL.
 *  - outgoing = in-body links this page points to (internal links).
 *  - incoming = in-body links from other pages pointing back (internal backlinks).
 * Only content-placement edges count; nav/header/footer/sidebar chrome is excluded.
 * outgoingCount/incomingCount are content-edge counts sourced from link_stats —
 * the same source of truth the Link Map focus view uses for its seed chips — so
 * the two surfaces always report identical numbers. The lists below group those
 * edges by neighbor page (anchors merged) for display.
 */
router.get("/alerts/url-links", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  const [outboundEdges, inboundEdges, statRows] = await Promise.all([
    db
      .select({ neighbor: linkGraphTable.targetUrl, anchorText: linkGraphTable.anchorText })
      .from(linkGraphTable)
      .where(
        and(
          eq(linkGraphTable.siteId, site.id),
          eq(linkGraphTable.sourceUrl, url),
          eq(linkGraphTable.placement, "content"),
        ),
      ),
    db
      .select({ neighbor: linkGraphTable.sourceUrl, anchorText: linkGraphTable.anchorText })
      .from(linkGraphTable)
      .where(
        and(
          eq(linkGraphTable.siteId, site.id),
          eq(linkGraphTable.targetUrl, url),
          eq(linkGraphTable.placement, "content"),
        ),
      ),
    db
      .select({
        inboundCount: linkStatsTable.inboundCount,
        outboundCount: linkStatsTable.outboundCount,
      })
      .from(linkStatsTable)
      .where(and(eq(linkStatsTable.siteId, site.id), eq(linkStatsTable.url, url)))
      .limit(1),
  ]);

  const titles = await loadTitles(site.id, [
    ...outboundEdges.map((e) => e.neighbor),
    ...inboundEdges.map((e) => e.neighbor),
  ]);

  const group = (edges: { neighbor: string; anchorText: string | null }[]) => {
    const byUrl = new Map<string, Map<string, string>>();
    for (const e of edges) {
      let anchors = byUrl.get(e.neighbor);
      if (!anchors) {
        anchors = new Map();
        byUrl.set(e.neighbor, anchors);
      }
      const a = e.anchorText?.trim() ?? "";
      const lower = a.toLowerCase();
      if (a && lower !== "wp:auto" && lower !== "auto" && !anchors.has(lower)) {
        anchors.set(lower, a);
      }
    }
    return Array.from(byUrl.entries()).map(([neighborUrl, anchors]) => ({
      url: neighborUrl,
      title: titles.get(neighborUrl) ?? null,
      anchorTexts: Array.from(anchors.values()).slice(0, MAX_ANCHORS),
    }));
  };

  const outgoing = group(outboundEdges);
  const incoming = group(inboundEdges);

  // Counts come from link_stats (COUNT(*) of content edges) — the same source
  // the Link Map focus view uses — so both surfaces agree. Fall back to the raw
  // content-edge counts when no stats row exists yet (mirrors buildFocus()).
  const stat = statRows[0];
  const outgoingCount = stat?.outboundCount ?? outboundEdges.length;
  const incomingCount = stat?.inboundCount ?? inboundEdges.length;

  res.json({
    url,
    outgoingCount,
    incomingCount,
    outgoing,
    incoming,
  });
});

export default router;
