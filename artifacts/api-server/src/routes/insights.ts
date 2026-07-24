import { Router, type IRouter } from "express";
import { db, pagesTable, queryLosersTable, jobRunsTable } from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { withCache, GSC_CACHE_TTL_MS } from "../integrations/gsc";
import { canonicalPath, isBlockedPath, loadBlockRegexes } from "../lib/urlCanon";
import {
  ctrInsight,
  searchEngineGap,
  bingUpside,
  aiVisibilityGap,
} from "../lib/insights";

const router: IRouter = Router();

const TOP_PAGES_PER_INSIGHT = 8;

interface RollupRow {
  path: string;
  title: string | null;
  topQuery: string | null;
  gscClicks: number | null;
  gscImpressions: number | null;
  gscPosition: number | null;
  bingClicks: number | null;
  bingImpressions: number | null;
  bingPosition: number | null;
  aiCitations: number | null;
  aiSessions: number | null;
  keyEvents: number | null;
  ga4SyncedAt: Date | null;
  bingSyncedAt: Date | null;
  aiCitationsAt: Date | null;
}

/** SeoInsightPage shape from the contract — one row per affected page. */
function toInsightPage(p: RollupRow, detail: string | null) {
  return {
    path: p.path,
    title: p.title,
    gscClicks: p.gscClicks ?? 0,
    gscImpressions: p.gscImpressions ?? 0,
    gscPosition: p.gscPosition,
    bingClicks: p.bingClicks ?? 0,
    bingImpressions: p.bingImpressions ?? 0,
    bingPosition: p.bingPosition,
    aiCitations: p.aiCitations ?? 0,
    aiSessions: p.aiSessions ?? 0,
    keyEvents: p.keyEvents ?? 0,
    detail,
  };
}

/**
 * Site-level cross-source SEO insights. Reads ONLY stored rollups (pages
 * table + query_losers latest week) — zero external API calls, zero paid
 * spend. Windows differ per source (GSC = latest sync, GA4 = 28d, Bing =
 * ~6-month rolling, AI citations = latest upload), so all cross-engine rules
 * compare visibility rather than raw click magnitudes, and the response
 * carries per-source freshness timestamps for honest footnotes.
 */
