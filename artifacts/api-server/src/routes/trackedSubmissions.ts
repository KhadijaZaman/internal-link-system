import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  trackedSubmissionsTable,
  bingPageStatsTable,
  aiCitationUploadsTable,
  aiCitationRowsTable,
  clusterRunsTable,
  clusterRunClustersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import {
  CreateTrackedSubmissionsBody,
  UpdateTrackedSubmissionBody,
  ExportSubmissionsSheetBody,
} from "@workspace/api-zod";
import {
  exportKeywordMovementSheet,
  getStoredSheetUrl,
  isStoredSheetShared,
  NoTrackedKeywordsError,
} from "../services/keywordMovementSheet";
import {
  queryGscDimension,
  aggregateTotals,
  inspectUrl,
  withCache,
  GSC_CACHE_TTL_MS,
  pageVariantsRegex,
  keywordExactRegex,
  type GscDimensionRow,
} from "../integrations/gsc";
import { queryGa4PathDaily } from "../integrations/ga4";
import { ga4DayPoint, aggregateGa4Days } from "../lib/ga4Daily";
import { aggregateBingWeeks } from "../lib/bingWeeks";
import { buildActionPlan } from "../lib/actionPlan";
import { canonicalPath, normalizeHost } from "../lib/urlCanon";
import { getBingApiKey, IntegrationNotConnectedError } from "../lib/siteIntegrations";
import { loadCannibalizedQueries } from "./gsc";

const router: IRouter = Router();

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function serialize(t: typeof trackedSubmissionsTable.$inferSelect) {
  return {
    id: t.id,
    url: t.url,
    keyword: t.keyword,
    label: t.label,
    note: t.note,
    status: t.status,
    createdAt: (t.createdAt ?? new Date()).toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
  };
}

router.get("/tracked-submissions", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const rows = await db
    .select()
    .from(trackedSubmissionsTable)
    .where(eq(trackedSubmissionsTable.siteId, site.id))
    .orderBy(desc(trackedSubmissionsTable.createdAt));
  res.json(rows.map(serialize));
});

router.post("/tracked-submissions", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = CreateTrackedSubmissionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const note = parsed.data.note?.trim() || null;
  // Legacy shared keyword doubles as the default for items without their own.
  const defaultKeyword = parsed.data.keyword?.trim() || null;

  const rawItems: { url: string; keyword: string | null }[] = [
    ...(parsed.data.items ?? []).map((it) => ({
      url: it.url.trim(),
      keyword: it.keyword?.trim() || defaultKeyword,
    })),
    ...(parsed.data.urls ?? []).map((u) => ({
      url: u.trim(),
      keyword: defaultKeyword,
    })),
  ];

  const seen = new Set<string>();
  const items = rawItems
    .filter((it) => it.url.length > 0 && isHttpUrl(it.url))
    .filter((it) => {
      const key = it.url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (items.length === 0) {
    res.status(400).json({ error: "No valid http(s) URLs" });
    return;
  }

  // Upsert by URL: re-pasting a list updates keywords instead of duplicating.
  // Case-insensitive match so re-pasting with different casing can't duplicate.
  const existing = await db
    .select()
    .from(trackedSubmissionsTable)
    .where(
      and(
        eq(trackedSubmissionsTable.siteId, site.id),
        inArray(
          sql`lower(${trackedSubmissionsTable.url})`,
          items.map((it) => it.url.toLowerCase()),
        ),
      ),
    );
  const byUrl = new Map(existing.map((row) => [row.url.toLowerCase(), row]));

  const toInsert: {
    siteId: number;
    url: string;
    note: string | null;
    keyword: string | null;
  }[] = [];
  const results: (typeof trackedSubmissionsTable.$inferSelect)[] = [];
  for (const it of items) {
    const ex = byUrl.get(it.url.toLowerCase());
    if (!ex) {
      toInsert.push({ siteId: site.id, url: it.url, note, keyword: it.keyword });
      continue;
    }
    if (it.keyword && it.keyword !== ex.keyword) {
      const updated = await db
        .update(trackedSubmissionsTable)
        .set({ keyword: it.keyword })
        .where(
          and(
            eq(trackedSubmissionsTable.id, ex.id),
            eq(trackedSubmissionsTable.siteId, site.id),
          ),
        )
        .returning();
      if (updated[0]) results.push(updated[0]);
    } else {
      results.push(ex);
    }
  }
  if (toInsert.length > 0) {
    const inserted = await db
      .insert(trackedSubmissionsTable)
      .values(toInsert)
      .returning();
    results.push(...inserted);
  }
  res.status(201).json(results.map(serialize));
});

router.patch("/tracked-submissions/:id", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = UpdateTrackedSubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const patch: Partial<typeof trackedSubmissionsTable.$inferInsert> = {};
  if (parsed.data.status !== undefined) {
    patch.status = parsed.data.status;
    patch.completedAt = parsed.data.status === "done" ? new Date() : null;
  }
  if (parsed.data.keyword !== undefined) {
    patch.keyword = parsed.data.keyword?.trim() || null;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const updated = await db
    .update(trackedSubmissionsTable)
    .set(patch)
    .where(
      and(
        eq(trackedSubmissionsTable.id, id),
        eq(trackedSubmissionsTable.siteId, site.id),
      ),
    )
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serialize(updated[0]!));
});

