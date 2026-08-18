import { Router, type IRouter } from "express";
import { db, pagesTable, gscSnapshotsTable, bingQueryStatsTable } from "@workspace/db";
import { and, eq, sql, desc } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite, type SiteContext } from "../lib/site";
import { queryGsc, withCache } from "../integrations/gsc";
import { queryGa4Pages, type Ga4PageRow } from "../integrations/ga4";
import { isOperatorQuery } from "../services/clustering";
import { canonicalPath, isBlockedPath, loadBlockRegexes } from "../lib/urlCanon";
import { expectedCtrFor } from "../lib/insights";

const router: IRouter = Router();

const REPORT_CACHE_TTL_MS = 30 * 60 * 1000;

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Shared GSC pull — query+page rows over a stable 28d window. Feeds sections
// 1 (queryIntegrity), 2 (ctrCurve), 3 (strikingDistance) and provides the
// "known query set" that section 9 (bingOnlyQueries) subtracts.
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

/** One canonical [query, page] row, pre-canonicalized + blocklist-clean. */
export interface QueryPageRow {
  query: string;
  path: string;
  impressions: number;
  clicks: number;
  position: number;
}

export interface QueryPagePull {
  /** Per-query aggregate (impression-weighted position), used by 3. */
  aggs: Array<QueryAgg & { position: number }>;
  /** Raw per-[query,page] rows (blocklist-clean), used by 1 + 2. */
  rows: QueryPageRow[];
  /** Lowercased set of every query seen — the "Google shows us" set (9). */
  querySet: Set<string>;
}

/**
 * Pull [query, page] aggregates. Operator queries are dropped, positions are
 * impression-weighted (GSC's per-row position × impressions / Σ impressions),
 * and paths are canonicalized + blocklist-filtered at read time. The two
 * most-recent-day snapshots live in gsc_snapshots; this is the live 28d pull.
 */
export async function pullQueryAggregates(
  site: SiteContext,
  startDate: string,
  endDate: string,
  blockRegexes: RegExp[],
): Promise<QueryPagePull> {
  const raw = await queryGsc({
    siteId: site.id,
    startDate,
    endDate,
    dimensions: ["query", "page"],
    rowLimit: 5000,
  });
  const byQuery = new Map<string, QueryAgg>();
  const rows: QueryPageRow[] = [];
  const querySet = new Set<string>();
  for (const r of raw) {
    const q = r.query.trim().toLowerCase();
    if (!q || isOperatorQuery(q)) continue;
    const path = r.url ? canonicalPath(r.url, site.host) : null;
    if (path == null || isBlockedPath(path, blockRegexes)) continue;
    querySet.add(q);
    rows.push({
      query: q,
      path,
      impressions: r.impressions,
      clicks: r.clicks,
      position: r.position,
    });
    let agg = byQuery.get(q);
    if (!agg) {
      agg = {
        query: q,
        impressions: 0,
        clicks: 0,
        posWeighted: 0,
        posWeight: 0,
        bestPath: null,
        bestImpressions: -1,
      };
      byQuery.set(q, agg);
    }
    agg.impressions += r.impressions;
    agg.clicks += r.clicks;
    agg.posWeighted += r.position * Math.max(r.impressions, 1);
    agg.posWeight += Math.max(r.impressions, 1);
    if (r.impressions > agg.bestImpressions) {
      agg.bestImpressions = r.impressions;
      agg.bestPath = path;
    }
  }
  const aggs = [...byQuery.values()].map((a) => ({
    ...a,
    position: a.posWeighted / Math.max(a.posWeight, 1),
  }));
  return { aggs, rows, querySet };
}

// ---------------------------------------------------------------------------
// Section 1 — queryIntegrity: cannibalization & mismapping. A query with
// >= 2 URLs each holding >= 10% of that query's impressions (and >= 30 total
// query impressions) is served by competing/misassigned pages.
// ---------------------------------------------------------------------------

const QI_MIN_QUERY_IMPRESSIONS = 30;
const QI_MIN_URL_SHARE = 0.1;

