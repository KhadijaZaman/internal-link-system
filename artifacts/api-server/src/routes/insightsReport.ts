import { Router, type IRouter } from "express";
import {
  db,
  pagesTable,
  inventoryTable,
  auditReportsTable,
  clusterRunsTable,
  clusterRunClustersTable,
  linkStatsTable,
  wpPostsTable,
  digestsTable,
} from "@workspace/db";
import { and, eq, desc, or, sql, inArray } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite, type SiteContext } from "../lib/site";
import { queryGsc, gscSiteUrl, withCache } from "../integrations/gsc";
import { fetchTopReferringDomains } from "../integrations/dataforseo";
import { isOperatorQuery } from "../services/clustering";
import { canonicalPath, isBlockedPath, loadBlockRegexes } from "../lib/urlCanon";
import type { DigestPayload } from "../services/digest";

const router: IRouter = Router();

const REPORT_CACHE_TTL_MS = 30 * 60 * 1000;

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Section 1 + 3 share one GSC pull: query+page rows over a stable 28d window.
// ---------------------------------------------------------------------------

interface QueryAgg {
  query: string;
  impressions: number;
  clicks: number;
  posWeighted: number;
  posWeight: number;
  bestPath: string | null;
  bestImpressions: number;
}

async function pullQueryAggregates(site: SiteContext, startDate: string, endDate: string) {
  const rows = await queryGsc({
    siteId: site.id,
    startDate,
    endDate,
    dimensions: ["query", "page"],
    rowLimit: 5000,
  });
  const byQuery = new Map<string, QueryAgg>();
  for (const r of rows) {
    const q = r.query.trim().toLowerCase();
    if (!q || isOperatorQuery(q)) continue;
    let agg = byQuery.get(q);
    if (!agg) {
      agg = { query: q, impressions: 0, clicks: 0, posWeighted: 0, posWeight: 0, bestPath: null, bestImpressions: -1 };
      byQuery.set(q, agg);
    }
    agg.impressions += r.impressions;
    agg.clicks += r.clicks;
    agg.posWeighted += r.position * Math.max(r.impressions, 1);
    agg.posWeight += Math.max(r.impressions, 1);
    if (r.impressions > agg.bestImpressions) {
      agg.bestImpressions = r.impressions;
      agg.bestPath = r.url ? canonicalPath(r.url, site.host) : null;
    }
  }
  return [...byQuery.values()].map((a) => ({
    ...a,
    position: a.posWeighted / Math.max(a.posWeight, 1),
  }));
}

const NEAR_MISS_MIN_IMPRESSIONS = 10;
const GAP_MIN_IMPRESSIONS = 20;