router.get("/insights/overview", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  try {
    const key = `s${site.id}|insights:v2`;
    const data = await withCache(key, GSC_CACHE_TTL_MS, async () => {
      const [pages, blockRegexes, [gscJob], latestLoserWeek] = await Promise.all([
        db
          .select({
            path: pagesTable.path,
            title: pagesTable.title,
            topQuery: pagesTable.topQuery,
            gscClicks: pagesTable.clicks,
            gscImpressions: pagesTable.impressions,
            gscPosition: pagesTable.position,
            bingClicks: pagesTable.bingClicks,
            bingImpressions: pagesTable.bingImpressions,
            bingPosition: pagesTable.bingPosition,
            aiCitations: pagesTable.aiCitations,
            aiSessions: pagesTable.aiSessions,
            keyEvents: pagesTable.keyEvents,
            ga4SyncedAt: pagesTable.ga4SyncedAt,
            bingSyncedAt: pagesTable.bingSyncedAt,
            aiCitationsAt: pagesTable.aiCitationsAt,
          })
          .from(pagesTable)
          .where(
            and(
              eq(pagesTable.siteId, site.id),
              sql`(coalesce(${pagesTable.clicks}, 0) > 0
                OR coalesce(${pagesTable.impressions}, 0) > 0
                OR coalesce(${pagesTable.bingClicks}, 0) > 0
                OR coalesce(${pagesTable.bingImpressions}, 0) > 0
                OR coalesce(${pagesTable.aiCitations}, 0) > 0
                OR coalesce(${pagesTable.aiSessions}, 0) > 0
                OR coalesce(${pagesTable.keyEvents}, 0) > 0)`,
            ),
          ),
        loadBlockRegexes(site.id),
        db
          .select({ lastRunAt: jobRunsTable.lastRunAt })
          .from(jobRunsTable)
          .where(
            and(
              eq(jobRunsTable.name, "gsc_inventory_and_losers"),
              eq(jobRunsTable.siteId, site.id),
            ),
          )
          .limit(1),
        db
          .select({ weekOf: queryLosersTable.weekOf })
          .from(queryLosersTable)
          .where(eq(queryLosersTable.siteId, site.id))
          .orderBy(desc(queryLosersTable.weekOf))
          .limit(1),
      ]);

      const visible: RollupRow[] = pages.filter(
        (p) => !isBlockedPath(p.path, blockRegexes),
      );
      const byPath = new Map(visible.map((p) => [p.path, p]));

      // ---- KPI totals + freshness --------------------------------------
      const kpis = {
        pages: visible.length,
        gscClicks: 0,
        gscImpressions: 0,
        bingClicks: 0,
        bingImpressions: 0,
        aiCitations: 0,
        aiSessions: 0,
        keyEvents: 0,
        missedClicks: 0,
      };
      let ga4SyncedAt: Date | null = null;
      let bingSyncedAt: Date | null = null;
      let aiCitationsAt: Date | null = null;
      for (const p of visible) {
        kpis.gscClicks += p.gscClicks ?? 0;
        kpis.gscImpressions += p.gscImpressions ?? 0;
        kpis.bingClicks += p.bingClicks ?? 0;
        kpis.bingImpressions += p.bingImpressions ?? 0;
        kpis.aiCitations += p.aiCitations ?? 0;
        kpis.aiSessions += p.aiSessions ?? 0;
        kpis.keyEvents += p.keyEvents ?? 0;
        if (p.ga4SyncedAt && (!ga4SyncedAt || p.ga4SyncedAt > ga4SyncedAt)) {
          ga4SyncedAt = p.ga4SyncedAt;
        }
        if (p.bingSyncedAt && (!bingSyncedAt || p.bingSyncedAt > bingSyncedAt)) {
          bingSyncedAt = p.bingSyncedAt;
        }
        if (p.aiCitationsAt && (!aiCitationsAt || p.aiCitationsAt > aiCitationsAt)) {
          aiCitationsAt = p.aiCitationsAt;
        }
      }

      // ---- Insight buckets (pure rules from lib/insights) ---------------
      const lowCtr: { row: RollupRow; missed: number }[] = [];
      const blindSpot: RollupRow[] = [];
      const upside: RollupRow[] = [];
      const aiGap: RollupRow[] = [];
      for (const p of visible) {
        const impressions = p.gscImpressions ?? 0;
        const clicks = p.gscClicks ?? 0;
        if (p.gscPosition !== null && impressions > 0) {
          const c = ctrInsight(p.gscPosition, clicks / impressions, impressions);
          if (c.ctrFlag === "underperforming") {
            lowCtr.push({ row: p, missed: c.missedClicks });
            kpis.missedClicks += c.missedClicks;
          }
        }
        if (searchEngineGap(p)) blindSpot.push(p);
        if (bingUpside(p)) upside.push(p);
        if (aiVisibilityGap(p)) aiGap.push(p);
      }
      lowCtr.sort((a, b) => b.missed - a.missed);
      blindSpot.sort((a, b) => (b.gscImpressions ?? 0) - (a.gscImpressions ?? 0));
      upside.sort((a, b) => (b.bingImpressions ?? 0) - (a.bingImpressions ?? 0));
      aiGap.sort(
        (a, b) =>
          (b.aiCitations ?? 0) + (b.aiSessions ?? 0) - ((a.aiCitations ?? 0) + (a.aiSessions ?? 0)),
      );

      // ---- Declining queries (latest query_losers week) ------------------
      const week = latestLoserWeek[0]?.weekOf ?? null;
      let losers: {
        url: string;
        query: string;
        prevPosition: number | null;
        currPosition: number | null;
        severity: string | null;
      }[] = [];
      if (week) {
        losers = await db
          .select({
            url: queryLosersTable.url,
            query: queryLosersTable.query,
            prevPosition: queryLosersTable.prevPosition,
            currPosition: queryLosersTable.currPosition,
            severity: queryLosersTable.severity,
          })
          .from(queryLosersTable)
          .where(
            and(eq(queryLosersTable.siteId, site.id), eq(queryLosersTable.weekOf, week)),
          );
      }
      // Group losers per canonical page; keep the worst drop as the headline.
      const severityRank: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
      const loserPages = new Map<
        string,
        { count: number; worst: (typeof losers)[number]; worstRank: number }
      >();
      for (const l of losers) {
        const path = canonicalPath(l.url, site.host);
        if (!path || isBlockedPath(path, blockRegexes)) continue;
        const rank = severityRank[l.severity ?? ""] ?? 0;
        const existing = loserPages.get(path);
        if (!existing) {
          loserPages.set(path, { count: 1, worst: l, worstRank: rank });
        } else {
          existing.count += 1;
          if (rank > existing.worstRank) {
            existing.worst = l;
            existing.worstRank = rank;
          }
        }
      }
      const decliningSorted = Array.from(loserPages.entries()).sort(
        (a, b) => b[1].worstRank - a[1].worstRank || b[1].count - a[1].count,
      );
      const hasCritical = decliningSorted.some(([, v]) => v.worstRank >= 2);

      const emptyRollup = (path: string): RollupRow => ({
        path,
        title: null,
        topQuery: null,
        gscClicks: null,
        gscImpressions: null,
        gscPosition: null,
        bingClicks: null,
        bingImpressions: null,
        bingPosition: null,
        aiCitations: null,
        aiSessions: null,
        keyEvents: null,
        ga4SyncedAt: null,
        bingSyncedAt: null,
        aiCitationsAt: null,
      });

      const fmtPos = (n: number | null) => (n === null ? "?" : `#${Math.round(n)}`);

      const insights: object[] = [];
      if (lowCtr.length > 0) {
        insights.push({
          id: "low_ctr",
          severity: "opportunity",
          title: "Pages ranking well but losing the click",
          plainEnglish: `${lowCtr.length} page${lowCtr.length === 1 ? "" : "s"} rank in Google's top 10 but earn far fewer clicks than pages at that position normally get — roughly ${kpis.missedClicks.toLocaleString()} clicks were left on the table in the last Google window. Searchers see these pages and scroll past, which almost always means the title or description isn't selling the click.`,
          action:
            "Rewrite the page title and meta description to match what searchers actually want — lead with the benefit, include the exact search phrase, and keep titles under ~60 characters.",
          affectedCount: lowCtr.length,
          topPages: lowCtr.slice(0, TOP_PAGES_PER_INSIGHT).map(({ row, missed }) =>
            toInsightPage(
              row,
              `~${missed.toLocaleString()} clicks missed at ${fmtPos(row.gscPosition)}${row.topQuery ? ` for “${row.topQuery}”` : ""}`,
            ),
          ),
        });
      }
      // Only flag "invisible on Bing" when Bing data has actually synced —
      // otherwise a site without the Bing connection would see every strong
      // Google page reported as a blind spot (absence of data ≠ a finding).
      if (blindSpot.length > 0 && bingSyncedAt !== null) {
        insights.push({
          id: "bing_blind_spot",
          severity: "issue",
          title: "Winning on Google, invisible on Bing",
          plainEnglish: `${blindSpot.length} page${blindSpot.length === 1 ? "" : "s"} get real visibility on Google but essentially never appear on Bing — even across Bing's entire six-month window. That usually means Bing hasn't indexed them, which also keeps them out of Microsoft Copilot's AI answers. This is free traffic being left behind, not a content problem.`,
          action:
            "Submit these URLs in Bing Webmaster Tools (URL Submission / IndexNow) and confirm they aren't blocked in robots.txt — Bing indexing is the fix, not new content.",
          affectedCount: blindSpot.length,
          topPages: blindSpot.slice(0, TOP_PAGES_PER_INSIGHT).map((p) =>
            toInsightPage(
              p,
              `${(p.gscImpressions ?? 0).toLocaleString()} Google impressions vs ${(p.bingImpressions ?? 0).toLocaleString()} on Bing`,
            ),
          ),
        });
      }
      if (aiGap.length > 0) {
        insights.push({
          id: "ai_visibility_gap",
          severity: "opportunity",
          title: "AI assistants cite these pages — Google sends nothing",
          plainEnglish: `${aiGap.length} page${aiGap.length === 1 ? "" : "s"} are being quoted by AI assistants (Copilot citations or AI-referral visits) while classic Google search sends zero clicks. The content is clearly authoritative — machines picked it — but the regular search listing isn't winning the human click.`,
          action:
            "Treat these as proven-quality pages: check how they look in Google (title, description, indexing status) and strengthen internal links pointing at them so classic search catches up with the AI visibility.",
          affectedCount: aiGap.length,
          topPages: aiGap.slice(0, TOP_PAGES_PER_INSIGHT).map((p) => {
            const bits: string[] = [];
            if ((p.aiCitations ?? 0) > 0) bits.push(`${p.aiCitations} AI citation${p.aiCitations === 1 ? "" : "s"}`);
            if ((p.aiSessions ?? 0) > 0) bits.push(`${p.aiSessions} AI visit${p.aiSessions === 1 ? "" : "s"}`);
            return toInsightPage(p, `${bits.join(" + ")}, 0 Google clicks`);
          }),
        });
      }
      if (upside.length > 0) {
        insights.push({
          id: "bing_upside",
          severity: "opportunity",
          title: "Bing shows these pages a lot but ranks them low",
          plainEnglish: `${upside.length} page${upside.length === 1 ? "" : "s"} appear often in Bing searches but rank outside the top 10 there. The demand exists and the pages are indexed — a modest push could win clicks on Bing (and Copilot) that your Google work already earned elsewhere.`,
          action:
            "Pick the top pages here and tighten them for their main keyword — clearer headings, the exact phrase in the title, and a few internal links with descriptive anchor text.",
          affectedCount: upside.length,
          topPages: upside.slice(0, TOP_PAGES_PER_INSIGHT).map((p) =>
            toInsightPage(
              p,
              `Shown ${(p.bingImpressions ?? 0).toLocaleString()} times on Bing, ranking ${fmtPos(p.bingPosition)}`,
            ),
          ),
        });
      }
      if (decliningSorted.length > 0) {
        insights.push({
          id: "declining_queries",
          severity: hasCritical ? "issue" : "watch",
          title: "Keywords slipping in Google this week",
          plainEnglish: `${decliningSorted.length} page${decliningSorted.length === 1 ? "" : "s"} lost ground on at least one keyword in the latest weekly comparison. Rankings wobble naturally, but sustained drops — especially on money keywords — are the earliest warning you get before traffic falls.`,
          action:
            "Review the biggest drops below: refresh the content (update facts, add missing subtopics) and add an internal link or two from strong related pages.",
          affectedCount: decliningSorted.length,
          topPages: decliningSorted.slice(0, TOP_PAGES_PER_INSIGHT).map(([path, v]) => {
            const row = byPath.get(path) ?? emptyRollup(path);
            const w = v.worst;
            const move = `“${w.query}” slipped ${fmtPos(w.prevPosition)} → ${fmtPos(w.currPosition)}`;
            const extra = v.count > 1 ? ` (+${v.count - 1} more keyword${v.count === 2 ? "" : "s"})` : "";
            return toInsightPage(row, `${move}${extra}`);
          }),
        });
      }

      return {
        freshness: {
          gscSyncedAt: gscJob?.lastRunAt?.toISOString() ?? null,
          ga4SyncedAt: ga4SyncedAt?.toISOString() ?? null,
          bingSyncedAt: bingSyncedAt?.toISOString() ?? null,
          aiCitationsAt: aiCitationsAt?.toISOString() ?? null,
        },
        kpis,
        insights,
      };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "SEO insights failed");
    res.status(500).json({ error: "Insights computation failed" });
  }
});

export default router;