export function buildQueryIntegrity(rows: QueryPageRow[]) {
  // Group [query, page] rows by query, then by path (GSC splits #anchors —
  // always SUM by path, never overwrite).
  const byQuery = new Map<
    string,
    {
      query: string;
      impressions: number;
      clicks: number;
      paths: Map<string, { impressions: number; clicks: number; posWeighted: number; posWeight: number }>;
    }
  >();
  for (const r of rows) {
    let q = byQuery.get(r.query);
    if (!q) {
      q = { query: r.query, impressions: 0, clicks: 0, paths: new Map() };
      byQuery.set(r.query, q);
    }
    q.impressions += r.impressions;
    q.clicks += r.clicks;
    let p = q.paths.get(r.path);
    if (!p) {
      p = { impressions: 0, clicks: 0, posWeighted: 0, posWeight: 0 };
      q.paths.set(r.path, p);
    }
    p.impressions += r.impressions;
    p.clicks += r.clicks;
    p.posWeighted += r.position * Math.max(r.impressions, 1);
    p.posWeight += Math.max(r.impressions, 1);
  }

  const flagged = [...byQuery.values()]
    .filter((q) => q.impressions >= QI_MIN_QUERY_IMPRESSIONS)
    .map((q) => {
      const contenders = [...q.paths.entries()].filter(
        ([, p]) => p.impressions / q.impressions >= QI_MIN_URL_SHARE,
      );
      return { q, contenders };
    })
    .filter(({ contenders }) => contenders.length >= 2)
    .map(({ q }) => {
      const urls = [...q.paths.entries()]
        .map(([path, p]) => ({
          path,
          impressions: p.impressions,
          sharePct: Math.round((p.impressions / q.impressions) * 1000) / 10,
          position: Math.round((p.posWeighted / Math.max(p.posWeight, 1)) * 10) / 10,
        }))
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 3);
      return { query: q.query, impressions: q.impressions, clicks: q.clicks, urls };
    })
    .sort((a, b) => b.impressions - a.impressions);

  return {
    available: true,
    note:
      "sharePct is each URL's share of THIS query's impressions across the returned URLs only — not a share of all site queries (GSC anonymizes low-volume queries, so absolute query totals are unknowable).",
    totalCount: flagged.length,
    rows: flagged.slice(0, 15),
  };
}

// ---------------------------------------------------------------------------
// Section 2 — ctrCurve: actual CTR vs the position benchmark, aggregated BY
// PAGE for top-10 positions with >= 100 impressions. belowCurve (ratio < 0.5)
// = snippet/title problem; aboveCurve (ratio > 1.5) = under-served by rank.
// ---------------------------------------------------------------------------

const CTR_CURVE_MIN_IMPRESSIONS = 100;
const CTR_BELOW_RATIO = 0.5;
const CTR_ABOVE_RATIO = 1.5;

