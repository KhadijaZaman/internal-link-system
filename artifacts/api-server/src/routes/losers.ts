import { Router, type IRouter } from "express";
import { desc, eq, sql, ilike } from "drizzle-orm";
import {
  db,
  queryLosersTable,
  optimizeQueueTable,
  watchlistQueriesTable,
  pageTargetKeywordsTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { queryGscDimension, aggregateTotals, withCache, GSC_CACHE_TTL_MS } from "../integrations/gsc";
import { generateQueryInsight } from "../integrations/claude";

const router: IRouter = Router();

const QUERY_INSIGHT_TTL_MS = 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function normalizeSeverity(raw: string | null): "critical" | "high" | "medium" | "low" {
  const s = (raw ?? "").toLowerCase();
  if (s === "critical" || s === "high" || s === "medium" || s === "low") return s;
  return "low";
}

router.get("/losers", requireAuth, async (_req, res) => {
  const latest = await db
    .select({ weekOf: queryLosersTable.weekOf })
    .from(queryLosersTable)
    .orderBy(desc(queryLosersTable.weekOf))
    .limit(1);
  const week = latest[0]?.weekOf ?? null;
  if (!week) {
    res.json({ weekOf: null, counts: { critical: 0, high: 0, medium: 0, low: 0 }, items: [] });
    return;
  }
  const items = await db
    .select()
    .from(queryLosersTable)
    .where(eq(queryLosersTable.weekOf, week));
  const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const r of items) {
    const sev = (r.severity ?? "").toLowerCase();
    if (sev in counts) counts[sev]++;
  }
  res.json({
    weekOf: week,
    counts,
    items: items.map((i) => ({
      id: i.id,
      weekOf: i.weekOf,
      url: i.url,
      query: i.query,
      prevPosition: i.prevPosition,
      currPosition: i.currPosition,
      positionChange: i.positionChange,
      prevImpressions: i.prevImpressions,
      currImpressions: i.currImpressions,
      impressionsChangePct: i.impressionsChangePct,
      severity: i.severity ?? "low",
    })),
  });
});