router.delete("/tracked-submissions/:id", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(trackedSubmissionsTable)
    .where(
      and(
        eq(trackedSubmissionsTable.id, id),
        eq(trackedSubmissionsTable.siteId, site.id),
      ),
    );
  res.json({ ok: true });
});

// ---------- Google Sheets export (GSC + Sheets only — no crawl, no AI) ----------

// Pure DB read — surfaces the persistent per-site movement sheet's URL so
// owners whose sheet was created by the daily job can find/bookmark it.
router.get(
  "/tracked-submissions/movement-sheet",
  requireAuth,
  requireSite,
  async (req, res) => {
    const site = getSite(req);
    const [url, shared] = await Promise.all([
      getStoredSheetUrl(site.id),
      isStoredSheetShared(site.id),
    ]);
    res.json({ url, shared });
  },
);

router.post("/tracked-submissions/export-sheet", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const parsed = ExportSubmissionsSheetBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const days = parsed.data.days ?? 90;
  try {
    const result = await exportKeywordMovementSheet(days, site);
    req.log.info(
      { keywordCount: result.keywordCount, days },
      "exported keyword movement sheet",
    );
    res.json(result);
  } catch (err) {
    if (err instanceof NoTrackedKeywordsError) {
      res.status(400).json({ error: "No tracked submissions with a target keyword" });
      return;
    }
    req.log.error({ err }, "keyword movement sheet export failed");
    res.status(502).json({ error: "Search Console or Google Sheets request failed" });
  }
});

// ---------- Per-URL report (GSC + Bing + GA4 + indexing — no crawl, no AI spend) ----------

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toSeriesPoint(r: GscDimensionRow) {
  return {
    date: r.key,
    clicks: Math.round(r.clicks),
    impressions: Math.round(r.impressions),
    ctr: r.ctr,
    position: r.position,
  };
}

