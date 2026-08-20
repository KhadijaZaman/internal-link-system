import {
  aiCitationRowsTable,
  aiCitationUploadsTable,
  appStateTable,
  bingPageStatsTable,
  db,
  linkGraphTable,
  pagesTable,
} from "@workspace/db";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { queryGsc } from "../integrations/gsc";
import { queryGa4Pages } from "../integrations/ga4";
import { sheetsRequest } from "../integrations/googleSheets";
import { canonicalPath, canonicalUrl, loadBlockRegexes, isBlockedPath } from "../lib/urlCanon";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";
import {
  buildRoadmapColumnPlan,
  FRESHNESS_TAB_TITLE,
  findRoadmapKeyColumn,
  inferCitationWindow,
  normalizeRoadmapPath,
  ROADMAP_TAB_TITLE,
  type RoadmapMetrics,
  type RoadmapSourceFreshness,
} from "./optimizationRoadmap";

const BASE_KEY = "optimization_roadmap_sheet";
const DAY_MS = 24 * 60 * 60 * 1000;

interface SheetProperties {
  sheetId?: number;
  title?: string;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

interface SpreadsheetMeta {
  spreadsheetUrl?: string;
  properties?: { title?: string };
  sheets?: Array<{ properties?: SheetProperties }>;
}

interface ValueRange {
  values?: Array<Array<string | number | boolean>>;
}

interface LoadedRoadmapData {
  metricsByPath: Map<string, RoadmapMetrics>;
  freshness: RoadmapSourceFreshness[];
  pageOrder: string[];
}

export interface OptimizationRoadmapRefreshResult {
  skipped: boolean;
  url: string | null;
  tabTitle: string | null;
  rowCount: number;
  addedRows: number;
  addedColumns: string[];
  refreshedAt: string | null;
  freshness: RoadmapSourceFreshness[];
}

function stateKey(siteId: number, suffix: "id" | "tab" | "synced_at"): string {
  return `${BASE_KEY}:${siteId}:${suffix}`;
}

async function readState(siteId: number, suffix: "id" | "tab" | "synced_at"): Promise<string | null> {
  const [row] = await db
    .select({ value: appStateTable.value })
    .from(appStateTable)
    .where(eq(appStateTable.key, stateKey(siteId, suffix)))
    .limit(1);
  return row?.value ?? null;
}

export async function claimOptimizationRoadmapBinding(
  siteId: number,
  spreadsheetId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize all binds for this site and then all claims for this workbook.
    // Transaction-scoped PostgreSQL advisory locks work across server
    // processes, unlike the in-memory refresh coalescer below.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${BASE_KEY}:site:${siteId}`}))`,
    );
    const ownKey = stateKey(siteId, "id");
    const [ownBinding] = await tx
      .select({ value: appStateTable.value })
      .from(appStateTable)
      .where(eq(appStateTable.key, ownKey))
      .limit(1);
    if (ownBinding?.value && ownBinding.value !== spreadsheetId) {
      throw new Error(
        "This site is already bound to a different optimization roadmap workbook",
      );
    }

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${BASE_KEY}:sheet:${spreadsheetId}`}))`,
    );
    const rows = await tx
      .select({ key: appStateTable.key })
      .from(appStateTable)
      .where(eq(appStateTable.value, spreadsheetId));
    const conflict = rows.find(
      (row) =>
        row.key.startsWith(`${BASE_KEY}:`) &&
        row.key.endsWith(":id") &&
        row.key !== ownKey,
    );
    if (conflict) {
      throw new Error("This optimization roadmap workbook is already bound to another site");
    }

    await tx
      .insert(appStateTable)
      .values({ key: ownKey, value: spreadsheetId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appStateTable.key,
        set: { value: spreadsheetId, updatedAt: new Date() },
      });
  });
}

async function writeState(
  siteId: number,
  values: Partial<Record<"id" | "tab" | "synced_at", string>>,
): Promise<void> {
  await Promise.all(
    Object.entries(values).map(([suffix, value]) =>
      db
        .insert(appStateTable)
        .values({
          key: stateKey(siteId, suffix as "id" | "tab" | "synced_at"),
          value,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: appStateTable.key,
          set: { value, updatedAt: new Date() },
        }),
    ),
  );
}

