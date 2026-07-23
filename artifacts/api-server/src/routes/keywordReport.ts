import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import {
  queryGscDimension,
  aggregateTotals,
  withCache,
  GSC_CACHE_TTL_MS,
  pageVariantsRegex,
  keywordExactRegex,
  type GscDimensionRow,
} from "../integrations/gsc";

const router: IRouter = Router();

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
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

// Ad-hoc keyword performance for any URL + keyword. GSC API only — the URL is
// used purely as a Search Console page filter and is never fetched or crawled.
router.get("/keyword-report", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  const url = typeof req.query["url"] === "string" ? req.query["url"].trim() : "";
  const keyword =
    typeof req.query["keyword"] === "string" ? req.query["keyword"].trim() : "";
  if (!url || !isHttpUrl(url)) {
    res.status(400).json({ error: "url must be a valid http(s) URL" });
    return;
  }
  if (!keyword) {
    res.status(400).json({ error: "keyword is required" });
    return;
  }
  const daysRaw = Number(req.query["days"] ?? 28);
  const days = Math.min(
    180,
    Math.max(7, Number.isFinite(daysRaw) ? Math.round(daysRaw) : 28),
  );
  const countryRaw =
    typeof req.query["country"] === "string" ? req.query["country"].trim() : "";
  // "all" is rejected: it's the worldwide cache-key sentinel, not an ISO code.
  if (countryRaw && (!/^[A-Za-z]{3}$/.test(countryRaw) || countryRaw.toLowerCase() === "all")) {
    res.status(400).json({ error: "country must be a 3-letter ISO code" });
    return;
  }
  const country = countryRaw ? countryRaw.toLowerCase() : null;

  // GSC data lags ~2 days behind real time.
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const prevStart = new Date(start);
  prevStart.setUTCDate(prevStart.getUTCDate() - days);

  const endDate = isoDay(end);
  const startDate = isoDay(start);
  const prevStartDate = isoDay(prevStart);
  const pageRegex = pageVariantsRegex(url);

  // URL kept case-sensitive (GSC page URLs are); keyword lowercased (GSC stores queries lowercased).
  const cacheKey = `s${site.id}|keyword-report:${url}:${keyword.toLowerCase()}:${days}:${country ?? "all"}:${endDate}`;
  try {
    const payload = await withCache(cacheKey, GSC_CACHE_TTL_MS, async () => {
      const countryFilter = country ?? undefined;
      // One keyword call covers current + previous window, split locally.
      const [keywordDaily, pageDaily] = await Promise.all([
        queryGscDimension({
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
        }),
        queryGscDimension({
          siteId: site.id,
          startDate,
          endDate,
          dimension: "date",
          pageRegex,
          countryFilter,
        }),
      ]);

      const current = keywordDaily.filter((r) => r.key >= startDate);
      const previous = keywordDaily.filter((r) => r.key < startDate);

      return {
        url,
        keyword,
        startDate,
        endDate,
        series: current.map(toSeriesPoint),
        totals: current.length > 0 ? aggregateTotals(current) : null,
        prevTotals: previous.length > 0 ? aggregateTotals(previous) : null,
        pageTotals: pageDaily.length > 0 ? aggregateTotals(pageDaily) : null,
      };
    });
    res.json(payload);
  } catch (err) {
    req.log.error({ err, url, keyword }, "keyword report fetch failed");
    res.status(502).json({ error: "Search Console request failed" });
  }
});

export default router;
