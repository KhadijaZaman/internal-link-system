import { Router, type IRouter } from "express";
import { db, inventoryTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  queryGsc,
  queryGscDimension,
  withCache,
  GSC_CACHE_TTL_MS,
} from "../integrations/gsc";
import { queryGa4Pages, type Ga4Channel } from "../integrations/ga4";
import { canonicalPath, isBlockedPath, loadBlockRegexes } from "../lib/urlCanon";
import { pageVerdicts } from "../lib/insights";

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

function validateChannel(req: { query: Record<string, unknown> }): Ga4Channel | null {
  const c = String(req.query["channel"] ?? "organic");
  return c === "organic" || c === "all" ? c : null;
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
  keyEvents: number;
  aiSessions: number;
  queries: QueryRow[];
}

router.get("/report/pages", requireAuth, async (req, res) => {
  const v = validateRange(req);
  if ("error" in v) {
    res.status(400).json({ error: v.error });
    return;
  }
  const channel = validateChannel(req);
  if (!channel) {
    res.status(400).json({ error: "channel must be 'organic' or 'all'" });
    return;
  }
  const { startDate, endDate } = v;
  try {
    // v6: adds server-computed per-row verdicts (low_ctr / weak_engagement /
    // no_conversions / ai_only). v5 = key events no longer host-filtered.
    const key = `report:pages:v6|${channel}|${startDate}|${endDate}`;
    const data = await withCache(key, GSC_CACHE_TTL_MS, async () => {
      // GSC is the core source (page aggregates + per-query rows). GA4 is
      // best-effort so the report still renders if its quota is exhausted.
      const [pageAgg, pageQueryRows, inv, block] = await Promise.all([
        queryGscDimension({ startDate, endDate, dimension: "page", rowLimit: 5000 }),
        queryGsc({ startDate, endDate, dimensions: ["page", "query"], rowLimit: 25000 }),
        db
          .select({ url: inventoryTable.url, title: inventoryTable.title })
          .from(inventoryTable),
        loadBlockRegexes(),
      ]);
      // Shared canonical key: fragment/query/slash variants collapse onto one
      // path; blocklisted app-screen paths and foreign hosts are dropped.
      const toPathKey = (u: string): string | null => {
        const p = canonicalPath(u);
        if (!p || isBlockedPath(p, block)) return null;
        return p;
      };

      let ga4Rows: {
        path: string;
        sessions: number;
        engagementRate: number;
        engagedSessions: number;
        avgEngagementTime: number;
        keyEvents: number;
        aiSessions: number;
      }[] = [];
      let ga4Notice = "";
      try {
        const ga4 = await queryGa4Pages({ startDate, endDate, channel });
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
            keyEvents: 0,
            aiSessions: 0,
            queries: [],
          };
          map.set(path, a);
        }
        return a;
      };

      // Seed every canonical page so pages with no traffic still appear.
      for (const r of inv) {
        const key = toPathKey(r.url);
        if (!key) continue;
        const a = ensure(key);
        if (!a.title && r.title) a.title = r.title;
      }
      // GSC per-page aggregates (matches the GSC Pages view). Fragment /
      // slash variants collapse onto the same canonical path, so SUM clicks
      // and impressions and impression-weight the position — never overwrite.
      for (const r of pageAgg) {
        const key = toPathKey(r.key);
        if (!key) continue;
        const a = ensure(key);
        const prevW = Math.max(a.impressions, a.impressions > 0 || a.clicks > 0 ? 1 : 0);
        const w = Math.max(r.impressions, 1);
        a.position =
          prevW + w > 0 ? (a.position * prevW + r.position * w) / (prevW + w) : r.position;
        a.impressions += r.impressions;
        a.clicks += r.clicks;
        a.ctr = a.impressions > 0 ? a.clicks / a.impressions : 0;
      }
      // GSC per-query rows grouped by page; variants of the same page merge
      // per query with the same sum/weighted rules.
      for (const r of pageQueryRows) {
        if (!r.query) continue;
        const key = toPathKey(r.url);
        if (!key) continue;
        const a = ensure(key);
        const existing = a.queries.find((q) => q.query === r.query);
        if (existing) {
          const prevW = Math.max(existing.impressions, 1);
          const w = Math.max(r.impressions, 1);
          existing.position = (existing.position * prevW + r.position * w) / (prevW + w);
          existing.impressions += r.impressions;
          existing.clicks += r.clicks;
        } else {
          a.queries.push({
            query: r.query,
            position: r.position,
            impressions: r.impressions,
            clicks: r.clicks,
          });
        }
      }
      // GA4 engagement per path (already canonical + blocklisted upstream).
      for (const r of ga4Rows) {
        const key = toPathKey(r.path);
        if (!key) continue;
        const a = ensure(key);
        a.sessions = r.sessions;
        a.engagementRate = r.engagementRate;
        a.engagedSessions = r.engagedSessions;
        a.avgEngagementTime = r.avgEngagementTime;
        a.keyEvents = r.keyEvents;
        a.aiSessions = r.aiSessions;
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
          keyEvents: a.keyEvents,
          aiSessions: a.aiSessions,
          queryCount: a.queries.length,
          topQueries: a.queries.slice(0, TOP_QUERIES_PER_PAGE),
          verdicts: pageVerdicts(a),
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