export async function getOptimizationRoadmapSheetInfo(siteId: number): Promise<{
  url: string | null;
  tabTitle: string | null;
  lastSyncedAt: string | null;
}> {
  const [id, tabTitle, lastSyncedAt] = await Promise.all([
    readState(siteId, "id"),
    readState(siteId, "tab"),
    readState(siteId, "synced_at"),
  ]);
  return {
    url: id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null,
    tabTitle,
    lastSyncedAt,
  };
}

export function parseSpreadsheetId(raw: string): string | null {
  const value = raw.trim();
  const fromUrl = value.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1];
  const id = fromUrl ?? value;
  return /^[A-Za-z0-9_-]{20,100}$/.test(id) ? id : null;
}

function a1Title(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function columnLetter(oneBased: number): string {
  let value = oneBased;
  let result = "";
  while (value > 0) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function dateOffset(from: Date, days: number): string {
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function freshnessState(observedAt: Date | null, maxAgeMs: number): "fresh" | "stale" | "missing" {
  if (!observedAt) return "missing";
  return Date.now() - observedAt.getTime() > maxAgeMs ? "stale" : "fresh";
}

function safeErrorDetail(source: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not connected|missing .*integration|credentials/i.test(message)) {
    return `${source} is not connected; metrics are blank rather than zero.`;
  }
  return `${source} was unavailable during this refresh; metrics are blank rather than zero.`;
}

function emptyMetrics(
  path: string,
  site: SiteContext,
  title: string | null,
  available: ReadonlySet<RoadmapSourceFreshness["source"]>,
): RoadmapMetrics {
  return {
    path,
    url: canonicalUrl(path, site.host),
    title,
    gscImpressions: available.has("GSC") ? 0 : null,
    gscClicks: available.has("GSC") ? 0 : null,
    gscCtr: available.has("GSC") ? 0 : null,
    gscPosition: null,
    gscTopQuery: null,
    ga4Sessions: available.has("GA4") ? 0 : null,
    ga4EngagementRate: available.has("GA4") ? 0 : null,
    ga4AvgEngagementTime: available.has("GA4") ? 0 : null,
    ga4KeyEvents: available.has("GA4") ? 0 : null,
    ga4AiSessions: available.has("GA4") ? 0 : null,
    bingImpressions: available.has("Bing") ? 0 : null,
    bingClicks: available.has("Bing") ? 0 : null,
    bingPosition: null,
    aiCitations: available.has("AI citations") ? 0 : null,
    aiPromptInstances: available.has("AI citations") ? 0 : null,
    contentInboundLinks: available.has("Content links") ? 0 : null,
    contentOutboundLinks: available.has("Content links") ? 0 : null,
  };
}

function extraPromptInstances(extra: Record<string, string> | null): number {
  if (!extra) return 0;
  for (const [key, value] of Object.entries(extra)) {
    if (/prompt.*instance|instance.*prompt/i.test(key)) {
      const parsed = Number(String(value).replace(/,/g, ""));
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return 0;
}

async function loadRoadmapData(site: SiteContext, now: Date): Promise<LoadedRoadmapData> {
  const gscWindow = { start: dateOffset(now, 32), end: dateOffset(now, 3) };
  const ga4Window = { start: dateOffset(now, 30), end: dateOffset(now, 1) };

  const [
    pages,
    blockRegexes,
    contentEdges,
    linkObserved,
    bingRows,
    bingObserved,
    latestCitationUpload,
    gscResult,
    ga4Result,
  ] = await Promise.all([
    db
      .select({
        path: pagesTable.path,
        title: pagesTable.title,
        firstSeenAt: pagesTable.firstSeenAt,
      })
      .from(pagesTable)
      .where(eq(pagesTable.siteId, site.id)),
    loadBlockRegexes(site.id),
    db
      .select({
        sourceUrl: linkGraphTable.sourceUrl,
        targetUrl: linkGraphTable.targetUrl,
      })
      .from(linkGraphTable)
      .where(and(eq(linkGraphTable.siteId, site.id), eq(linkGraphTable.placement, "content"))),
    db
      .select({ observedAt: max(linkGraphTable.crawledAt) })
      .from(linkGraphTable)
      .where(and(eq(linkGraphTable.siteId, site.id), eq(linkGraphTable.placement, "content"))),
    db
      .select()
      .from(bingPageStatsTable)
      .where(eq(bingPageStatsTable.siteId, site.id)),
    db
      .select({ observedAt: max(pagesTable.bingSyncedAt) })
      .from(pagesTable)
      .where(eq(pagesTable.siteId, site.id)),
    db
      .select()
      .from(aiCitationUploadsTable)
      .where(
        and(
          eq(aiCitationUploadsTable.siteId, site.id),
          eq(aiCitationUploadsTable.kind, "pages"),
        ),
      )
      .orderBy(desc(aiCitationUploadsTable.id))
      .limit(1),
    queryGsc({
      siteId: site.id,
      startDate: gscWindow.start,
      endDate: gscWindow.end,
      dimensions: ["page", "query"],
      rowLimit: 25_000,
    })
      .then((rows) => ({ rows, error: null as unknown }))
      .catch((error: unknown) => ({ rows: null, error })),
    queryGa4Pages({
      startDate: ga4Window.start,
      endDate: ga4Window.end,
      channel: "all",
      site,
    })
      .then(({ rows }) => ({ rows, error: null as unknown }))
      .catch((error: unknown) => ({ rows: null, error })),
  ]);

  const freshness: RoadmapSourceFreshness[] = [];
  freshness.push(
    gscResult.rows
      ? {
          source: "GSC",
          state: "fresh",
          windowStart: gscWindow.start,
          windowEnd: gscWindow.end,
          observedAt: now.toISOString(),
          detail: "Live Search Console query; 30-day lag-aware window.",
        }
      : {
          source: "GSC",
          state: "missing",
          windowStart: gscWindow.start,
          windowEnd: gscWindow.end,
          observedAt: null,
          detail: safeErrorDetail("GSC", gscResult.error),
        },
  );
  freshness.push(
    ga4Result.rows
      ? {
          source: "GA4",
          state: "fresh",
          windowStart: ga4Window.start,
          windowEnd: ga4Window.end,
          observedAt: now.toISOString(),
          detail: "Live GA4 all-channel landing-page query; Pakistan traffic excluded.",
        }
      : {
          source: "GA4",
          state: "missing",
          windowStart: ga4Window.start,
          windowEnd: ga4Window.end,
          observedAt: null,
          detail: safeErrorDetail("GA4", ga4Result.error),
        },
  );

  const latestBingDate =
    bingRows.reduce<string | null>(
      (latest, row) => (!latest || row.bucketDate > latest ? row.bucketDate : latest),
      null,
    ) ?? null;
  const bingObservedAt = bingObserved[0]?.observedAt ?? null;
  freshness.push({
    source: "Bing",
    state:
      bingRows.length === 0 ? "missing" : freshnessState(bingObservedAt, 2 * DAY_MS),
    windowStart: latestBingDate ? dateOffset(new Date(`${latestBingDate}T00:00:00Z`), 29) : null,
    windowEnd: latestBingDate,
    observedAt: bingObservedAt?.toISOString() ?? null,
    detail:
      bingRows.length === 0
        ? "No stored Bing page statistics; metrics are blank rather than zero."
        : "Latest stored 30-day slice from the daily Bing sync.",
  });

  const citationUpload = latestCitationUpload[0] ?? null;
  const citationUploadedAt = citationUpload?.uploadedAt ?? null;
  const citationWindow = citationUpload
    ? inferCitationWindow(citationUpload.label)
    : { isThirtyDay: false, windowStart: null, windowEnd: null };
  const citationAgeState = freshnessState(citationUploadedAt, 35 * DAY_MS);
  freshness.push({
    source: "AI citations",
    state:
      citationAgeState === "missing"
        ? "missing"
        : citationWindow.isThirtyDay && citationAgeState === "fresh"
          ? "fresh"
          : "stale",
    windowStart: citationWindow.windowStart,
    windowEnd: citationWindow.windowEnd,
    observedAt: citationUploadedAt?.toISOString() ?? null,
    detail: citationUpload
      ? citationWindow.isThirtyDay
        ? `Manual page-citation upload declares a 30-day report: ${citationUpload.label}.`
        : `Manual page-citation upload has no verifiable 30-day window and is marked stale: ${citationUpload.label}.`
      : "No page-citation upload; metrics are blank rather than zero.",
  });

  const linkObservedAt = linkObserved[0]?.observedAt ?? null;
  freshness.push({
    source: "Content links",
    state:
      contentEdges.length === 0 ? "missing" : freshnessState(linkObservedAt, 8 * DAY_MS),
    windowStart: null,
    windowEnd: null,
    observedAt: linkObservedAt?.toISOString() ?? null,
    detail:
      contentEdges.length === 0
        ? "No content-placement link graph; metrics are blank rather than zero."
        : "Content-placement edges only; header, nav, footer, and sidebar are excluded.",
  });

  const available = new Set(
    freshness.filter((item) => item.state !== "missing").map((item) => item.source),
  );
  const visiblePages = pages
    .filter((page) => !isBlockedPath(page.path, blockRegexes))
    .sort(
      (a, b) =>
        (a.firstSeenAt?.getTime() ?? 0) - (b.firstSeenAt?.getTime() ?? 0) ||
        a.path.localeCompare(b.path),
    );
  const metricsByPath = new Map(
    visiblePages.map((page) => [
      page.path,
      emptyMetrics(page.path, site, page.title, available),
    ]),
  );

  if (gscResult.rows) {
    const aggregate = new Map<
      string,
      {
        impressions: number;
        clicks: number;
        positionSum: number;
        positionWeight: number;
        queries: Map<string, number>;
      }
    >();
    for (const row of gscResult.rows) {
      const path = canonicalPath(row.url, site.host);
      if (!path || isBlockedPath(path, blockRegexes)) continue;
      let item = aggregate.get(path);
      if (!item) {
        item = {
          impressions: 0,
          clicks: 0,
          positionSum: 0,
          positionWeight: 0,
          queries: new Map(),
        };
        aggregate.set(path, item);
      }
      item.impressions += row.impressions;
      item.clicks += row.clicks;
      const weight = Math.max(row.impressions, 1);
      item.positionSum += row.position * weight;
      item.positionWeight += weight;
      if (row.query) {
        item.queries.set(row.query, (item.queries.get(row.query) ?? 0) + row.impressions);
      }
    }
    for (const [path, item] of aggregate) {
      const metric =
        metricsByPath.get(path) ?? emptyMetrics(path, site, null, available);
      metric.gscImpressions = item.impressions;
      metric.gscClicks = item.clicks;
      metric.gscCtr = item.impressions > 0 ? item.clicks / item.impressions : 0;
      metric.gscPosition =
        item.positionWeight > 0 ? item.positionSum / item.positionWeight : null;
      metric.gscTopQuery =
        [...item.queries.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      metricsByPath.set(path, metric);
    }
  }

  if (ga4Result.rows) {
    for (const row of ga4Result.rows) {
      const metric =
        metricsByPath.get(row.path) ?? emptyMetrics(row.path, site, null, available);
      metric.ga4Sessions = row.sessions;
      metric.ga4EngagementRate = row.engagementRate;
      metric.ga4AvgEngagementTime = row.avgEngagementTime;
      metric.ga4KeyEvents = row.keyEvents;
      metric.ga4AiSessions = row.aiSessions;
      metricsByPath.set(row.path, metric);
    }
  }

  if (latestBingDate) {
    const bingStart = dateOffset(new Date(`${latestBingDate}T00:00:00Z`), 29);
    const aggregate = new Map<
      string,
      { impressions: number; clicks: number; positionSum: number; positionWeight: number }
    >();
    for (const row of bingRows) {
      if (row.bucketDate < bingStart || row.bucketDate > latestBingDate) continue;
      let item = aggregate.get(row.path);
      if (!item) {
        item = { impressions: 0, clicks: 0, positionSum: 0, positionWeight: 0 };
        aggregate.set(row.path, item);
      }
      item.impressions += row.impressions;
      item.clicks += row.clicks;
      if (row.position !== null) {
        const weight = Math.max(row.impressions, 1);
        item.positionSum += row.position * weight;
        item.positionWeight += weight;
      }
    }
    for (const [path, item] of aggregate) {
      const metric =
        metricsByPath.get(path) ?? emptyMetrics(path, site, null, available);
      metric.bingImpressions = item.impressions;
      metric.bingClicks = item.clicks;
      metric.bingPosition =
        item.positionWeight > 0 ? item.positionSum / item.positionWeight : null;
      metricsByPath.set(path, metric);
    }
  }

  if (citationUpload) {
    const citationRows = await db
      .select({
        path: aiCitationRowsTable.path,
        citations: aiCitationRowsTable.citations,
        extra: aiCitationRowsTable.extra,
      })
      .from(aiCitationRowsTable)
      .where(
        and(
          eq(aiCitationRowsTable.siteId, site.id),
          eq(aiCitationRowsTable.uploadId, citationUpload.id),
        ),
      );
    for (const row of citationRows) {
      if (!row.path) continue;
      const metric =
        metricsByPath.get(row.path) ?? emptyMetrics(row.path, site, null, available);
      metric.aiCitations = (metric.aiCitations ?? 0) + row.citations;
      metric.aiPromptInstances =
        (metric.aiPromptInstances ?? 0) + extraPromptInstances(row.extra);
      metricsByPath.set(row.path, metric);
    }
  }

  for (const edge of contentEdges) {
    const sourcePath = canonicalPath(edge.sourceUrl, site.host);
    const targetPath = canonicalPath(edge.targetUrl, site.host);
    if (sourcePath) {
      const metric =
        metricsByPath.get(sourcePath) ?? emptyMetrics(sourcePath, site, null, available);
      metric.contentOutboundLinks = (metric.contentOutboundLinks ?? 0) + 1;
      metricsByPath.set(sourcePath, metric);
    }
    if (targetPath) {
      const metric =
        metricsByPath.get(targetPath) ?? emptyMetrics(targetPath, site, null, available);
      metric.contentInboundLinks = (metric.contentInboundLinks ?? 0) + 1;
      metricsByPath.set(targetPath, metric);
    }
  }

  return {
    metricsByPath,
    freshness,
    pageOrder: visiblePages.map((page) => page.path),
  };
}

async function fetchSpreadsheetMeta(id: string): Promise<SpreadsheetMeta> {
  return sheetsRequest<SpreadsheetMeta>(
    `/v4/spreadsheets/${id}?fields=spreadsheetUrl,properties.title,sheets.properties(sheetId,title,gridProperties)`,
  );
}

async function getValues(spreadsheetId: string, range: string): Promise<ValueRange> {
  return sheetsRequest<ValueRange>(
    `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
  );
}

async function findRoadmapTab(
  spreadsheetId: string,
  meta: SpreadsheetMeta,
  preferredTitle: string | null,
): Promise<{
  properties: SheetProperties;
  headerRow: number;
  headers: string[];
  rows: Array<Array<string | number | boolean>>;
}> {
  const sheets = (meta.sheets ?? [])
    .map((sheet) => sheet.properties)
    .filter((properties): properties is SheetProperties => Boolean(properties?.title));
  const preferred = preferredTitle
    ? sheets.find((sheet) => sheet.title === preferredTitle)
    : undefined;
  const candidates = [
    preferred,
    sheets.find((sheet) => sheet.title === ROADMAP_TAB_TITLE),
    sheets.find((sheet) => /sitemap.*roadmap|roadmap.*sitemap/i.test(sheet.title ?? "")),
    ...sheets,
  ].filter((sheet, index, all): sheet is SheetProperties => {
    if (!sheet) return false;
    return all.findIndex((candidate) => candidate?.sheetId === sheet.sheetId) === index;
  });

  for (const properties of candidates) {
    const title = properties.title!;
    const values =
      (await getValues(spreadsheetId, `${a1Title(title)}!1:10000`)).values ?? [];
    const maxHeaderRows = Math.min(values.length, 10);
    for (let index = 0; index < maxHeaderRows; index++) {
      const headers = (values[index] ?? []).map(String);
      const hasKey = findRoadmapKeyColumn(headers) >= 0;
      const hasRoadmapSignal = headers.some((header) =>
        /opportunity|topic cluster|low.?hanging|gsc impressions|sitemap/i.test(header),
      );
      if (!hasKey || !hasRoadmapSignal) continue;
      return {
        properties,
        headerRow: index + 1,
        headers,
        rows: values.slice(index + 1),
      };
    }
  }
  throw new Error(
    "No roadmap tab found. The existing sheet needs a Path or URL column plus a roadmap metric column.",
  );
}

async function ensureGridSize(
  spreadsheetId: string,
  sheet: SheetProperties,
  rows: number,
  columns: number,
): Promise<void> {
  if (sheet.sheetId === undefined) throw new Error("Roadmap tab has no sheet id");
  const requests: unknown[] = [];
  const rowCount = sheet.gridProperties?.rowCount ?? 0;
  const columnCount = sheet.gridProperties?.columnCount ?? 0;
  if (rows > rowCount) {
    requests.push({
      appendDimension: {
        sheetId: sheet.sheetId,
        dimension: "ROWS",
        length: rows - rowCount,
      },
    });
  }
  if (columns > columnCount) {
    requests.push({
      appendDimension: {
        sheetId: sheet.sheetId,
        dimension: "COLUMNS",
        length: columns - columnCount,
      },
    });
  }
  if (requests.length > 0) {
    await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: { requests },
    });
  }
}

async function ensureFreshnessTab(
  spreadsheetId: string,
  meta: SpreadsheetMeta,
): Promise<SheetProperties> {
  const existing = meta.sheets
    ?.map((sheet) => sheet.properties)
    .find((properties) => properties?.title === FRESHNESS_TAB_TITLE);
  if (existing) return existing;
  const result = await sheetsRequest<{
    replies?: Array<{ addSheet?: { properties?: SheetProperties } }>;
  }>(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [
        {
          addSheet: {
            properties: {
              title: FRESHNESS_TAB_TITLE,
              gridProperties: { rowCount: 20, columnCount: 7 },
            },
          },
        },
      ],
    },
  });
  const properties = result.replies?.[0]?.addSheet?.properties;
  if (!properties) throw new Error("Google Sheets did not return the new freshness tab");
  return properties;
}

function buildFreshnessValues(
  freshness: RoadmapSourceFreshness[],
  refreshedAt: string,
): Array<Array<string>> {
  return [
    ["Source", "Status", "Window Start", "Window End", "Observed / Uploaded At", "Refreshed At", "Detail"],
    ...freshness.map((item) => [
      item.source,
      item.state.toUpperCase(),
      item.windowStart ?? "",
      item.windowEnd ?? "",
      item.observedAt ?? "",
      refreshedAt,
      item.detail,
    ]),
  ];
}

async function formatFreshnessTab(
  spreadsheetId: string,
  tab: SheetProperties,
  rowCount: number,
): Promise<void> {
  if (tab.sheetId === undefined) throw new Error("Freshness tab has no sheet id");
  await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: tab.sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 7,
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.89, green: 0.93, blue: 0.98 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId: tab.sheetId,
                startRowIndex: 0,
                endRowIndex: rowCount,
                startColumnIndex: 0,
                endColumnIndex: 7,
              },
            },
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: tab.sheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: 7,
            },
          },
        },
      ],
    },
  });
}

async function refreshOptimizationRoadmapSheetInner(
  site: SiteContext,
  options: { spreadsheetId?: string; tabTitle?: string } = {},
): Promise<OptimizationRoadmapRefreshResult> {
  const storedId = await readState(site.id, "id");
  const suppliedId = options.spreadsheetId
    ? parseSpreadsheetId(options.spreadsheetId)
    : null;
  if (options.spreadsheetId && !suppliedId) {
    throw new Error("Invalid Google Sheets spreadsheet id or URL");
  }
  const spreadsheetId = suppliedId ?? storedId;
  if (!spreadsheetId) {
    return {
      skipped: true,
      url: null,
      tabTitle: null,
      rowCount: 0,
      addedRows: 0,
      addedColumns: [],
      refreshedAt: null,
      freshness: [],
    };
  }

  const storedTab = options.tabTitle?.trim() || (await readState(site.id, "tab"));
  const meta = await fetchSpreadsheetMeta(spreadsheetId);
  const roadmap = await findRoadmapTab(spreadsheetId, meta, storedTab);
  // Read-only validation happens before claiming. The claim is durable before
  // the first Sheets write, so a retry stays with this site and another site
  // cannot race in between validation and update.
  await claimOptimizationRoadmapBinding(site.id, spreadsheetId);
  const now = new Date();
  const refreshedAt = now.toISOString();
  const data = await loadRoadmapData(site, now);

  const keyColumn = findRoadmapKeyColumn(roadmap.headers);
  const existingPaths = new Set(
    roadmap.rows
      .map((row) => normalizeRoadmapPath(String(row[keyColumn] ?? "")))
      .filter((path): path is string => Boolean(path)),
  );
  const addedPaths = data.pageOrder.filter((path) => !existingPaths.has(path));
  const titleColumn = roadmap.headers.findIndex((header) => /^page title$|^title$/i.test(header.trim()));
  const keyIsUrl = /url/i.test(roadmap.headers[keyColumn] ?? "");
  const appendedRows = addedPaths.map((path) => {
    const row: Array<string | number | boolean> = Array.from(
      { length: Math.max(roadmap.headers.length, keyColumn + 1) },
      () => "",
    );
    row[keyColumn] = keyIsUrl ? canonicalUrl(path, site.host) : path;
    if (titleColumn >= 0) row[titleColumn] = data.metricsByPath.get(path)?.title ?? "";
    return row;
  });
  const allRows = [...roadmap.rows, ...appendedRows];

  // Sheet rows that are not yet in the page registry still retain their place.
  // Give them a blank-aware metric object so freshness dates and stable scoring
  // can be written without treating unavailable providers as zero.
  const available = new Set(
    data.freshness.filter((item) => item.state !== "missing").map((item) => item.source),
  );
  for (const row of allRows) {
    const path = normalizeRoadmapPath(String(row[keyColumn] ?? ""));
    if (path && !data.metricsByPath.has(path)) {
      data.metricsByPath.set(
        path,
        emptyMetrics(
          path,
          site,
          titleColumn >= 0 ? String(row[titleColumn] ?? "") || null : null,
          available,
        ),
      );
    }
  }

  const plan = buildRoadmapColumnPlan({
    headers: roadmap.headers,
    rows: allRows,
    metricsByPath: data.metricsByPath,
    refreshedAt,
    freshness: data.freshness,
  });
  const title = roadmap.properties.title!;
  const neededRows = roadmap.headerRow + allRows.length;
  await ensureGridSize(
    spreadsheetId,
    roadmap.properties,
    neededRows,
    plan.headers.length,
  );

  const freshnessTab = await ensureFreshnessTab(spreadsheetId, meta);
  const freshnessValues = buildFreshnessValues(data.freshness, refreshedAt);
  const batchData: Array<{
    range: string;
    majorDimension: "ROWS";
    values: Array<Array<string | number | boolean>>;
  }> = [];
  if (appendedRows.length > 0) {
    const firstRow = roadmap.headerRow + roadmap.rows.length + 1;
    const lastRow = firstRow + appendedRows.length - 1;
    const keyLetter = columnLetter(keyColumn + 1);
    batchData.push({
      range: `${a1Title(title)}!${keyLetter}${firstRow}:${keyLetter}${lastRow}`,
      majorDimension: "ROWS",
      values: appendedRows.map((row) => [row[keyColumn] ?? ""]),
    });
    if (titleColumn >= 0 && titleColumn !== keyColumn) {
      const titleLetter = columnLetter(titleColumn + 1);
      batchData.push({
        range: `${a1Title(title)}!${titleLetter}${firstRow}:${titleLetter}${lastRow}`,
        majorDimension: "ROWS",
        values: appendedRows.map((row) => [row[titleColumn] ?? ""]),
      });
    }
  }
  batchData.push(
    ...plan.columns.map((column) => {
      const letter = columnLetter(column.columnIndex + 1);
      return {
        range: `${a1Title(title)}!${letter}${roadmap.headerRow}:${letter}${neededRows}`,
        majorDimension: "ROWS" as const,
        values: [[column.header], ...column.values.map((value) => [value])],
      };
    }),
    {
      range: `${a1Title(FRESHNESS_TAB_TITLE)}!A1:G${freshnessValues.length}`,
      majorDimension: "ROWS",
      values: freshnessValues,
    },
  );

  // Google Sheets values.batchUpdate validates the complete request before
  // applying it, so row additions, managed metrics, and freshness advance
  // together. Unknown/manual columns are absent and remain untouched.
  await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: {
      valueInputOption: "RAW",
      data: batchData,
    },
  });

  try {
    await formatFreshnessTab(spreadsheetId, freshnessTab, freshnessValues.length);
  } catch (error) {
    logger.warn(
      { err: error, siteId: site.id, spreadsheetId },
      "Optimization roadmap values refreshed but freshness-tab formatting failed",
    );
  }

  await writeState(site.id, {
    tab: title,
    synced_at: refreshedAt,
  });
  logger.info(
    {
      siteId: site.id,
      spreadsheetId,
      tabTitle: title,
      rowCount: allRows.length,
      addedRows: addedPaths.length,
      addedColumns: plan.addedHeaders,
      freshness: data.freshness.map((item) => ({
        source: item.source,
        state: item.state,
        observedAt: item.observedAt,
      })),
    },
    "Optimization roadmap sheet refreshed",
  );

  return {
    skipped: false,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    tabTitle: title,
    rowCount: allRows.length,
    addedRows: addedPaths.length,
    addedColumns: plan.addedHeaders,
    refreshedAt,
    freshness: data.freshness,
  };
}

const refreshesInFlight = new Map<
  number,
  { spreadsheetId: string | null; promise: Promise<OptimizationRoadmapRefreshResult> }
>();

export async function withOptimizationRoadmapRefreshLock<T>(
  siteId: number,
  operation: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Keep the lock for the full sheet read → value write sequence. The job
    // runner and in-memory map only coordinate one process; this transaction-
    // scoped lock also serializes cron/manual work across autoscaled instances.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${BASE_KEY}:refresh:${siteId}`}))`,
    );
    return operation();
  });
}

/**
 * Coalesces manual, cron, and catch-up refreshes for one site so their sheet
 * writes cannot overlap. A concurrent attempt to bind a different workbook is
 * rejected instead of being silently folded into the active refresh.
 */
export async function refreshOptimizationRoadmapSheet(
  site: SiteContext,
  options: { spreadsheetId?: string; tabTitle?: string } = {},
): Promise<OptimizationRoadmapRefreshResult> {
  const requestedId = options.spreadsheetId
    ? parseSpreadsheetId(options.spreadsheetId)
    : null;
  const active = refreshesInFlight.get(site.id);
  if (active) {
    if (requestedId && requestedId !== active.spreadsheetId) {
      throw new Error("A refresh for a different roadmap workbook is already running");
    }
    return active.promise;
  }

  const promise = withOptimizationRoadmapRefreshLock(site.id, () =>
    refreshOptimizationRoadmapSheetInner(site, options),
  ).finally(() => {
    const current = refreshesInFlight.get(site.id);
    if (current?.promise === promise) refreshesInFlight.delete(site.id);
  });
  refreshesInFlight.set(site.id, { spreadsheetId: requestedId, promise });
  return promise;
}
