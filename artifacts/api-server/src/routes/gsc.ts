import { Router, type IRouter } from "express";
import { db, linkGraphTable, linkStatsTable, inventoryTable, gscSnapshotsTable } from "@workspace/db";
import { desc, sql, gte } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { fetchTopReferringDomains } from "../integrations/dataforseo";
import {
  queryGscDimension,
  aggregateTotals,
  listSitemaps,
  inspectUrl,
  withCache,
  GSC_CACHE_TTL_MS,
  gscSiteUrl,
} from "../integrations/gsc";
import { fetchCrux } from "../integrations/crux";

const router: IRouter = Router();

const BRAND_TERMS = (process.env["GSC_BRAND_TERMS"] ?? "wellows")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isBranded(query: string): boolean {
  const q = query.toLowerCase();
  return BRAND_TERMS.some((t) => q.includes(t));
}

function previousRange(startDate: string, endDate: string): { startDate: string; endDate: string } {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const prevEnd = new Date(start.getTime() - 86_400_000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86_400_000);
  return {
    startDate: prevStart.toISOString().slice(0, 10),
    endDate: prevEnd.toISOString().slice(0, 10),
  };
}

function pct(curr: number, prev: number): number {
  if (prev === 0) return curr === 0 ? 0 : 100;
  return ((curr - prev) / prev) * 100;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_URL_LEN = 2048;

function validateRangeParams(
  req: { query: Record<string, unknown> },
): { startDate: string; endDate: string; url: string | undefined } | { error: string } {
  const startDate = String(req.query["startDate"] ?? "");
  const endDate = String(req.query["endDate"] ?? "");
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return { error: "startDate and endDate must be YYYY-MM-DD" };
  }
  if (startDate > endDate) {
    return { error: "startDate must be <= endDate" };
  }
  const rawUrl = req.query["url"];
  let url: string | undefined;
  if (typeof rawUrl === "string" && rawUrl.length > 0) {
    if (rawUrl.length > MAX_URL_LEN) return { error: `url exceeds ${MAX_URL_LEN} chars` };
    if (!/^https?:\/\//i.test(rawUrl)) return { error: "url must start with http(s)://" };
    url = rawUrl;
  }
  return { startDate, endDate, url };
}

function parseLimit(raw: unknown, def: number, max: number): number {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

router.get("/gsc/overview", requireAuth, async (req, res) => {
  const v = validateRangeParams(req);
  if ("error" in v) {
    res.status(400).json({ error: v.error });
    return;
  }
  const { startDate, endDate, url } = v;
  const compare = String(req.query["compare"] ?? "") === "true";
  try {
    const key = `overview|${startDate}|${endDate}|${url ?? ""}|${compare}`;
    const data = await withCache(key, GSC_CACHE_TTL_MS, async () => {
      const series = await queryGscDimension({
        startDate,
        endDate,
        dimension: "date",
        pageFilter: url,
        rowLimit: 5000,
      });
      const timeseries = series
        .map((r) => ({
          date: r.key,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const totals = aggregateTotals(timeseries);

      let previousTotals = null as ReturnType<typeof aggregateTotals> | null;
      let deltaPct = null as { clicks: number; impressions: number; ctr: number; position: number } | null;
      if (compare) {
        const prev = previousRange(startDate, endDate);
        const prevSeries = await queryGscDimension({
          startDate: prev.startDate,
          endDate: prev.endDate,
          dimension: "date",
          pageFilter: url,
          rowLimit: 5000,
        });
        previousTotals = aggregateTotals(prevSeries);
        deltaPct = {
          clicks: pct(totals.clicks, previousTotals.clicks),
          impressions: pct(totals.impressions, previousTotals.impressions),
          ctr: pct(totals.ctr, previousTotals.ctr),
          position: pct(totals.position, previousTotals.position),
        };
      }
      return { startDate, endDate, totals, previousTotals, deltaPct, timeseries };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "GSC overview failed");
    res.status(502).json({ error: "GSC fetch failed" });
  }
});

router.get("/gsc/queries", requireAuth, async (req, res) => {
  const v = validateRangeParams(req);
  if ("error" in v) {
    res.status(400).json({ error: v.error });
    return;
  }
  const { startDate, endDate, url } = v;
  const limit = parseLimit(req.query["limit"], 500, 5000);
  try {
    const key = `queries|${startDate}|${endDate}|${url ?? ""}|${limit}`;
    const data = await withCache(key, GSC_CACHE_TTL_MS, async () => {
      const rows = await queryGscDimension({
        startDate,
        endDate,
        dimension: "query",
        pageFilter: url,
        rowLimit: limit,
      });
      const enriched = rows.map((r) => ({
        query: r.key,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
        isBranded: isBranded(r.key),
      }));
      enriched.sort((a, b) => b.impressions - a.impressions);
      const brandedRows = enriched.filter((r) => r.isBranded);
      const unbrandedRows = enriched.filter((r) => !r.isBranded);
      return {
        rows: enriched,
        brandedTotals: aggregateTotals(brandedRows),
        unbrandedTotals: aggregateTotals(unbrandedRows),
      };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "GSC queries failed");
    res.status(502).json({ error: "GSC fetch failed" });
  }
});

router.get("/gsc/pages", requireAuth, async (req, res) => {
  const v = validateRangeParams(req);
  if ("error" in v) {
    res.status(400).json({ error: v.error });
    return;
  }
  const { startDate, endDate, url } = v;
  const limit = parseLimit(req.query["limit"], 500, 5000);
  try {
    const key = `pages|${startDate}|${endDate}|${url ?? ""}|${limit}`;
    const data = await withCache(key, GSC_CACHE_TTL_MS, async () => {
      const rows = await queryGscDimension({
        startDate,
        endDate,
        dimension: "page",
        pageFilter: url,
        rowLimit: limit,
      });
      const mapped = rows
        .map((r) => ({
          url: r.key,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
        }))
        .sort((a, b) => b.impressions - a.impressions);
      return { rows: mapped };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "GSC pages failed");
    res.status(502).json({ error: "GSC fetch failed" });
  }
});

router.get("/gsc/geo", requireAuth, async (req, res) => {
  const v = validateRangeParams(req);
  if ("error" in v) {
    res.status(400).json({ error: v.error });
    return;
  }
  const { startDate, endDate, url } = v;
  try {
    const key = `geo|${startDate}|${endDate}|${url ?? ""}`;
    const data = await withCache(key, GSC_CACHE_TTL_MS, async () => {
      const [countries, devices] = await Promise.all([
        queryGscDimension({ startDate, endDate, dimension: "country", pageFilter: url, rowLimit: 500 }),
        queryGscDimension({ startDate, endDate, dimension: "device", pageFilter: url, rowLimit: 50 }),
      ]);
      const sortBy = (arr: typeof countries) => arr.sort((a, b) => b.impressions - a.impressions);
      return { countries: sortBy(countries), devices: sortBy(devices) };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "GSC geo failed");
    res.status(502).json({ error: "GSC fetch failed" });
  }
});

router.get("/gsc/indexing", requireAuth, async (req, res) => {
  try {
    const data = await withCache("indexing|sitemaps+candidates", 10 * 60 * 1000, async () => {
      const windowStartDate = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
      const windowEndDate = new Date().toISOString().slice(0, 10);

      const [sitemaps, inventoryRows, seenRows] = await Promise.all([
        listSitemaps().catch(() => []),
        db.select({ url: inventoryTable.url }).from(inventoryTable),
        db
          .select({
            url: gscSnapshotsTable.url,
            lastSeen: sql<string>`max(${gscSnapshotsTable.snapshotDate})`,
          })
          .from(gscSnapshotsTable)
          .where(gte(gscSnapshotsTable.snapshotDate, windowStartDate))
          .groupBy(gscSnapshotsTable.url),
      ]);

      const seenMap = new Map<string, string>(seenRows.map((r) => [r.url, r.lastSeen]));
      const candidates: { url: string; reason: string; lastSeenInGsc: string | null }[] = [];
      for (const inv of inventoryRows) {
        if (!seenMap.has(inv.url)) {
          candidates.push({ url: inv.url, reason: "no-impressions-90d", lastSeenInGsc: null });
        }
      }
      // Cap to keep payload small; ordered by URL for stable display.
      candidates.sort((a, b) => a.url.localeCompare(b.url));
      const trimmed = candidates.slice(0, 500);

      // Auto-inspect a small sample (top 5) so users see real GSC reasons
      // on first load without clicking the batch button. Each call is
      // cached for 24h to protect the inspection-quota.
      const autoSample = trimmed.slice(0, 5);
      const autoResults = await Promise.all(
        autoSample.map((c) =>
          withCache(`inspect|${c.url}`, 24 * 60 * 60 * 1000, async () => {
            try {
              const result = await inspectUrl(c.url);
              const idx = result.inspectionResult?.indexStatusResult;
              return {
                url: c.url,
                verdict: idx?.verdict ?? null,
                coverageState: idx?.coverageState ?? null,
                indexingState: idx?.indexingState ?? null,
                robotsTxtState: idx?.robotsTxtState ?? null,
              };
            } catch {
              return { url: c.url, verdict: null, coverageState: null, indexingState: null, robotsTxtState: null };
            }
          }),
        ),
      );
      const buckets = new Map<string, number>();
      for (const r of autoResults) {
        const key = r.coverageState ?? r.indexingState ?? r.verdict ?? "UNKNOWN";
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      const autoReasons = Array.from(buckets.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);

      return {
        sitemaps: sitemaps.map((s) => ({
          path: s.path ?? "",
          lastSubmitted: s.lastSubmitted ?? null,
          lastDownloaded: s.lastDownloaded ?? null,
          warnings: s.warnings ? Number(s.warnings) : null,
          errors: s.errors ? Number(s.errors) : null,
          isPending: s.isPending ?? null,
          contents: (s.contents ?? []).map((c) => ({
            type: c.type ?? "web",
            submitted: c.submitted ? Number(c.submitted) : 0,
            indexed: c.indexed ? Number(c.indexed) : 0,
          })),
        })),
        lastChecked: new Date().toISOString(),
        notice:
          sitemaps.length === 0
            ? "No sitemaps submitted in GSC for this property."
            : inventoryRows.length === 0
              ? "Crawl inventory is empty — run the crawler to identify not-indexed candidates."
              : null,
        notIndexedCandidates: trimmed,
        candidatesWindowStart: windowStartDate,
        candidatesWindowEnd: windowEndDate,
        autoInspectedSample: autoResults,
        autoInspectedReasons: autoReasons,
      };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "GSC indexing failed");
    res.status(502).json({ error: "GSC fetch failed" });
  }
});

router.get("/gsc/inspect", requireAuth, async (req, res) => {
  const rawUrl = req.query["url"];
  const url = typeof rawUrl === "string" ? rawUrl : "";
  if (!url || url.length > MAX_URL_LEN || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "url must be a valid http(s):// URL" });
    return;
  }
  try {
    const key = `inspect|${url}`;
    const data = await withCache(key, 15 * 60 * 1000, async () => {
      const result = await inspectUrl(url);
      const idx = result.inspectionResult?.indexStatusResult;
      const mob = result.inspectionResult?.mobileUsabilityResult;
      return {
        url,
        fetchedAt: new Date().toISOString(),
        verdict: idx?.verdict ?? null,
        coverageState: idx?.coverageState ?? null,
        robotsTxtState: idx?.robotsTxtState ?? null,
        indexingState: idx?.indexingState ?? null,
        lastCrawlTime: idx?.lastCrawlTime ?? null,
        googleCanonical: idx?.googleCanonical ?? null,
        userCanonical: idx?.userCanonical ?? null,
        pageFetchState: idx?.pageFetchState ?? null,
        mobileUsability: mob?.verdict ?? null,
        raw: JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
      };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "GSC inspect failed");
    res.status(502).json({ error: "GSC inspect failed" });
  }
});

router.get("/gsc/cwv", requireAuth, async (req, res) => {
  const url = req.query["url"] ? String(req.query["url"]) : undefined;
  try {
    const property = gscSiteUrl();
    let origin: string | undefined;
    if (property.startsWith("sc-domain:")) {
      origin = `https://${property.slice("sc-domain:".length)}`;
    } else {
      try {
        origin = new URL(property).origin;
      } catch {
        origin = undefined;
      }
    }
    const scope = url ?? origin ?? property;
    const key = `cwv|${url ?? origin ?? "?"}`;
    const data = await withCache(key, 60 * 60 * 1000, async () => {
      const target = url ? { url } : { origin };
      const cx = await fetchCrux(target);
      return {
        scope,
        fetchedAt: new Date().toISOString(),
        formFactors: cx.formFactors,
        notice: cx.notice,
      };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "GSC CWV failed");
    res.status(502).json({ error: "CWV fetch failed" });
  }
});

router.get("/gsc/links", requireAuth, async (req, res) => {
  // GSC API does not expose the Links report, so external linking domains
  // come from DataForSEO's Backlinks API and internal-link signals come
  // from our own crawl.
  try {
    const property = gscSiteUrl();
    let backlinkTarget = property;
    if (property.startsWith("sc-domain:")) backlinkTarget = property.slice("sc-domain:".length);
    else {
      try { backlinkTarget = new URL(property).hostname; } catch { /* keep raw */ }
    }

    const [topTargets, internalDomains, externalDomains] = await Promise.all([
      db
        .select({ url: linkStatsTable.url, inboundCount: linkStatsTable.inboundCount })
        .from(linkStatsTable)
        .orderBy(desc(linkStatsTable.inboundCount))
        .limit(20),
      db
        .select({
          host: sql<string>`split_part(split_part(${linkGraphTable.targetUrl}, '://', 2), '/', 1)`,
          c: sql<number>`count(*)::int`,
        })
        .from(linkGraphTable)
        .groupBy(sql`1`)
        .orderBy(desc(sql<number>`count(*)`))
        .limit(20),
      withCache(`backlinks|${backlinkTarget}`, 6 * 60 * 60 * 1000, () =>
        fetchTopReferringDomains(backlinkTarget, 50).catch(() => []),
      ),
    ]);

    const externalNotice = !process.env["DATAFORSEO_LOGIN"]
      ? "Set DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD to populate external linking domains."
      : externalDomains.length === 0
        ? "DataForSEO returned no referring domains for this property."
        : null;

    res.json({
      topInternalTargets: topTargets.map((t) => ({ key: t.url, count: t.inboundCount })),
      topLinkingDomains: internalDomains.map((d) => ({ key: d.host, count: d.c })),
      topExternalLinkingDomains: externalDomains.map((d) => ({
        domain: d.domain,
        backlinks: d.backlinks,
        rank: d.rank,
        firstSeen: d.firstSeen,
        lastSeen: d.lastSeen,
      })),
      externalNotice,
      notice:
        "External linking domains come from DataForSEO Backlinks. Internal-link signals come from our own site crawl.",
    });
  } catch (err) {
    req.log.error({ err }, "GSC links failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/gsc/indexing/inspect-batch", requireAuth, async (req, res) => {
  const body = (req.body ?? {}) as { urls?: unknown };
  if (!Array.isArray(body.urls)) {
    res.status(400).json({ error: "urls must be an array of http(s) URLs (max 10)" });
    return;
  }
  const urls = body.urls
    .filter((u): u is string => typeof u === "string" && u.length <= MAX_URL_LEN && /^https?:\/\//i.test(u))
    .slice(0, 10);
  if (urls.length === 0) {
    res.status(400).json({ error: "urls must contain at least one valid http(s) URL" });
    return;
  }
  try {
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const cached = await withCache(`inspect|${url}`, 24 * 60 * 60 * 1000, async () => {
            const result = await inspectUrl(url);
            const idx = result.inspectionResult?.indexStatusResult;
            return {
              url,
              verdict: idx?.verdict ?? null,
              coverageState: idx?.coverageState ?? null,
              indexingState: idx?.indexingState ?? null,
              robotsTxtState: idx?.robotsTxtState ?? null,
            };
          });
          return cached;
        } catch (err) {
          return { url, verdict: null, coverageState: null, indexingState: null, robotsTxtState: null, error: (err as Error).message };
        }
      }),
    );

    // Aggregate by coverageState (this is GSC's true "reason" field).
    const buckets = new Map<string, number>();
    for (const r of results) {
      const key = r.coverageState ?? r.indexingState ?? r.verdict ?? "UNKNOWN";
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const reasons = Array.from(buckets.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    res.json({ inspected: results.length, results, reasons });
  } catch (err) {
    req.log.error({ err }, "GSC batch inspect failed");
    res.status(502).json({ error: "GSC batch inspect failed" });
  }
});

router.get("/gsc/url-drilldown", requireAuth, async (req, res) => {
  const v = validateRangeParams(req);
  if ("error" in v) {
    res.status(400).json({ error: v.error });
    return;
  }
  const { startDate, endDate, url } = v;
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  try {
    const key = `drilldown|${url}|${startDate}|${endDate}`;
    const data = await withCache(key, GSC_CACHE_TTL_MS, async () => {
      const [queries, series] = await Promise.all([
        queryGscDimension({ startDate, endDate, dimension: "query", pageFilter: url, rowLimit: 200 }),
        queryGscDimension({ startDate, endDate, dimension: "date", pageFilter: url, rowLimit: 5000 }),
      ]);
      return {
        url,
        queries: queries
          .map((r) => ({
            query: r.key,
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: r.ctr,
            position: r.position,
            isBranded: isBranded(r.key),
          }))
          .sort((a, b) => b.impressions - a.impressions),
        timeseries: series
          .map((r) => ({
            date: r.key,
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: r.ctr,
            position: r.position,
          }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      };
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "GSC drilldown failed");
    res.status(502).json({ error: "GSC fetch failed" });
  }
});

export default router;
