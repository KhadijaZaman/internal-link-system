import { google, type searchconsole_v1 } from "googleapis";
import { getGscCreds } from "../lib/siteIntegrations";

interface GscConn {
  sc: searchconsole_v1.Searchconsole;
  siteUrl: string;
}

/** Per-site GSC client: per-site stored refresh token + property, with env
 *  fallback for the legacy site (id 1) only. */
async function connect(siteId: number): Promise<GscConn> {
  const creds = await getGscCreds(siteId);
  const oauth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
  oauth.setCredentials({ refresh_token: creds.refreshToken });
  return {
    sc: google.searchconsole({ version: "v1", auth: oauth }),
    siteUrl: creds.property,
  };
}

/** The GSC property string for a site (for display / diagnostics). */
export async function gscSiteUrl(siteId: number): Promise<string> {
  return (await getGscCreds(siteId)).property;
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
  siteId: number;
  startDate: string;
  endDate: string;
  dimensions?: string[];
  pageFilter?: string;
  rowLimit?: number;
}): Promise<GscRow[]> {
  const { sc, siteUrl } = await connect(opts.siteId);
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
      siteUrl,
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

/**
 * Hard safety cap used by the paginated mode of queryGscDimension.
 * This protects a single paginated request. Callers spanning multiple date
 * chunks must also enforce a whole-operation cap.
 */
export const QUERY_DIMENSION_PAGINATED_CAP = 2_000_000;

export async function queryGscDimension(opts: {
  siteId: number;
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
  /**
   * "all" includes fresh (not-yet-finalized) rows for the most recent ~2
   * days — those numbers can still revise upward. Default (omitted) = GSC's
   * "final": stable data only, which typically ends 2-3 days ago.
   */
  dataState?: "all" | "final";
  /**
   * When true, paginate to exhaustion rather than returning the first page
   * only. Each GSC API page is `rowLimit` rows (capped at 25 000 per call).
   * If the accumulated row count would exceed `paginatedCap` (default
   * QUERY_DIMENSION_PAGINATED_CAP = 2 000 000) the function throws rather
   * than silently returning a truncated result.
   *
   * Existing callers that do NOT set this flag retain the old single-page
   * behaviour unchanged.
   */
  paginated?: boolean;
  /**
   * Hard row cap for paginated mode. Defaults to QUERY_DIMENSION_PAGINATED_CAP.
   * Throws when the accumulated result would exceed this value.
   */
  paginatedCap?: number;
}): Promise<GscDimensionRow[]> {
  const { sc, siteUrl } = await connect(opts.siteId);
  const rowLimit = Math.min(opts.rowLimit ?? 5000, 25_000);
  const body: searchconsole_v1.Schema$SearchAnalyticsQueryRequest = {
    startDate: opts.startDate,
    endDate: opts.endDate,
    dimensions: [opts.dimension],
    rowLimit,
  };
  if (opts.dataState) body.dataState = opts.dataState;
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

  if (!opts.paginated) {
    // Legacy single-page path: unchanged behaviour for all existing callers.
    const res = await sc.searchanalytics.query({ siteUrl, requestBody: body });
    return (res.data.rows ?? []).map((r) => ({
      key: r.keys?.[0] ?? "",
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }));
  }

  // Paginated-to-exhaustion mode with fail-closed cap.
  const cap = opts.paginatedCap ?? QUERY_DIMENSION_PAGINATED_CAP;
  const all: GscDimensionRow[] = [];
  let startRow = 0;
  for (;;) {
    const remaining = cap - all.length;
    if (remaining <= 0) {
      throw new Error(
        `GSC dimension (${opts.dimension}) fetch exceeded safety cap of ${cap} rows ` +
          `(${opts.startDate}–${opts.endDate}). Narrow the date range or apply stricter filters.`,
      );
    }
    const requestRowLimit = Math.min(rowLimit, remaining);
    const res = await sc.searchanalytics.query({
      siteUrl,
      requestBody: { ...body, rowLimit: requestRowLimit, startRow },
    });
    const rows = res.data.rows ?? [];
    if (rows.length > requestRowLimit) {
      throw new Error("GSC returned more dimension rows than requested.");
    }
    for (const r of rows) {
      all.push({
        key: r.keys?.[0] ?? "",
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      });
    }
    if (rows.length < requestRowLimit) break;
    startRow += rows.length;
    if (all.length >= cap) {
      throw new Error(
        `GSC dimension (${opts.dimension}) fetch exceeded safety cap of ${cap} rows ` +
          `(${opts.startDate}–${opts.endDate}). Narrow the date range or apply stricter filters.`,
      );
    }
  }
  return all;
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

/**
 * Case-insensitive "contains phrase" match: the keyword appearing anywhere in
 * the query as a whole-word phrase (e.g. "peec ai alternatives" also matches
 * "best peec ai alternatives"). RE2 has no \b, so anchor on start/whitespace.
 */
export function keywordContainsRegex(keyword: string): string {
  const escaped = keyword
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return `(?i)(^|\\s)${escaped}(\\s|$)`;
}

export interface GscQueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Fetch all GSC query×page rows for a given date range, paginating to
 * exhaustion. Country-filtered. Throws at a hard safety cap rather than
 * silently truncating.
 *
 * This is used to gather page-level evidence for GSC-page clustering.
 * Metrics (clicks/impressions/position) on each row are for that specific
 * (query, page) pair for the given window.
 *
 * Safety cap: if the response would exceed MAX_QUERY_PAGE_ROWS rows we throw
 * rather than silently returning a truncated picture. The caller must handle
 * this error and decide whether to abort or re-parameterize.
 */
const DEFAULT_MAX_QUERY_PAGE_ROWS = 500_000;

export async function queryGscQueryPage(opts: {
  siteId: number;
  startDate: string;
  endDate: string;
  /** ISO 3166-1 alpha-3 country code (lowercase), e.g. "usa", "gbr". */
  countryFilter?: string;
  /**
   * RE2 regex applied to the query dimension (combined with countryFilter
   * using AND). Used to scope page-evidence fetches to a selected-query batch,
   * avoiding pulling all query×page data when only a subset is needed.
   */
  queryRegex?: string;
  /**
   * Rows per GSC API page (max 25 000). Defaults to 25 000.
   * Smaller values are useful for testing.
   */
  pageSize?: number;
  /**
   * Hard cap for this paginated request. Callers can lower this to the
   * remaining allowance in a whole-run budget.
   */
  maxRows?: number;
}): Promise<GscQueryPageRow[]> {
  const { sc, siteUrl } = await connect(opts.siteId);
  const maxRows = opts.maxRows ?? DEFAULT_MAX_QUERY_PAGE_ROWS;
  const pageSize = Math.min(opts.pageSize ?? 25_000, 25_000, maxRows);
  if (pageSize < 1 || maxRows < 1) {
    throw new Error("GSC query+page fetch requires a positive row allowance.");
  }

  const filters: NonNullable<
    NonNullable<
      searchconsole_v1.Schema$SearchAnalyticsQueryRequest["dimensionFilterGroups"]
    >[number]["filters"]
  > = [];
  if (opts.countryFilter) {
    filters.push({
      dimension: "country",
      operator: "equals",
      expression: opts.countryFilter,
    });
  }
  if (opts.queryRegex) {
    filters.push({
      dimension: "query",
      operator: "includingRegex",
      expression: opts.queryRegex,
    });
  }

  const all: GscQueryPageRow[] = [];
  let startRow = 0;

  for (;;) {
    const remaining = maxRows - all.length;
    if (remaining <= 0) {
      throw new Error(
        `GSC query+page fetch exceeded safety cap of ${maxRows} rows ` +
          `(${opts.startDate}–${opts.endDate}). Narrow the date range or apply stricter filters.`,
      );
    }
    const requestPageSize = Math.min(pageSize, remaining);
    const body: searchconsole_v1.Schema$SearchAnalyticsQueryRequest = {
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions: ["query", "page"],
      rowLimit: requestPageSize,
      startRow,
    };
    if (filters.length > 0) {
      body.dimensionFilterGroups = [{ filters }];
    }

    const res = await sc.searchanalytics.query({ siteUrl, requestBody: body });
    const rows = res.data.rows ?? [];
    if (rows.length > requestPageSize) {
      throw new Error("GSC returned more query+page rows than requested.");
    }

    for (const r of rows) {
      const keys = r.keys ?? [];
      all.push({
        query: keys[0] ?? "",
        page: keys[1] ?? "",
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      });
    }

    if (rows.length < requestPageSize) break;
    startRow += rows.length;

    if (all.length >= maxRows) {
      throw new Error(
        `GSC query+page fetch exceeded safety cap of ${maxRows} rows ` +
          `(${opts.startDate}–${opts.endDate}). Narrow the date range or apply stricter filters.`,
      );
    }
  }

  return all;
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

export async function listSitemaps(siteId: number): Promise<searchconsole_v1.Schema$WmxSitemap[]> {
  const { sc, siteUrl } = await connect(siteId);
  const res = await sc.sitemaps.list({ siteUrl });
  return res.data.sitemap ?? [];
}

export async function inspectUrl(siteId: number, url: string): Promise<searchconsole_v1.Schema$InspectUrlIndexResponse> {
  const { sc, siteUrl } = await connect(siteId);
  const res = await sc.urlInspection.index.inspect({
    requestBody: {
      inspectionUrl: url,
      siteUrl,
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
