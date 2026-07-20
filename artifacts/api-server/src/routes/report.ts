import { Router, type IRouter } from "express";
import { db, inventoryTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  queryGsc,
  queryGscDimension,
  withCache,
  GSC_CACHE_TTL_MS,
} from "../integrations/gsc";
import { queryGa4Pages } from "../integrations/ga4";

const router: IRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOP_QUERIES_PER_PAGE = 10;

function validateRange(
  req: { query: Record<string, unknown> },
): { startDate: string; endDate: string } | { error: string } {
  const startDate = String(req.query["startDate"] ?? "");
  const endDate = String(req.query["endDate"] ?? "");
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return { error: "startDate and endDate must be YYYY-MM-DD" };
  }
  if (startDate > endDate) return { error: "startDate must be <= endDate" };
  return { startDate, endDate };
}

// Collapse an absolute GSC URL or a GA4/inventory path into one comparable key:
// drop the origin, query string and hash, lowercase, and strip a trailing slash.
// Mirrors normalizePath() in integrations/ga4.ts so the three sources line up.
function toPathKey(u: string): string {
  let p = u;
  if (/^https?:\/\//i.test(u)) {
    try {
      p = new URL(u).pathname;
    } catch {
      /* keep raw */
    }
  }
  const noQuery = p.split("?")[0] ?? p;
  const noHash = noQuery.split("#")[0] ?? noQuery;
  let s = noHash.toLowerCase();
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s || "/";
}

interface QueryRow {
  query: string;
  position: number;
  impressions: number;
  clicks: number;
}

interface PageAcc {
  path: string;
  title: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  sessions: number;
  engagementRate: number;
  engagedSessions: number;
  avgEngagementTime: number;
  queries: QueryRow[];
}

router.get("/report/pages", requireAuth, async (req, res) => {
  const v = validateRange(req);
  if ("error" in v) {
    res.status(400).json({ error: v.error });
    return;
  }
  const { startDate, endDate } = v;
  try {
    // v2: added engagedSessions + avgEngagementTime — bump on shape change.
    const key = `report:pages:v2|${startDate}|${endDate}`;
    const data = await withCache(key, GSC_CACHE_TTL_MS, async () => {
      // GSC is the core source (page aggregates + per-query rows). GA4 is
      // best-effort so the report still renders if its quota is exhausted.
      const [pageAgg, pageQueryRows, inv] = await Promise.all([
        queryGscDimension({ startDate, endDate, dimension: "page", rowLimit: 5000 }),
        queryGsc({ startDate, endDate, dimensions: ["page", "query"], rowLimit: 25000 }),
        db
          .select({ url: inventoryTable.url, title: inventoryTable.title })
          .from(inventoryTable),
      ]);

      let ga4Rows: {
        path: string;
        sessions: number;
        engagementRate: number;
        engagedSessions: number;
        avgEngagementTime: number;
      }[] = [];
      let ga4Notice = "";
      try {
        const ga4 = await queryGa4Pages({ startDate, endDate });
        ga4Rows = ga4.rows;
      } catch (err) {
        req.log.error({ err }, "GA4 fetch failed in page report");
        ga4Notice = "GA4 engagement data is temporarily unavailable.";
      }

      const map = new Map<string, PageAcc>();
      const ensure = (path: string): PageAcc => {
        let a = map.get(path);
        if (!a) {
          a = {
            path,
            title: "",
            position: 0,
            impressions: 0,
            clicks: 0,
            ctr: 0,
            sessions: 0,
            engagementRate: 0,
            engagedSessions: 0,
            avgEngagementTime: 0,
            queries: [],
          };
          map.set(path, a);
        }
        return a;
      };

      // Seed every canonical page so pages with no traffic still appear.
      for (const r of inv) {
        const a = ensure(toPathKey(r.url));
        if (!a.title && r.title) a.title = r.title;
      }
      // GSC per-page aggregates (matches the GSC Pages view).
      for (const r of pageAgg) {
        const a = ensure(toPathKey(r.key));
        a.position = r.position;
        a.impressions = r.impressions;
        a.clicks = r.clicks;
        a.ctr = r.ctr;
      }
      // GSC per-query rows grouped by page.
      for (const r of pageQueryRows) {
        if (!r.query) continue;
        const a = ensure(toPathKey(r.url));
        a.queries.push({
          query: r.query,
          position: r.position,
          impressions: r.impressions,
          clicks: r.clicks,
        });
      }
      // GA4 engagement per path.
      for (const r of ga4Rows) {
        const a = ensure(toPathKey(r.path));
        a.sessions = r.sessions;
        a.engagementRate = r.engagementRate;
        a.engagedSessions = r.engagedSessions;
        a.avgEngagementTime = r.avgEngagementTime;
      }

      let tImp = 0;
      let tClk = 0;
      let tSes = 0;
      let engWeighted = 0;
      let posSum = 0;
      let posWeight = 0;
      const rows = Array.from(map.values()).map((a) => {
        a.queries.sort((x, y) => y.impressions - x.impressions);
        tImp += a.impressions;
        tClk += a.clicks;
        tSes += a.sessions;
        engWeighted += a.engagementRate * a.sessions;
        posSum += a.position * a.impressions;
        posWeight += a.impressions;
        return {
          path: a.path,
          title: a.title,
          position: a.position,
          impressions: a.impressions,
          clicks: a.clicks,
          ctr: a.ctr,
          sessions: a.sessions,
          engagementRate: a.engagementRate,
          engagedSessions: a.engagedSessions,
          avgEngagementTime: a.avgEngagementTime,
          queryCount: a.queries.length,
          topQueries: a.queries.slice(0, TOP_QUERIES_PER_PAGE),
        };
      });
      rows.sort((x, y) => y.impressions - x.impressions || y.sessions - x.sessions);

      const totals = {
        impressions: tImp,
        clicks: tClk,
        sessions: tSes,
        position: posWeight > 0 ? posSum / posWeight : 0,
        engagementRate: tSes > 0 ? engWeighted / tSes : 0,
      };

      return { startDate, endDate, ga4Notice, rows, totals };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Page report failed");
    res.status(502).json({ error: "Report fetch failed" });
  }
});

export default router;