function buildNearMiss(aggs: Array<QueryAgg & { position: number }>, windowStart: string, windowEnd: string) {
  const candidates = aggs.filter(
    (a) => a.position >= 5 && a.position <= 15 && a.impressions >= NEAR_MISS_MIN_IMPRESSIONS,
  );
  const queries = candidates
    .map((a) => ({
      query: a.query,
      position: Math.round(a.position * 10) / 10,
      impressions: a.impressions,
      clicks: a.clicks,
      // Position × volume: impressions weighted by how close to page 1 top.
      score: Math.round(a.impressions * (16 - a.position)),
      page2: a.position > 10,
      bestPath: a.bestPath,
    }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 20);
  return {
    available: true,
    note: null,
    windowStart,
    windowEnd,
    totalCandidates: candidates.length,
    queries,
  };
}

function buildContentGaps(aggs: Array<QueryAgg & { position: number }>, windowStart: string, windowEnd: string) {
  const gaps = aggs
    .filter((a) => a.position > 15 && a.impressions >= GAP_MIN_IMPRESSIONS)
    .sort((x, y) => y.impressions - x.impressions)
    .slice(0, 15)
    .map((a) => ({
      query: a.query,
      impressions: a.impressions,
      clicks: a.clicks,
      position: Math.round(a.position * 10) / 10,
      bestPath: a.bestPath,
    }));
  return { available: true, note: null, windowStart, windowEnd, gaps };
}

// ---------------------------------------------------------------------------
// Section 2 — intent clusters from the latest complete clustering run.
// ---------------------------------------------------------------------------

const COMMERCIAL_RE =
  /\b(best|top|vs|versus|alternative|alternatives|competitor|competitors|price|pricing|cost|costs|buy|review|reviews|tool|tools|software|platform|platforms|agency|agencies|service|services|cheap|cheaper|cheapest|comparison|compare|deal|deals|discount|coupon|hire|solution|solutions)\b/i;

async function buildClusters(siteId: number) {
  const [run] = await db
    .select({ id: clusterRunsTable.id, finishedAt: clusterRunsTable.finishedAt })
    .from(clusterRunsTable)
    .where(and(eq(clusterRunsTable.siteId, siteId), eq(clusterRunsTable.status, "complete")))
    .orderBy(desc(clusterRunsTable.finishedAt))
    .limit(1);
  if (!run) {
    return {
      available: false,
      note: "No completed clustering run yet — start one on the Keyword Clusters page.",
      runFinishedAt: null,
      commercialCount: 0,
      informationalCount: 0,
      clusters: [],
    };
  }
  const rows = await db
    .select({
      topic: clusterRunClustersTable.topic,
      clusterKey: clusterRunClustersTable.clusterKey,
      keywordCount: clusterRunClustersTable.keywordCount,
      totalImpressions: clusterRunClustersTable.totalImpressions,
      totalClicks: clusterRunClustersTable.totalClicks,
      avgPosition: clusterRunClustersTable.avgPosition,
      keywords: clusterRunClustersTable.keywords,
    })
    .from(clusterRunClustersTable)
    .where(and(eq(clusterRunClustersTable.siteId, siteId), eq(clusterRunClustersTable.runId, run.id)))
    .orderBy(desc(clusterRunClustersTable.totalImpressions));

  let commercialCount = 0;
  let informationalCount = 0;
  const clusters = rows
    .filter((r) => r.clusterKey !== -1)
    .map((r) => {
      const sampleText = [r.topic, ...r.keywords.slice(0, 10).map((k) => k.query)].join(" ");
      const intent = COMMERCIAL_RE.test(sampleText) ? ("commercial" as const) : ("informational" as const);
      if (intent === "commercial") commercialCount++;
      else informationalCount++;
      return {
        topic: r.topic,
        intent,
        keywordCount: r.keywordCount,
        totalImpressions: r.totalImpressions,
        totalClicks: r.totalClicks,
        avgPosition: r.avgPosition == null ? null : Math.round(r.avgPosition * 10) / 10,
      };
    });
  return {
    available: true,
    note: null,
    runFinishedAt: run.finishedAt?.toISOString() ?? null,
    commercialCount,
    informationalCount,
    clusters: clusters.slice(0, 12),
  };
}

// ---------------------------------------------------------------------------
// Section 4 — technical debt from stored crawl audits + zero-impression pages.
// ---------------------------------------------------------------------------

async function buildTechDebt(siteId: number, host: string) {
  const audits = await db
    .select({
      type: auditReportsTable.type,
      runAt: auditReportsTable.runAt,
      itemCount: auditReportsTable.itemCount,
      payload: auditReportsTable.payload,
    })
    .from(auditReportsTable)
    .where(eq(auditReportsTable.siteId, siteId))
    .orderBy(desc(auditReportsTable.runAt))
    .limit(50);

  // Latest report per audit type.
  const latestByType = new Map<string, (typeof audits)[number]>();
  for (const a of audits) if (!latestByType.has(a.type)) latestByType.set(a.type, a);

  // Traffic at stake: broken/redirecting internal links, joined to page clicks.
  const topPagesAtRisk: Array<{ path: string; clicks: number; impressions: number; issue: string }> = [];
  const broken = latestByType.get("broken_links");
  if (broken && Array.isArray(broken.payload)) {
    const items = (broken.payload as Array<Record<string, unknown>>)
      .filter((i) => typeof i["url"] === "string")
      .slice(0, 100);
    const paths = items
      .map((i) => canonicalPath(String(i["url"]), host))
      .filter((p): p is string => p != null);
    if (paths.length > 0) {
      const pageRows = await db
        .select({ path: pagesTable.path, clicks: pagesTable.clicks, impressions: pagesTable.impressions })
        .from(pagesTable)
        .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.path, paths)));
      const byPath = new Map(pageRows.map((p) => [p.path, p]));
      for (const i of items) {
        const path = canonicalPath(String(i["url"]), host);
        if (path == null) continue;
        const page = byPath.get(path);
        const status = i["status"] == null ? null : Number(i["status"]);
        const issue =
          status != null && status >= 300 && status < 400
            ? `Redirects (${status}) — repoint internal links`
            : status != null
              ? `Broken (${status})`
              : "Unreachable";
        topPagesAtRisk.push({
          path,
          clicks: page?.clicks ?? 0,
          impressions: page?.impressions ?? 0,
          issue,
        });
      }
      topPagesAtRisk.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    }
  }

  const [{ c: notIndexedCount } = { c: 0 }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(inventoryTable)
    .where(
      and(
        eq(inventoryTable.siteId, siteId),
        or(sql`${inventoryTable.impressions} is null`, eq(inventoryTable.impressions, 0)),
      ),
    );

  const hasData = latestByType.size > 0 || notIndexedCount > 0;
  return {
    available: hasData,
    note: hasData
      ? "Core Web Vitals and index coverage detail live on the Google Search pages — this section ranks crawl-detected issues by the traffic they put at stake."
      : "No crawl audits recorded yet — run the link-map crawl to populate this section.",
    audits: [...latestByType.values()].map((a) => ({
      type: a.type,
      runAt: a.runAt.toISOString(),
      itemCount: a.itemCount,
    })),
    notIndexedCount,
    topPagesAtRisk: topPagesAtRisk.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Section 5 — internal linking gaps (orphans / dead ends + traffic at stake).
// ---------------------------------------------------------------------------

async function buildLinkGaps(siteId: number, host: string) {
  const stats = await db
    .select()
    .from(linkStatsTable)
    .where(
      and(
        or(eq(linkStatsTable.isOrphan, true), eq(linkStatsTable.isDeadEnd, true)),
        eq(linkStatsTable.siteId, siteId),
      ),
    );
  if (stats.length === 0) {
    return {
      available: true,
      note: "No orphan or dead-end pages detected in the latest crawl.",
      orphanCount: 0,
      deadEndCount: 0,
      items: [],
    };
  }
  const titles = await db
    .select({ url: wpPostsTable.url, title: wpPostsTable.title })
    .from(wpPostsTable)
    .where(eq(wpPostsTable.siteId, siteId));
  const titleByUrl = new Map(titles.map((t) => [t.url, t.title]));

  const paths = stats
    .map((s) => canonicalPath(s.url, host))
    .filter((p): p is string => p != null);
  const pageRows = await db
    .select({ path: pagesTable.path, clicks: pagesTable.clicks })
    .from(pagesTable)
    .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.path, paths)));
  const clicksByPath = new Map(pageRows.map((p) => [p.path, p.clicks ?? 0]));

  let orphanCount = 0;
  let deadEndCount = 0;
  const items = stats.map((s) => {
    if (s.isOrphan) orphanCount++;
    if (s.isDeadEnd) deadEndCount++;
    return {
      url: s.url,
      title: titleByUrl.get(s.url) ?? null,
      isOrphan: s.isOrphan,
      isDeadEnd: s.isDeadEnd,
      inboundCount: s.inboundCount,
      outboundCount: s.outboundCount,
      clicks: clicksByPath.get(canonicalPath(s.url, host) ?? "") ?? 0,
    };
  });
  items.sort((a, b) => b.clicks - a.clicks || (a.isOrphan === b.isOrphan ? 0 : a.isOrphan ? -1 : 1));
  return { available: true, note: null, orphanCount, deadEndCount, items: items.slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Section 6 — backlink profile (DataForSEO referring domains).
// ---------------------------------------------------------------------------

async function buildBacklinks(siteId: number) {
  const property = await gscSiteUrl(siteId);
  let target = property;
  if (property.startsWith("sc-domain:")) target = property.slice("sc-domain:".length);
  else {
    try {
      target = new URL(property).hostname;
    } catch {
      /* keep raw */
    }
  }
  const domains = await withCache(`s${siteId}|backlinks|${target}`, 6 * 60 * 60 * 1000, () =>
    fetchTopReferringDomains(target, 50).catch(() => []),
  );
  const hasCreds = Boolean(process.env["DATAFORSEO_LOGIN"]);
  return {
    available: domains.length > 0,
    note: !hasCreds
      ? "Backlink data needs DataForSEO credentials."
      : domains.length === 0
        ? "No referring domains returned for this property."
        : "Domain rank is DataForSEO's 0-1000 scale (comparable to DR). Low-rank domains with many links are outreach-cleanup candidates; high-rank ones are worth nurturing.",
    domains: [...domains]
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
      .slice(0, 15)
      .map((d) => ({
        domain: d.domain,
        backlinks: d.backlinks,
        rank: d.rank,
        firstSeen: d.firstSeen,
        lastSeen: d.lastSeen,
      })),
  };
}

// ---------------------------------------------------------------------------
// Section 7 — weekly movement from the latest stored digest.
// ---------------------------------------------------------------------------

async function buildWeekly(siteId: number) {
  const [row] = await db
    .select()
    .from(digestsTable)
    .where(eq(digestsTable.siteId, siteId))
    .orderBy(desc(digestsTable.weekOf))
    .limit(1);
  if (!row) {
    return {
      available: false,
      note: "No weekly digest yet — the first one is generated automatically on Friday.",
      weekOf: null,
      healthCurrent: null,
      healthDelta: null,
      newIssues: 0,
      completed: 0,
      winsImproved: 0,
      winsDeclined: 0,
      openActions: 0,
      priorities: [],
    };
  }
  const p = row.payload as unknown as DigestPayload;
  const priorities = (p.newIssues?.top ?? [])
    .slice(0, 3)
    .map((t) => {
      let path = t.targetUrl;
      try {
        path = new URL(t.targetUrl).pathname;
      } catch {
        /* keep raw */
      }
      return `${t.actionType.replace(/_/g, " ")} — ${t.title ?? path}`;
    });
  return {
    available: true,
    note: null,
    weekOf: p.weekOf ?? row.weekOf,
    healthCurrent: p.health?.current ?? null,
    healthDelta: p.health?.delta ?? null,
    newIssues: p.newIssues?.total ?? 0,
    completed: p.completed?.total ?? 0,
    winsImproved: p.wins?.improved ?? 0,
    winsDeclined: p.wins?.declined ?? 0,
    openActions: p.openActions ?? 0,
    priorities,
  };
}

// ---------------------------------------------------------------------------

router.get("/insights/report", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  try {
    const data = await withCache(`s${site.id}|seo-report:v1`, REPORT_CACHE_TTL_MS, async () => {
      const windowEnd = isoDaysAgo(3);
      const windowStart = isoDaysAgo(31);

      // GSC pull feeds sections 1 and 3; failure degrades those two only.
      const blockRegexes = await loadBlockRegexes(site.id).catch(() => []);
      const aggsP = pullQueryAggregates(site, windowStart, windowEnd).then((aggs) =>
        aggs.filter((a) => a.bestPath == null || !isBlockedPath(a.bestPath, blockRegexes)),
      );

      const [aggsR, clustersR, techDebtR, linkGapsR, backlinksR, weeklyR] = await Promise.allSettled([
        aggsP,
        buildClusters(site.id),
        buildTechDebt(site.id, site.host),
        buildLinkGaps(site.id, site.host),
        buildBacklinks(site.id),
        buildWeekly(site.id),
      ]);

      const unavailable = (note: string) => ({ available: false, note });
      const nearMiss =
        aggsR.status === "fulfilled"
          ? buildNearMiss(aggsR.value, windowStart, windowEnd)
          : {
              ...unavailable("Search Console could not be queried — check the connection in Settings."),
              windowStart: null,
              windowEnd: null,
              totalCandidates: 0,
              queries: [],
            };
      const contentGaps =
        aggsR.status === "fulfilled"
          ? buildContentGaps(aggsR.value, windowStart, windowEnd)
          : {
              ...unavailable("Search Console could not be queried — check the connection in Settings."),
              windowStart: null,
              windowEnd: null,
              gaps: [],
            };

      return {
        nearMiss,
        contentGaps,
        clusters:
          clustersR.status === "fulfilled"
            ? clustersR.value
            : { ...unavailable("Cluster data unavailable."), runFinishedAt: null, commercialCount: 0, informationalCount: 0, clusters: [] },
        techDebt:
          techDebtR.status === "fulfilled"
            ? techDebtR.value
            : { ...unavailable("Audit data unavailable."), audits: [], notIndexedCount: 0, topPagesAtRisk: [] },
        linkGaps:
          linkGapsR.status === "fulfilled"
            ? linkGapsR.value
            : { ...unavailable("Link-graph data unavailable."), orphanCount: 0, deadEndCount: 0, items: [] },
        backlinks:
          backlinksR.status === "fulfilled"
            ? backlinksR.value
            : { ...unavailable("Backlink data unavailable."), domains: [] },
        weekly:
          weeklyR.status === "fulfilled"
            ? weeklyR.value
            : {
                ...unavailable("Digest data unavailable."),
                weekOf: null,
                healthCurrent: null,
                healthDelta: null,
                newIssues: 0,
                completed: 0,
                winsImproved: 0,
                winsDeclined: 0,
                openActions: 0,
                priorities: [],
              },
      };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "SEO report failed");
    res.status(502).json({ error: "Failed to build the SEO report" });
  }
});

export default router;
