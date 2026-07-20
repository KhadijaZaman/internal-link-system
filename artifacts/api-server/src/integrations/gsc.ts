import { google, type searchconsole_v1 } from "googleapis";

function client(): searchconsole_v1.Searchconsole {
  const clientId = process.env["GSC_CLIENT_ID"];
  const clientSecret = process.env["GSC_CLIENT_SECRET"];
  const refreshToken = process.env["GSC_REFRESH_TOKEN"];
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN must be set");
  }
  const oauth = new google.auth.OAuth2(clientId, clientSecret);
  oauth.setCredentials({ refresh_token: refreshToken });
  return google.searchconsole({ version: "v1", auth: oauth });
}

export function gscSiteUrl(): string {
  const s = process.env["GSC_PROPERTY"];
  if (!s) throw new Error("GSC_PROPERTY must be set");
  return s;
}

export interface GscRow {
  url: string;
  query: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
}

export async function queryGsc(opts: {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  pageFilter?: string;
  rowLimit?: number;
}): Promise<GscRow[]> {
  const sc = client();
  const rowLimit = opts.rowLimit ?? 25000;
  const dimensions = opts.dimensions ?? ["page", "query"];
  const all: GscRow[] = [];
  let startRow = 0;
  for (;;) {
    const body: searchconsole_v1.Schema$SearchAnalyticsQueryRequest = {
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions,
      rowLimit,
      startRow,
    };
    if (opts.pageFilter) {
      body.dimensionFilterGroups = [
        {
          filters: [
            { dimension: "page", operator: "equals", expression: opts.pageFilter },
          ],
        },
      ];
    }
    const res = await sc.searchanalytics.query({
      siteUrl: gscSiteUrl(),
      requestBody: body,
    });
    const rows = res.data.rows ?? [];
    for (const r of rows) {
      const keys = r.keys ?? [];
      const url = dimensions.indexOf("page") >= 0 ? keys[dimensions.indexOf("page")] ?? "" : "";
      const query =
        dimensions.indexOf("query") >= 0 ? keys[dimensions.indexOf("query")] ?? "" : "";
      all.push({
        url,
        query,
        position: r.position ?? 0,
        impressions: r.impressions ?? 0,
        clicks: r.clicks ?? 0,
        ctr: r.ctr ?? 0,
      });
    }
    if (rows.length < rowLimit) break;
    startRow += rowLimit;
    if (startRow > 200000) break;
  }
  return all;
}

export interface GscDimensionRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function queryGscDimension(opts: {
  startDate: string;
  endDate: string;
  dimension: "query" | "page" | "country" | "device" | "date";
  pageFilter?: string;
  /** RE2 regex page filter (use to include #fragment / ?query URL variants). */
  pageRegex?: string;
  queryFilter?: {
    expression: string;
    operator?: "equals" | "contains" | "includingRegex";
  };
  /** ISO 3166-1 alpha-3 country code (lowercase), e.g. "usa", "gbr", "ind". */
  countryFilter?: string;
  rowLimit?: number;
}): Promise<GscDimensionRow[]> {
  const sc = client();
  const rowLimit = opts.rowLimit ?? 5000;
  const body: searchconsole_v1.Schema$SearchAnalyticsQueryRequest = {
    startDate: opts.startDate,
    endDate: opts.endDate,
    dimensions: [opts.dimension],
    rowLimit,
  };
  const filters: NonNullable<NonNullable<searchconsole_v1.Schema$SearchAnalyticsQueryRequest["dimensionFilterGroups"]>[number]["filters"]> = [];
  if (opts.pageFilter) {
    filters.push({ dimension: "page", operator: "equals", expression: opts.pageFilter });
  }
  if (opts.pageRegex) {
    filters.push({ dimension: "page", operator: "includingRegex", expression: opts.pageRegex });
  }
  if (opts.queryFilter) {
    filters.push({
      dimension: "query",
      operator: opts.queryFilter.operator ?? "equals",
      expression: opts.queryFilter.expression,
    });
  }
  if (opts.countryFilter) {
    filters.push({
      dimension: "country",
      operator: "equals",
      expression: opts.countryFilter,
    });
  }
  if (filters.length > 0) {
    body.dimensionFilterGroups = [{ filters }];
  }
  const res = await sc.searchanalytics.query({
    siteUrl: gscSiteUrl(),
    requestBody: body,
  });
  return (res.data.rows ?? []).map((r) => ({
    key: r.keys?.[0] ?? "",
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

/**
 * GSC records /page/#fragment (and ?query) variants as separate page URLs, so
 * an "equals" filter undercounts. Build an RE2 regex that matches the exact
 * URL plus optional trailing slash and any #fragment / ?query suffix.
 */
export function pageVariantsRegex(url: string): string {
  const base = url.replace(/\/+$/, "");
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped}/?([#?].*)?$`;
}

/**
 * GSC's "equals" query filter is case-sensitive, but GSC stores queries
 * lowercased — a keyword saved as "Ai visibility ..." would never match.
 * Build a case-insensitive exact-match RE2 regex (whitespace-run tolerant)
 * so the keyword matches regardless of how the operator typed it.
 */
export function keywordExactRegex(keyword: string): string {
  const escaped = keyword
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return `(?i)^${escaped}$`;
}

export function aggregateTotals(rows: { clicks: number; impressions: number; position: number }[]): GscTotals {
  let clicks = 0;
  let impressions = 0;
  let posSum = 0;
  let posWeight = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    posSum += r.position * Math.max(r.impressions, 1);
    posWeight += Math.max(r.impressions, 1);
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: posWeight > 0 ? posSum / posWeight : 0,
  };
}

export async function listSitemaps(): Promise<searchconsole_v1.Schema$WmxSitemap[]> {
  const sc = client();
  const res = await sc.sitemaps.list({ siteUrl: gscSiteUrl() });
  return res.data.sitemap ?? [];
}

export async function inspectUrl(url: string): Promise<searchconsole_v1.Schema$InspectUrlIndexResponse> {
  const sc = client();
  const res = await sc.urlInspection.index.inspect({
    requestBody: {
      inspectionUrl: url,
      siteUrl: gscSiteUrl(),
    },
  });
  return res.data;
}

// ---------- Simple in-memory TTL cache ----------
interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}
const cache = new Map<string, CacheEntry<unknown>>();
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function withCache<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }
  const value = await fn();
  cache.set(key, { value, expiresAt: now + ttlMs });
  if (cache.size > 500) {
    const expiredKeys: string[] = [];
    for (const [k, v] of cache) if (v.expiresAt <= now) expiredKeys.push(k);
    for (const k of expiredKeys) cache.delete(k);
  }
  return value;
}

export const GSC_CACHE_TTL_MS = DEFAULT_TTL_MS;