export function buildCtrCurve(rows: QueryPageRow[]) {
  // Aggregate by page (SUM impressions/clicks, impression-weighted position).
  const byPath = new Map<
    string,
    { impressions: number; clicks: number; posWeighted: number; posWeight: number }
  >();
  for (const r of rows) {
    let p = byPath.get(r.path);
    if (!p) {
      p = { impressions: 0, clicks: 0, posWeighted: 0, posWeight: 0 };
      byPath.set(r.path, p);
    }
    p.impressions += r.impressions;
    p.clicks += r.clicks;
    p.posWeighted += r.position * Math.max(r.impressions, 1);
    p.posWeight += Math.max(r.impressions, 1);
  }

  const belowCurve: Array<ReturnType<typeof toRow>> = [];
  const aboveCurve: Array<ReturnType<typeof toRow>> = [];

  function toRow(
    path: string,
    p: { impressions: number; clicks: number; posWeighted: number; posWeight: number },
    position: number,
    expectedCtr: number,
  ) {
    const actualCtr = p.clicks / p.impressions;
    const ratio = expectedCtr > 0 ? actualCtr / expectedCtr : 0;
    const missedClicks = Math.max(0, Math.round(expectedCtr * p.impressions - p.clicks));
    return {
      path,
      impressions: p.impressions,
      clicks: p.clicks,
      position: Math.round(position * 10) / 10,
      actualCtr: Math.round(actualCtr * 10000) / 10000,
      expectedCtr,
      ratio: Math.round(ratio * 100) / 100,
      missedClicks,
    };
  }

  for (const [path, p] of byPath) {
    if (p.impressions < CTR_CURVE_MIN_IMPRESSIONS) continue;
    const position = p.posWeighted / Math.max(p.posWeight, 1);
    if (position > 10) continue;
    const expectedCtr = expectedCtrFor(position);
    if (expectedCtr == null) continue;
    const actualCtr = p.clicks / p.impressions;
    const ratio = expectedCtr > 0 ? actualCtr / expectedCtr : 0;
    if (ratio < CTR_BELOW_RATIO) belowCurve.push(toRow(path, p, position, expectedCtr));
    else if (ratio > CTR_ABOVE_RATIO) aboveCurve.push(toRow(path, p, position, expectedCtr));
  }

  belowCurve.sort((a, b) => b.missedClicks - a.missedClicks || b.impressions - a.impressions);
  aboveCurve.sort((a, b) => b.impressions - a.impressions);

  return {
    available: true,
    note:
      "Compares actual CTR to the median CTR for that rounded position, not raw CTR. Below-curve pages (ratio < 0.5) lose the click to the snippet/title; above-curve pages (ratio > 1.5) are under-served by rank — ranking them up is high leverage.",
    belowCurve: belowCurve.slice(0, 10),
    aboveCurve: aboveCurve.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Section 3 — strikingDistance: near-miss (page-1-adjacent) queries, ranked
// by impression-weighted closeness to the top (impressions × (16 − position)).
// ---------------------------------------------------------------------------

const NEAR_MISS_MIN_IMPRESSIONS = 10;

export function buildStrikingDistance(
  aggs: Array<QueryAgg & { position: number }>,
  windowStart: string,
  windowEnd: string,
) {
  const candidates = aggs.filter(
    (a) => a.position >= 5 && a.position <= 15 && a.impressions >= NEAR_MISS_MIN_IMPRESSIONS,
  );
  const queries = candidates
    .map((a) => ({
      query: a.query,
      position: Math.round(a.position * 10) / 10,
      impressions: a.impressions,
      clicks: a.clicks,
      score: Math.round(a.impressions * (16 - a.position)),
      page2: a.position > 10,
      bestPath: a.bestPath,
    }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 20);
  return {
    available: true,
    note: null as string | null,
    windowStart,
    windowEnd,
    totalCandidates: candidates.length,
    queries,
  };
}

// ---------------------------------------------------------------------------
// Section 4 — queryDiscovery: distinct-query coverage per URL, compared
// between the two most-recent snapshot dates >= 14 days apart (fallback: the
// two most recent distinct dates). Gainers picked up new queries; losers lost
// coverage.
// ---------------------------------------------------------------------------

const DISCOVERY_MIN_GAP_DAYS = 14;

/** Pick the (now, before) snapshot dates: prefer >= 14d apart. */
export function pickDiscoveryDates(dates: string[]): { now: string; before: string } | null {
  const sorted = [...new Set(dates)].sort(); // ascending ISO
  if (sorted.length < 2) return null;
  const now = sorted[sorted.length - 1]!;
  const nowMs = Date.parse(now);
  // Newest earlier date that is >= 14 days before `now`.
  for (let i = sorted.length - 2; i >= 0; i--) {
    const gap = (nowMs - Date.parse(sorted[i]!)) / 86_400_000;
    if (gap >= DISCOVERY_MIN_GAP_DAYS) return { now, before: sorted[i]! };
  }
  // Fallback: the two most recent distinct dates.
  return { now, before: sorted[sorted.length - 2]! };
}

/**
 * Count DISTINCT normalized queries per CANONICAL path. Raw GSC-snapshot rows
 * carry raw URLs (GSC splits /page and /page/#anchor), so we must collapse to
 * the canonical path FIRST and dedupe queries across those variants — counting
 * distinct-per-raw-url and summing would double-count a query that appears on
 * more than one variant of the same page. Blocklisted paths are dropped.
 */
export function countDistinctQueriesByPath(
  rows: Array<{ url: string; query: string }>,
  host: string,
  blockRegexes: RegExp[],
): Map<string, number> {
  const byPath = new Map<string, Set<string>>();
  for (const r of rows) {
    const path = canonicalPath(r.url, host);
    if (path == null || isBlockedPath(path, blockRegexes)) continue;
    const q = r.query.trim().toLowerCase();
    if (!q) continue;
    let set = byPath.get(path);
    if (!set) {
      set = new Set<string>();
      byPath.set(path, set);
    }
    set.add(q);
  }
  return new Map([...byPath.entries()].map(([path, set]) => [path, set.size]));
}

async function buildQueryDiscovery(site: SiteContext, blockRegexes: RegExp[]) {
  const dateRows = await db
    .selectDistinct({ d: gscSnapshotsTable.snapshotDate })
    .from(gscSnapshotsTable)
    .where(eq(gscSnapshotsTable.siteId, site.id))
    .orderBy(desc(gscSnapshotsTable.snapshotDate))
    .limit(60);
  const dates = dateRows.map((r) => r.d);
  const picked = pickDiscoveryDates(dates);
  if (!picked) {
    return {
      available: false,
      note: "Need at least two GSC snapshots to measure query-coverage change.",
      dateNow: null as string | null,
      dateBefore: null as string | null,
      gainers: [],
      losers: [],
    };
  }

  // Per-date distinct-query counts, deduped across URL variants → canonical
  // path (see countDistinctQueriesByPath).
  const counts = new Map<string, { now: number; before: number }>();
  for (const [when, date] of [
    ["now", picked.now] as const,
    ["before", picked.before] as const,
  ]) {
    const rows = await db
      .select({ url: gscSnapshotsTable.url, query: gscSnapshotsTable.query })
      .from(gscSnapshotsTable)
      .where(
        and(eq(gscSnapshotsTable.siteId, site.id), eq(gscSnapshotsTable.snapshotDate, date)),
      );
    const perPath = countDistinctQueriesByPath(rows, site.host, blockRegexes);
    for (const [path, c] of perPath) {
      let e = counts.get(path);
      if (!e) {
        e = { now: 0, before: 0 };
        counts.set(path, e);
      }
      e[when] = c;
    }
  }

  const all = [...counts.entries()].map(([path, e]) => ({
    path,
    queriesNow: e.now,
    queriesBefore: e.before,
    delta: e.now - e.before,
  }));
  const gainers = all
    .filter((r) => r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 10);
  const losers = all
    .filter((r) => r.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 10);

  return {
    available: true,
    note: null as string | null,
    dateNow: picked.now,
    dateBefore: picked.before,
    gainers,
    losers,
  };
}

// ---------------------------------------------------------------------------
// Section 5 — indexingByTemplate: structural indexing coverage proxy. Group
// blocklist-clean, in-sitemap-or-in-WP pages by section; report the share
// carrying zero impressions (a proxy for "indexed but not surfacing").
// ---------------------------------------------------------------------------

export interface IndexingPageRow {
  section: string | null;
  impressions: number | null;
}

export function buildIndexingByTemplate(pages: IndexingPageRow[]) {
  const bySection = new Map<string | null, { total: number; withImpr: number }>();
  for (const p of pages) {
    const key = p.section ?? null;
    let e = bySection.get(key);
    if (!e) {
      e = { total: 0, withImpr: 0 };
      bySection.set(key, e);
    }
    e.total++;
    if ((p.impressions ?? 0) > 0) e.withImpr++;
  }
  const sections = [...bySection.entries()]
    .map(([section, e]) => ({
      section,
      totalPages: e.total,
      pagesWithImpressions: e.withImpr,
      zeroImpressionPct:
        e.total > 0 ? Math.round(((e.total - e.withImpr) / e.total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.zeroImpressionPct - a.zeroImpressionPct);
  return {
    available: sections.length > 0,
    note:
      "Section (WordPress template proxy) grouping of sitemap/WP pages. zeroImpressionPct is a proxy for indexing coverage by template — a high share means that template's pages are indexed but not surfacing in Search.",
    sections,
  };
}

async function loadIndexingPages(siteId: number, blockRegexes: RegExp[]): Promise<IndexingPageRow[]> {
  const rows = await db
    .select({
      path: pagesTable.path,
      section: pagesTable.section,
      impressions: pagesTable.impressions,
      inWp: pagesTable.inWp,
      inSitemap: pagesTable.inSitemap,
    })
    .from(pagesTable)
    .where(and(eq(pagesTable.siteId, siteId), sql`(${pagesTable.inSitemap} or ${pagesTable.inWp})`));
  return rows
    .filter((r) => !isBlockedPath(r.path, blockRegexes))
    .map((r) => ({ section: r.section, impressions: r.impressions }));
}

// ---------------------------------------------------------------------------
// Sections 6-8 — decision joins over the pages registry (GSC rollups) merged
// with a live GA4 pull (sessions/engagementRate/avgEngagementTime — those
// aren't persisted on the registry, only keyEvents/aiSessions are). Gated on
// ga4SyncedAt: no synced rows → all three sections "GA4 not synced".
// ---------------------------------------------------------------------------

export interface JoinPageRow {
  path: string;
  title: string | null;
  section: string | null;
  topQuery: string | null;
  position: number | null;
  impressions: number;
  clicks: number;
  keyEvents: number;
  aiSessions: number;
  // Merged from the live GA4 pull (0 when the page had no GA4 rows).
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  avgEngagementTime: number;
}

const INVEST_TOP = 12;
const TITLE_MIN_IMPRESSIONS = 200;
const TITLE_MAX_POSITION = 12;
const TITLE_CTR_RATIO = 0.5;
const TITLE_ENGAGEMENT_FLOOR = 0.5;
const WRONG_MIN_CLICKS = 20;
const WRONG_MAX_ENGAGEMENT = 0.35;

export function buildInvestMap(rows: JoinPageRow[]) {
  const pages = rows
    .slice()
    .sort((a, b) => b.keyEvents - a.keyEvents || b.engagedSessions - a.engagedSessions)
    .slice(0, INVEST_TOP)
    .map((r) => ({
      path: r.path,
      title: r.title,
      section: r.section,
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position == null ? null : Math.round(r.position * 10) / 10,
      sessions: r.sessions,
      engagementRate: Math.round(r.engagementRate * 1000) / 1000,
      keyEvents: r.keyEvents,
      topQuery: r.topQuery,
    }));
  return { available: true, note: null as string | null, pages };
}

export function buildTitleRewrites(rows: JoinPageRow[]) {
  const pages = rows
    .map((r) => {
      if (r.position == null || r.impressions < TITLE_MIN_IMPRESSIONS) return null;
      if (r.position > TITLE_MAX_POSITION) return null;
      const expectedCtr = expectedCtrFor(r.position);
      if (expectedCtr == null) return null;
      const actualCtr = r.clicks / r.impressions;
      if (actualCtr >= TITLE_CTR_RATIO * expectedCtr) return null;
      // Converts when clicked: real key events OR strong engagement.
      if (!(r.keyEvents > 0 || r.engagementRate >= TITLE_ENGAGEMENT_FLOOR)) return null;
      const missedClicks = Math.max(0, Math.round(expectedCtr * r.impressions - r.clicks));
      return {
        path: r.path,
        title: r.title,
        impressions: r.impressions,
        clicks: r.clicks,
        position: Math.round(r.position * 10) / 10,
        actualCtr: Math.round(actualCtr * 10000) / 10000,
        expectedCtr,
        missedClicks,
        keyEvents: r.keyEvents,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.missedClicks - a.missedClicks)
    .slice(0, 10);
  return { available: true, note: null as string | null, pages };
}

export function buildWrongIntent(rows: JoinPageRow[]) {
  const pages = rows
    .filter(
      (r) => r.clicks >= WRONG_MIN_CLICKS && r.engagementRate < WRONG_MAX_ENGAGEMENT && r.keyEvents === 0,
    )
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10)
    .map((r) => ({
      path: r.path,
      title: r.title,
      topQuery: r.topQuery,
      clicks: r.clicks,
      engagementRate: Math.round(r.engagementRate * 1000) / 1000,
      avgEngagementTime: Math.round(r.avgEngagementTime * 10) / 10,
      keyEvents: r.keyEvents,
    }));
  return { available: true, note: null as string | null, pages };
}

/**
 * Result of loading the GA4 decision-join rows:
 * - "no-sync": GA4 has never synced onto the registry (no ga4SyncedAt rows).
 * - "ga4-unavailable": the live GA4 pull failed, so the engagement/session
 *   metrics the three joins depend on are MISSING. We refuse to zero-fill and
 *   draw conclusions from fabricated data — the sections degrade instead.
 * - "ok": rows carry real, merged engagement metrics.
 */
export type JoinLoad =
  | { status: "no-sync" }
  | { status: "ga4-unavailable" }
  | { status: "ok"; rows: JoinPageRow[] };

/**
 * Maps a JoinLoad to the three GA4-dependent sections. Centralizes the
 * degradation rule so a failed live GA4 pull can never leak zero-filled rows
 * into investMap/titleRewrites/wrongIntent (which would draw conclusions from
 * fabricated engagement metrics). "no-sync" and "ga4-unavailable" both yield
 * available:false with distinct notes.
 */
export function resolveGa4Sections(load: JoinLoad) {
  if (load.status === "ok") {
    return {
      investMap: buildInvestMap(load.rows),
      titleRewrites: buildTitleRewrites(load.rows),
      wrongIntent: buildWrongIntent(load.rows),
    };
  }
  const note =
    load.status === "no-sync"
      ? "GA4 not synced"
      : "GA4 data unavailable — connect/sync GA4 to unlock these analyses";
  const off = { available: false as const, note, pages: [] };
  return { investMap: off, titleRewrites: off, wrongIntent: off };
}

/**
 * Loads the join rows: pages registry (GA4-synced only) merged with a live
 * GA4 pull for the engagement metrics the registry doesn't persist. The three
 * GA4-dependent sections (investMap/titleRewrites/wrongIntent) all read
 * engagement metrics, so if the live pull fails we must NOT return zero-filled
 * rows — a page with 40 clicks and a fabricated 0% engagement would falsely
 * trip wrongIntent. Any pull error → "ga4-unavailable".
 */
async function loadJoinRows(site: SiteContext, blockRegexes: RegExp[]): Promise<JoinLoad> {
  const pages = await db
    .select({
      path: pagesTable.path,
      title: pagesTable.title,
      section: pagesTable.section,
      topQuery: pagesTable.topQuery,
      position: pagesTable.position,
      impressions: pagesTable.impressions,
      clicks: pagesTable.clicks,
      keyEvents: pagesTable.keyEvents,
      aiSessions: pagesTable.aiSessions,
      ga4SyncedAt: pagesTable.ga4SyncedAt,
    })
    .from(pagesTable)
    .where(and(eq(pagesTable.siteId, site.id), sql`${pagesTable.ga4SyncedAt} is not null`));
  if (pages.length === 0) return { status: "no-sync" };

  // Live GA4 pull for sessions/engagementRate/avgEngagementTime (not persisted
  // on the registry). ANY failure means the engagement metrics are missing —
  // never zero-fill and infer behavior from that. Degrade all three sections.
  let ga4Rows: Ga4PageRow[];
  try {
    const startDate = isoDaysAgo(29);
    const endDate = isoDaysAgo(1);
    ({ rows: ga4Rows } = await queryGa4Pages({ startDate, endDate, channel: "all", site }));
  } catch {
    return { status: "ga4-unavailable" };
  }
  const ga4ByPath = new Map(ga4Rows.map((r) => [r.path, r]));

  const rows = pages
    .filter((p) => !isBlockedPath(p.path, blockRegexes))
    .map((p) => {
      const g = ga4ByPath.get(p.path);
      return {
        path: p.path,
        title: p.title,
        section: p.section,
        topQuery: p.topQuery,
        position: p.position,
        impressions: p.impressions ?? 0,
        clicks: p.clicks ?? 0,
        keyEvents: p.keyEvents ?? 0,
        aiSessions: p.aiSessions ?? 0,
        sessions: g?.sessions ?? 0,
        engagedSessions: g?.engagedSessions ?? 0,
        engagementRate: g?.engagementRate ?? 0,
        avgEngagementTime: g?.avgEngagementTime ?? 0,
      };
    });
  return { status: "ok", rows };
}

// ---------------------------------------------------------------------------
// Section 9 — bingOnlyQueries: demand Bing shows you that Google never does.
// SUM the latest ~8 Bing bucket dates by query; keep queries with >= 50 Bing
// impressions that never appeared in the GSC pull's (lowercased) query set.
// ---------------------------------------------------------------------------

const BING_LOOKBACK_BUCKETS = 8;
const BING_ONLY_MIN_IMPRESSIONS = 50;

export interface BingQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export function buildBingOnlyQueries(bingRows: BingQueryRow[], gscQuerySet: Set<string>) {
  // SUM by normalized (lowercase) query — buckets already pre-filtered.
  const byQuery = new Map<
    string,
    { query: string; clicks: number; impressions: number; posWeighted: number; posWeight: number }
  >();
  for (const r of bingRows) {
    const q = r.query.trim().toLowerCase();
    if (!q) continue;
    let e = byQuery.get(q);
    if (!e) {
      e = { query: q, clicks: 0, impressions: 0, posWeighted: 0, posWeight: 0 };
      byQuery.set(q, e);
    }
    e.clicks += r.clicks;
    e.impressions += r.impressions;
    if (r.position != null) {
      e.posWeighted += r.position * Math.max(r.impressions, 1);
      e.posWeight += Math.max(r.impressions, 1);
    }
  }
  const queries = [...byQuery.values()]
    .filter((e) => e.impressions >= BING_ONLY_MIN_IMPRESSIONS && !gscQuerySet.has(e.query))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15)
    .map((e) => ({
      query: e.query,
      impressions: e.impressions,
      clicks: e.clicks,
      position: e.posWeight > 0 ? Math.round((e.posWeighted / e.posWeight) * 10) / 10 : null,
    }));
  return { available: true, note: null as string | null, queries };
}

async function buildBingSection(siteId: number, gscQuerySet: Set<string>) {
  // Latest ~8 distinct bucket dates.
  const dateRows = await db
    .selectDistinct({ d: bingQueryStatsTable.bucketDate })
    .from(bingQueryStatsTable)
    .where(eq(bingQueryStatsTable.siteId, siteId))
    .orderBy(desc(bingQueryStatsTable.bucketDate))
    .limit(BING_LOOKBACK_BUCKETS);
  if (dateRows.length === 0) {
    return {
      available: false,
      note: "No Bing Webmaster query data synced yet.",
      queries: [] as BingQueryRow[],
    };
  }
  const oldest = dateRows[dateRows.length - 1]!.d;
  const rows = await db
    .select({
      query: bingQueryStatsTable.query,
      clicks: bingQueryStatsTable.clicks,
      impressions: bingQueryStatsTable.impressions,
      position: bingQueryStatsTable.position,
    })
    .from(bingQueryStatsTable)
    .where(and(eq(bingQueryStatsTable.siteId, siteId), sql`${bingQueryStatsTable.bucketDate} >= ${oldest}`));
  return buildBingOnlyQueries(rows, gscQuerySet);
}

// ---------------------------------------------------------------------------

router.get("/insights/report", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  try {
    const data = await withCache(`s${site.id}|seo-report:v2`, REPORT_CACHE_TTL_MS, async () => {
      const windowEnd = isoDaysAgo(3);
      const windowStart = isoDaysAgo(31);
      const generatedAt = new Date().toISOString();

      const blockRegexes = await loadBlockRegexes(site.id).catch(() => []);

      // The GSC pull feeds sections 1, 2, 3 and provides the "known" query set
      // section 9 subtracts. Its failure degrades 1/2/3 and forces section 9
      // to treat every Bing query as unseen — so degrade 9 too when it fails.
      const pullP = pullQueryAggregates(site, windowStart, windowEnd, blockRegexes);

      const [pullR, discoveryR, indexingR, joinR] = await Promise.allSettled([
        pullP,
        buildQueryDiscovery(site, blockRegexes),
        loadIndexingPages(site.id, blockRegexes).then(buildIndexingByTemplate),
        loadJoinRows(site, blockRegexes),
      ]);

      // Bing needs the GSC query set; run it after the pull settles.
      const gscQuerySet = pullR.status === "fulfilled" ? pullR.value.querySet : null;
      const bingR = await (gscQuerySet
        ? buildBingSection(site.id, gscQuerySet).catch(() => null)
        : Promise.resolve(null));

      const gscUnavailable = (extra: Record<string, unknown>) => ({
        available: false,
        note: "Search Console could not be queried — check the connection in Settings.",
        ...extra,
      });

      const queryIntegrity =
        pullR.status === "fulfilled"
          ? buildQueryIntegrity(pullR.value.rows)
          : gscUnavailable({ totalCount: 0, rows: [] });

      const ctrCurve =
        pullR.status === "fulfilled"
          ? buildCtrCurve(pullR.value.rows)
          : gscUnavailable({ belowCurve: [], aboveCurve: [] });

      const strikingDistance =
        pullR.status === "fulfilled"
          ? buildStrikingDistance(pullR.value.aggs, windowStart, windowEnd)
          : gscUnavailable({ windowStart: null, windowEnd: null, totalCandidates: 0, queries: [] });

      const queryDiscovery =
        discoveryR.status === "fulfilled"
          ? discoveryR.value
          : {
              available: false,
              note: "Query-discovery data unavailable.",
              dateNow: null,
              dateBefore: null,
              gainers: [],
              losers: [],
            };

      const indexingByTemplate =
        indexingR.status === "fulfilled"
          ? indexingR.value
          : { available: false, note: "Page registry unavailable.", sections: [] };

      // The three GA4 joins share one load. Distinguish "never synced" from a
      // failed live pull: the latter must NOT zero-fill and infer behavior
      // from fabricated data — both degrade all three sections (see
      // resolveGa4Sections), with distinct notes so users know connect vs retry.
      const joinLoad: JoinLoad =
        joinR.status === "fulfilled" ? joinR.value : { status: "ga4-unavailable" };
      const { investMap, titleRewrites, wrongIntent } = resolveGa4Sections(joinLoad);

      const bingOnlyQueries =
        bingR ??
        (pullR.status === "fulfilled"
          ? { available: false, note: "No Bing Webmaster query data synced yet.", queries: [] }
          : {
              available: false,
              note: "Bing contrast needs the Search Console query set, which could not be loaded.",
              queries: [],
            });

      return {
        window: {
          start: pullR.status === "fulfilled" ? windowStart : null,
          end: pullR.status === "fulfilled" ? windowEnd : null,
        },
        generatedAt,
        queryIntegrity,
        ctrCurve,
        strikingDistance,
        queryDiscovery,
        indexingByTemplate,
        investMap,
        titleRewrites,
        wrongIntent,
        bingOnlyQueries,
      };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "SEO report failed");
    res.status(502).json({ error: "Failed to build the SEO report" });
  }
});

export default router;