router.get("/losers/query-insights", requireAuth, async (req, res) => {
  const raw = String(req.query["q"] ?? "").trim();
  if (raw.length < 2 || raw.length > 200) {
    res.status(400).json({ error: "q must be 2-200 characters" });
    return;
  }
  const q = raw.toLowerCase();
  try {
    const data = await withCache(`query-insights|${q}`, QUERY_INSIGHT_TTL_MS, async () => {
      const endDate = isoDaysAgo(3);
      const startDate = isoDaysAgo(31);
      const prevEnd = isoDaysAgo(32);
      const prevStart = isoDaysAgo(60);

      const [pageRows, prevPageRows] = await Promise.all([
        queryGscDimension({
          startDate, endDate, dimension: "page",
          queryFilter: { expression: q, operator: "contains" },
          rowLimit: 200,
        }).catch(() => []),
        queryGscDimension({
          startDate: prevStart, endDate: prevEnd, dimension: "page",
          queryFilter: { expression: q, operator: "contains" },
          rowLimit: 200,
        }).catch(() => []),
      ]);

      const topPages = pageRows
        .map((r) => ({
          url: r.key,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
        }))
        .sort((a, b) => b.impressions - a.impressions);
      const totals = aggregateTotals(topPages);
      const previousTotals = prevPageRows.length
        ? aggregateTotals(prevPageRows.map((r) => ({ clicks: r.clicks, impressions: r.impressions, position: r.position })))
        : null;

      const latestWeek = await db
        .select({ weekOf: queryLosersTable.weekOf })
        .from(queryLosersTable)
        .orderBy(desc(queryLosersTable.weekOf))
        .limit(1);
      const recentLosers = latestWeek[0]?.weekOf
        ? await db
            .select()
            .from(queryLosersTable)
            .where(sql`${queryLosersTable.weekOf} = ${latestWeek[0].weekOf} and (${ilike(queryLosersTable.query, `%${q}%`)})`)
            .limit(10)
        : [];

      const insight = totals.impressions > 0 || recentLosers.length > 0
        ? await generateQueryInsight({
            query: raw,
            totals,
            previousTotals,
            topPages,
            recentLosers: recentLosers.map((l) => ({
              url: l.url,
              prevPos: l.prevPosition == null ? null : Number(l.prevPosition),
              currPos: l.currPosition == null ? null : Number(l.currPosition),
              impressionsChangePct: l.impressionsChangePct == null ? null : Number(l.impressionsChangePct),
              severity: l.severity ?? "low",
            })),
          }).catch(() => null)
        : null;

      return {
        query: raw,
        windowStart: startDate,
        windowEnd: endDate,
        totals,
        previousTotals,
        topPages: topPages.slice(0, 10),
        recentLosers: recentLosers.map((l) => ({
          id: l.id,
          url: l.url,
          prevPosition: l.prevPosition == null ? null : Number(l.prevPosition),
          currPosition: l.currPosition == null ? null : Number(l.currPosition),
          impressionsChangePct: l.impressionsChangePct == null ? null : Number(l.impressionsChangePct),
          severity: l.severity ?? "low",
        })),
        insight,
      };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Query insights failed");
    res.status(502).json({ error: "Failed to build query insights" });
  }
});

router.get("/losers/weeks", requireAuth, async (_req, res) => {
  const rows = await db
    .select({
      weekOf: queryLosersTable.weekOf,
      queryCount: sql<number>`count(*)::int`,
      pageCount: sql<number>`count(distinct ${queryLosersTable.url})::int`,
    })
    .from(queryLosersTable)
    .groupBy(queryLosersTable.weekOf)
    .orderBy(desc(queryLosersTable.weekOf));
  res.json(
    rows.map((r) => ({
      weekOf: r.weekOf,
      pageCount: r.pageCount,
      queryCount: r.queryCount,
    })),
  );
});

router.get("/losers/pages", requireAuth, async (req, res) => {
  const rawWeek = String(req.query["weekOf"] ?? "").trim();
  let week: string | null = null;
  if (rawWeek !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawWeek)) {
      res.status(400).json({ error: "weekOf must be YYYY-MM-DD" });
      return;
    }
    week = rawWeek;
  } else {
    const latest = await db
      .select({ weekOf: queryLosersTable.weekOf })
      .from(queryLosersTable)
      .orderBy(desc(queryLosersTable.weekOf))
      .limit(1);
    week = latest[0]?.weekOf ?? null;
  }

  if (!week) {
    res.json({ weekOf: null, pages: [] });
    return;
  }

  const [items, watchlist, targetKeywords] = await Promise.all([
    db.select().from(queryLosersTable).where(eq(queryLosersTable.weekOf, week)),
    db.select({ query: watchlistQueriesTable.query }).from(watchlistQueriesTable),
    db.select({ url: pageTargetKeywordsTable.url }).from(pageTargetKeywordsTable),
  ]);

  const watchSet = new Set(watchlist.map((w) => w.query.toLowerCase()));
  const targetCountByUrl = new Map<string, number>();
  for (const t of targetKeywords) {
    targetCountByUrl.set(t.url, (targetCountByUrl.get(t.url) ?? 0) + 1);
  }

  type PageAcc = {
    url: string;
    counts: { critical: number; high: number; medium: number; low: number };
    impressionsLost: number;
    worstPositionDrop: number | null;
    watchlistMatch: boolean;
    queries: {
      id: number;
      query: string;
      severity: string;
      prevPosition: number | null;
      currPosition: number | null;
      positionChange: number | null;
      prevImpressions: number | null;
      currImpressions: number | null;
      impressionsChangePct: number | null;
      watchlisted: boolean;
    }[];
  };

  const byUrl = new Map<string, PageAcc>();
  for (const r of items) {
    let acc = byUrl.get(r.url);
    if (!acc) {
      acc = {
        url: r.url,
        counts: { critical: 0, high: 0, medium: 0, low: 0 },
        impressionsLost: 0,
        worstPositionDrop: null,
        watchlistMatch: false,
        queries: [],
      };
      byUrl.set(r.url, acc);
    }
    const sev = normalizeSeverity(r.severity);
    acc.counts[sev]++;
    const prevImp = r.prevImpressions ?? null;
    const currImp = r.currImpressions ?? null;
    if (prevImp != null && currImp != null) {
      const lost = prevImp - currImp;
      if (lost > 0) acc.impressionsLost += lost;
    }
    const posChange = r.positionChange == null ? null : Number(r.positionChange);
    if (posChange != null && (acc.worstPositionDrop == null || posChange > acc.worstPositionDrop)) {
      acc.worstPositionDrop = posChange;
    }
    const watchlisted = watchSet.has(r.query.toLowerCase());
    if (watchlisted) acc.watchlistMatch = true;
    acc.queries.push({
      id: r.id,
      query: r.query,
      severity: sev,
      prevPosition: r.prevPosition == null ? null : Number(r.prevPosition),
      currPosition: r.currPosition == null ? null : Number(r.currPosition),
      positionChange: posChange,
      prevImpressions: prevImp,
      currImpressions: currImp,
      impressionsChangePct: r.impressionsChangePct == null ? null : Number(r.impressionsChangePct),
      watchlisted,
    });
  }

  const pages = [...byUrl.values()].map((p) => {
    p.queries.sort((a, b) => {
      if (a.watchlisted !== b.watchlisted) return a.watchlisted ? -1 : 1;
      return (b.positionChange ?? -Infinity) - (a.positionChange ?? -Infinity);
    });
    return {
      url: p.url,
      queryCount: p.queries.length,
      counts: p.counts,
      impressionsLost: p.impressionsLost,
      worstPositionDrop: p.worstPositionDrop,
      watchlistMatch: p.watchlistMatch,
      targetKeywordCount: targetCountByUrl.get(p.url) ?? 0,
      queries: p.queries,
    };
  });

  // Action-first: watchlist hits, then most critical, then biggest impression loss.
  pages.sort((a, b) => {
    if (a.watchlistMatch !== b.watchlistMatch) return a.watchlistMatch ? -1 : 1;
    if (a.counts.critical !== b.counts.critical) return b.counts.critical - a.counts.critical;
    if (a.counts.high !== b.counts.high) return b.counts.high - a.counts.high;
    return b.impressionsLost - a.impressionsLost;
  });

  res.json({ weekOf: week, pages });
});

router.post("/losers/:id/send-to-optimizer", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const loser = await db
    .select()
    .from(queryLosersTable)
    .where(eq(queryLosersTable.id, id))
    .limit(1);
  if (loser.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const item = loser[0]!;
  const priority =
    item.severity === "critical" ? "high" : item.severity === "high" ? "high" : "medium";
  const inserted = await db
    .insert(optimizeQueueTable)
    .values({
      url: item.url,
      priority,
      notes: `From loser: query="${item.query}" severity=${item.severity}`,
    })
    .returning();
  const q = inserted[0]!;
  res.json({
    id: q.id,
    url: q.url,
    status: q.status,
    priority: q.priority,
    notes: q.notes,
    briefMarkdown: q.briefMarkdown,
    groundingPassages: q.groundingPassages,
    addedAt: (q.addedAt ?? new Date()).toISOString(),
    completedAt: q.completedAt?.toISOString() ?? null,
  });
});

export default router;