function normKeyword(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

const INSPECT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // index status moves slowly

type SectionStatus = "ok" | "not_connected" | "error";
interface Section<T> {
  status: SectionStatus;
  data: T | null;
}

/**
 * Run one report section: connection problems become `not_connected`,
 * anything else becomes `error` — one broken source never sinks the report.
 */
async function runSection<T>(
  label: string,
  log: { error: (obj: unknown, msg: string) => void },
  fn: () => Promise<T>,
): Promise<Section<T>> {
  try {
    return { status: "ok", data: await fn() };
  } catch (err) {
    if (err instanceof IntegrationNotConnectedError) {
      return { status: "not_connected", data: null };
    }
    log.error({ err, section: label }, "tracked report section failed");
    return { status: "error", data: null };
  }
}

router.get(
  "/tracked-submissions/:id/report",
  requireAuth,
  requireSite,
  async (req, res) => {
    const site = getSite(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const daysRaw = Number(req.query["days"] ?? 28);
    const days = Math.min(180, Math.max(7, Number.isFinite(daysRaw) ? Math.round(daysRaw) : 28));
    const countryRaw = typeof req.query["country"] === "string" ? req.query["country"].trim() : "";
    // "all" is rejected: it's the worldwide cache-key sentinel, not an ISO code.
    if (countryRaw && (!/^[A-Za-z]{3}$/.test(countryRaw) || countryRaw.toLowerCase() === "all")) {
      res.status(400).json({ error: "country must be a 3-letter ISO code" });
      return;
    }
    const country = countryRaw ? countryRaw.toLowerCase() : null;

    const rows = await db
      .select()
      .from(trackedSubmissionsTable)
      .where(
        and(
          eq(trackedSubmissionsTable.id, id),
          eq(trackedSubmissionsTable.siteId, site.id),
        ),
      );
    const sub = rows[0];
    if (!sub) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // GSC data lags ~2 days behind real time; Bing/GA4 reuse the same window.
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 2);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const prevStart = new Date(start);
    prevStart.setUTCDate(prevStart.getUTCDate() - days);

    const endDate = isoDay(end);
    const startDate = isoDay(start);
    const prevStartDate = isoDay(prevStart);
    const pageRegex = pageVariantsRegex(sub.url);
    const keyword = sub.keyword?.trim() || null;
    // Bing/GA4/AI-citation rows are keyed by canonical path; null = foreign URL.
    const path = canonicalPath(sub.url, site.host);

    // ----- GSC: daily series + top queries (cached, same shape as before) -----
    const loadGsc = async () => {
      const cacheKey = `s${site.id}|tracked-gsc:v1:${id}:${sub.url}:${keyword ?? ""}:${days}:${country ?? "all"}:${endDate}`;
      return withCache(cacheKey, GSC_CACHE_TTL_MS, async () => {
        // One call per scope covering current + previous window, split locally.
        const countryFilter = country ?? undefined;
        const [overallDaily, keywordDaily, queryRows] = await Promise.all([
          queryGscDimension({
            siteId: site.id,
            startDate: prevStartDate,
            endDate,
            dimension: "date",
            pageRegex,
            countryFilter,
          }),
          keyword
            ? queryGscDimension({
                siteId: site.id,
                startDate: prevStartDate,
                endDate,
                dimension: "date",
                pageRegex,
                queryFilter: {
                  expression: keywordExactRegex(keyword),
                  operator: "includingRegex",
                },
                countryFilter,
              })
            : Promise.resolve([] as GscDimensionRow[]),
          queryGscDimension({
            siteId: site.id,
            startDate,
            endDate,
            dimension: "query",
            pageRegex,
            rowLimit: 25,
            countryFilter,
          }),
        ]);

        const splitWindow = (daily: GscDimensionRow[]) => {
          const current = daily.filter((r) => r.key >= startDate);
          const previous = daily.filter((r) => r.key < startDate);
          return { current, previous };
        };

        const overall = splitWindow(overallDaily);
        const kw = splitWindow(keywordDaily);

        const topQueries = queryRows
          .slice()
          .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks)
          .slice(0, 10)
          .map((r) => ({
            query: r.key,
            clicks: Math.round(r.clicks),
            impressions: Math.round(r.impressions),
            ctr: r.ctr,
            position: r.position,
            isTracked: keyword != null && normKeyword(r.key) === normKeyword(keyword),
          }));

        return {
          overallSeries: overall.current.map(toSeriesPoint),
          overallTotals: aggregateTotals(overall.current),
          overallPrevTotals:
            overall.previous.length > 0 ? aggregateTotals(overall.previous) : null,
          keywordSeries: kw.current.map(toSeriesPoint),
          keywordTotals: keyword && kw.current.length > 0 ? aggregateTotals(kw.current) : null,
          keywordPrevTotals:
            keyword && kw.previous.length > 0 ? aggregateTotals(kw.previous) : null,
          topQueries,
        };
      });
    };

    // ----- Bing: weekly buckets already synced to the DB (no API call) -----
    const loadBing = async () => {
      // Throws IntegrationNotConnectedError when Bing isn't set up for this
      // site — the stored rows would be stale leftovers, so don't show them.
      await getBingApiKey(site.id);
      if (!path) return aggregateBingWeeks([]);
      const bingRows = await db
        .select({
          bucketDate: bingPageStatsTable.bucketDate,
          clicks: bingPageStatsTable.clicks,
          impressions: bingPageStatsTable.impressions,
          position: bingPageStatsTable.position,
        })
        .from(bingPageStatsTable)
        .where(
          and(eq(bingPageStatsTable.siteId, site.id), eq(bingPageStatsTable.path, path)),
        );
      return aggregateBingWeeks(bingRows);
    };

    // ----- GA4: daily engagement for this landing page (all channels) -----
    const loadGa4 = async () => {
      if (!path) {
        return { series: [], totals: aggregateGa4Days([]), prevTotals: null };
      }
      // One fetch spans previous + current window; split locally by date.
      const allDays = await queryGa4PathDaily({
        startDate: prevStartDate,
        endDate,
        path,
        site: { id: site.id, host: site.host },
      });
      const current = allDays.filter((d) => d.date >= startDate);
      const previous = allDays.filter((d) => d.date < startDate);
      return {
        series: current.map(ga4DayPoint),
        totals: aggregateGa4Days(current),
        prevTotals: previous.length > 0 ? aggregateGa4Days(previous) : null,
      };
    };

    // ----- Indexing: GSC URL Inspection (1 quota unit, cached 24h) -----
    const loadIndexing = async () => {
      return withCache(`s${site.id}|tracked-inspect:v1|${sub.url}`, INSPECT_CACHE_TTL_MS, async () => {
        const data = await inspectUrl(site.id, sub.url);
        const r = data.inspectionResult?.indexStatusResult ?? {};
        return {
          verdict: r.verdict ?? null,
          coverageState: r.coverageState ?? null,
          indexingState: r.indexingState ?? null,
          robotsTxtState: r.robotsTxtState ?? null,
          pageFetchState: r.pageFetchState ?? null,
          lastCrawlTime: r.lastCrawlTime ?? null,
          googleCanonical: r.googleCanonical ?? null,
          userCanonical: r.userCanonical ?? null,
          inspectedAt: new Date().toISOString(),
        };
      });
    };

    // ----- AI citations: latest uploads only (grounding exports have no URLs,
    // so grounding queries are matched by tracked-keyword text) -----
    const loadAiCitations = async () => {
      const uploads = await db
        .select()
        .from(aiCitationUploadsTable)
        .where(eq(aiCitationUploadsTable.siteId, site.id))
        .orderBy(desc(aiCitationUploadsTable.uploadedAt));
      const pagesUpload = uploads.find((u) => u.kind === "pages") ?? null;
      const groundingUpload = uploads.find((u) => u.kind === "grounding_queries") ?? null;

      let citations = 0;
      if (pagesUpload && path) {
        const agg = await db
          .select({
            c: sql<number>`coalesce(sum(${aiCitationRowsTable.citations}), 0)::int`,
          })
          .from(aiCitationRowsTable)
          .where(
            and(
              eq(aiCitationRowsTable.uploadId, pagesUpload.id),
              eq(aiCitationRowsTable.path, path),
            ),
          );
        citations = agg[0]?.c ?? 0;
      }

      let groundingQueries: { query: string; citations: number }[] = [];
      if (groundingUpload && keyword) {
        const kw = normKeyword(keyword);
        const gRows = await db
          .select({
            query: aiCitationRowsTable.query,
            citations: aiCitationRowsTable.citations,
          })
          .from(aiCitationRowsTable)
          .where(
            and(
              eq(aiCitationRowsTable.uploadId, groundingUpload.id),
              sql`lower(${aiCitationRowsTable.query}) like ${"%" + kw + "%"}`,
            ),
          );
        groundingQueries = gRows
          .filter((r) => r.query != null)
          .map((r) => ({ query: r.query as string, citations: r.citations }))
          .sort((a, b) => b.citations - a.citations)
          .slice(0, 10);
      }

      return {
        hasUpload: pagesUpload != null,
        citations,
        uploadedAt: pagesUpload?.uploadedAt?.toISOString() ?? null,
        uploadLabel: pagesUpload?.label ?? null,
        groundingQueries,
      };
    };

    // ----- SERP competitors: reuse stored SERP rows from the latest complete
    // cluster run (paid at cluster time — free to read here) -----
    const loadSerpCompetitors = async () => {
      if (!keyword) return null;
      const kw = normKeyword(keyword);
      const runs = await db
        .select()
        .from(clusterRunsTable)
        .where(and(eq(clusterRunsTable.siteId, site.id), eq(clusterRunsTable.status, "complete")))
        .orderBy(desc(clusterRunsTable.finishedAt))
        .limit(1);
      const run = runs[0];
      if (!run) return null;
      const clusters = await db
        .select({ keywords: clusterRunClustersTable.keywords })
        .from(clusterRunClustersTable)
        .where(eq(clusterRunClustersTable.runId, run.id));
      const ownHost = normalizeHost(site.host);
      for (const cluster of clusters) {
        const entry = cluster.keywords.find((k) => normKeyword(k.query) === kw);
        if (entry && entry.serpUrls.length > 0) {
          return {
            keyword: entry.query,
            runDate: (run.finishedAt ?? run.createdAt).toISOString(),
            competitors: entry.serpUrls.map((s) => {
              let isOwn = false;
              try {
                isOwn = normalizeHost(new URL(s.url).hostname) === ownHost;
              } catch {
                /* unparseable SERP URL — treat as competitor */
              }
              return { url: s.url, position: s.position, isOwn };
            }),
          };
        }
      }
      return null;
    };

    // ----- Cannibalization: other own URLs competing for the tracked keyword -----
    const loadCannibalizedWith = async (): Promise<string[]> => {
      if (!keyword) return [];
      const { byQuery } = await withCache(
        `s${site.id}|tracked-cannibal:v1`,
        GSC_CACHE_TTL_MS,
        () => loadCannibalizedQueries(site.id),
      );
      const kw = normKeyword(keyword);
      for (const [query, urls] of byQuery) {
        if (normKeyword(query) !== kw) continue;
        return urls
          .filter((u) => canonicalPath(u, site.host) !== path)
          .map((u) => canonicalPath(u, site.host) ?? u);
      }
      return [];
    };

    const log = req.log;
    const [gsc, bing, ga4, indexing, aiCitations, serp, cannibalizedWith] = await Promise.all([
      runSection("gsc", log, loadGsc),
      runSection("bing", log, loadBing),
      runSection("ga4", log, loadGa4),
      runSection("indexing", log, loadIndexing),
      runSection("ai_citations", log, loadAiCitations),
      loadSerpCompetitors().catch((err) => {
        log.error({ err, section: "serp" }, "tracked report section failed");
        return null;
      }),
      loadCannibalizedWith().catch((err) => {
        log.error({ err, section: "cannibalization" }, "tracked report section failed");
        return [] as string[];
      }),
    ]);

    const actionPlan = buildActionPlan({
      url: sub.url,
      keyword,
      days,
      gsc: gsc.data
        ? {
            overallTotals: gsc.data.overallTotals,
            keywordTotals: gsc.data.keywordTotals,
            topQueries: gsc.data.topQueries,
          }
        : null,
      indexing: indexing.data,
      bing:
        bing.status === "ok" && bing.data
          ? {
              connected: true,
              clicks: bing.data.totals.clicks,
              impressions: bing.data.totals.impressions,
            }
          : null,
      ga4: ga4.data
        ? {
            sessions: ga4.data.totals.sessions,
            engagementRate: ga4.data.totals.engagementRate,
            keyEvents: ga4.data.totals.keyEvents,
            aiSessions: ga4.data.totals.aiSessions,
          }
        : null,
      aiCitations: aiCitations.data
        ? { hasUpload: aiCitations.data.hasUpload, citations: aiCitations.data.citations }
        : null,
      cannibalizedWith,
    });

    res.json({
      id: sub.id,
      url: sub.url,
      keyword,
      startDate,
      endDate,
      gsc,
      bing,
      ga4,
      indexing,
      aiCitations,
      serpCompetitors: serp,
      actionPlan,
    });
  },
);

export default router;
