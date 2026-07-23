// "Wellows — Target Keyword Daily Movement" Google Sheet template.
//
// Reproduces the workbook layout the operator approved as the template:
//   - Tab "Keyword summary" (frozen header row): one row per tracked keyword
//     with full-range totals plus last-7d vs prior-7d movement.
//   - One tab per keyword (frozen first column): Target keyword / Page /
//     blank / Date / Impressions / Impr change / Clicks / Clicks change /
//     Position / Position change (+ = moved up), with one column per day.
//
// Data source is Search Console only — no crawling, no paid fetches, no AI.
//
// The spreadsheet is PERSISTENT: the first export creates it and stores its id
// in app_state; every later export (and the daily sync_keyword_sheet job)
// rewrites the SAME spreadsheet in place, so the operator's bookmarked sheet
// rolls forward every day instead of going stale.
import { db, trackedSubmissionsTable, appStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { LEGACY_SITE_ID, type SiteContext } from "../lib/site";
import {
  queryGscDimension,
  pageVariantsRegex,
  keywordExactRegex,
  type GscDimensionRow,
} from "../integrations/gsc";
import { sheetsRequest } from "../integrations/googleSheets";

interface KeywordSeries {
  keyword: string;
  url: string;
  byDate: Map<string, GscDimensionRow>;
}

interface SummaryRow {
  keyword: string;
  url: string;
  totalImpressions: number;
  totalClicks: number;
  avgPosition: number | null;
  last7Impressions: number;
  imprChange: number;
  last7Clicks: number;
  clicksChange: number;
  last7Position: number | null;
  positionChange: number | null;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cur.getTime() <= end.getTime()) {
    out.push(isoDay(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Impression-weighted average position over rows that have any impressions. */
function weightedPosition(rows: GscDimensionRow[]): number | null {
  let sum = 0;
  let weight = 0;
  for (const r of rows) {
    if (r.impressions > 0) {
      sum += r.position * r.impressions;
      weight += r.impressions;
    }
  }
  return weight > 0 ? sum / weight : null;
}

/** Sheet tab titles may not contain [ ] * / \ ? : and are capped at 100 chars. */
function sanitizeTabTitle(raw: string): string {
  const cleaned = raw.replace(/[[\]*/\\?:]/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "keyword").slice(0, 90);
}

function dedupeTabTitles(titles: string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((t) => {
    const key = t.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? t : `${t} (${count + 1})`;
  });
}

function summarize(
  series: KeywordSeries,
  dates: string[],
  last7Start: string,
  prior7Start: string,
): SummaryRow {
  const all: GscDimensionRow[] = [];
  const last7: GscDimensionRow[] = [];
  const prior7: GscDimensionRow[] = [];
  for (const date of dates) {
    const row = series.byDate.get(date);
    if (!row) continue;
    all.push(row);
    if (date >= last7Start) last7.push(row);
    else if (date >= prior7Start) prior7.push(row);
  }
  const sum = (rows: GscDimensionRow[], f: (r: GscDimensionRow) => number) =>
    rows.reduce((acc, r) => acc + f(r), 0);
  const totalImpressions = Math.round(sum(all, (r) => r.impressions));
  const totalClicks = Math.round(sum(all, (r) => r.clicks));
  const last7Impressions = Math.round(sum(last7, (r) => r.impressions));
  const prior7Impressions = Math.round(sum(prior7, (r) => r.impressions));
  const last7Clicks = Math.round(sum(last7, (r) => r.clicks));
  const prior7Clicks = Math.round(sum(prior7, (r) => r.clicks));
  const last7Position = weightedPosition(last7);
  const prior7Position = weightedPosition(prior7);
  return {
    keyword: series.keyword,
    url: series.url,
    totalImpressions,
    totalClicks,
    avgPosition: weightedPosition(all),
    last7Impressions,
    imprChange: last7Impressions - prior7Impressions,
    last7Clicks,
    clicksChange: last7Clicks - prior7Clicks,
    last7Position,
    // Positive = moved up the rankings (position number went down).
    positionChange:
      last7Position != null && prior7Position != null
        ? prior7Position - last7Position
        : null,
  };
}

function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

type Cell = string | number;

function keywordTabValues(
  series: KeywordSeries,
  dates: string[],
): Cell[][] {
  const impressions: Cell[] = ["Impressions"];
  const imprChange: Cell[] = ["Impr change"];
  const clicks: Cell[] = ["Clicks"];
  const clicksChange: Cell[] = ["Clicks change"];
  const position: Cell[] = ["Position"];
  const positionChange: Cell[] = ["Position change (+ = moved up)"];

  let prevImpr: number | null = null;
  let prevClicks: number | null = null;
  let prevPos: number | null = null;
  for (const date of dates) {
    const row = series.byDate.get(date);
    const impr = Math.round(row?.impressions ?? 0);
    const clk = Math.round(row?.clicks ?? 0);
    const pos = row && row.impressions > 0 ? round1(row.position) : null;

    impressions.push(impr);
    imprChange.push(prevImpr == null ? "" : impr - prevImpr);
    clicks.push(clk);
    clicksChange.push(prevClicks == null ? "" : clk - prevClicks);
    position.push(pos == null ? "" : pos);
    positionChange.push(
      pos != null && prevPos != null ? round1(prevPos - pos) : "",
    );

    prevImpr = impr;
    prevClicks = clk;
    if (pos != null) prevPos = pos;
  }

  return [
    ["Target keyword", series.keyword],
    ["Page", series.url],
    [],
    ["Date", ...dates],
    impressions,
    imprChange,
    clicks,
    clicksChange,
    position,
    positionChange,
  ];
}

function summaryValues(rows: SummaryRow[], rangeLabel: string): Cell[][] {
  const header: Cell[] = [
    "Target keyword",
    "Page",
    `Impressions (${rangeLabel})`,
    `Clicks (${rangeLabel})`,
    `Avg position (${rangeLabel})`,
    "Impressions (last 7d)",
    "Impr change vs prior 7d",
    "Clicks (last 7d)",
    "Clicks change vs prior 7d",
    "Position (last 7d)",
    "Position change vs prior 7d (+ = moved up)",
  ];
  const body = rows.map((r): Cell[] => [
    r.keyword,
    pagePath(r.url),
    r.totalImpressions,
    r.totalClicks,
    r.avgPosition == null ? "" : round1(r.avgPosition),
    r.last7Impressions,
    r.imprChange,
    r.last7Clicks,
    r.clicksChange,
    r.last7Position == null ? "" : round1(r.last7Position),
    r.positionChange == null ? "" : round1(r.positionChange),
  ]);
  return [header, ...body];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export class NoTrackedKeywordsError extends Error {
  constructor() {
    super("No tracked submissions with a target keyword");
  }
}

const SHEET_ID_STATE_KEY = "keyword_movement_sheet_id";

// app_state is global (key/value), so the persisted spreadsheet id is scoped
// into the key: the legacy site keeps the original key (preserving the
// operator's bookmarked sheet), every other site gets a per-site suffix so
// exports never clobber each other's spreadsheets.
function sheetStateKey(siteId: number): string {
  return siteId === LEGACY_SITE_ID
    ? SHEET_ID_STATE_KEY
    : `${SHEET_ID_STATE_KEY}:${siteId}`;
}

async function loadStoredSheetId(siteId: number): Promise<string | null> {
  const [row] = await db
    .select()
    .from(appStateTable)
    .where(eq(appStateTable.key, sheetStateKey(siteId)))
    .limit(1);
  return row?.value ?? null;
}

async function storeSheetId(id: string, siteId: number): Promise<void> {
  await db
    .insert(appStateTable)
    .values({ key: sheetStateKey(siteId), value: id, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appStateTable.key,
      set: { value: id, updatedAt: new Date() },
    });
}

interface ExistingSheetMeta {
  spreadsheetUrl?: string;
  sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
}

/**
 * Fetch the stored spreadsheet's tab metadata. Returns null when the sheet is
 * gone or inaccessible (deleted from Drive / permission lost) so the caller
 * can create a fresh one; any other failure (network, 5xx) is rethrown so a
 * transient error never silently spawns a duplicate spreadsheet.
 */
async function fetchExistingSheet(id: string): Promise<ExistingSheetMeta | null> {
  try {
    return await sheetsRequest<ExistingSheetMeta>(
      `/v4/spreadsheets/${id}?fields=spreadsheetUrl,sheets.properties(sheetId,title)`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/failed \((403|404)\)/.test(msg)) return null;
    throw e;
  }
}

export async function exportKeywordMovementSheet(
  days: number,
  site: Pick<SiteContext, "id" | "displayName">,
): Promise<{
  url: string;
  title: string;
  keywordCount: number;
}> {
  const siteId = site.id;
  const subs = await db
    .select()
    .from(trackedSubmissionsTable)
    .where(eq(trackedSubmissionsTable.siteId, siteId));
  const tracked = subs
    .filter((s) => (s.keyword ?? "").trim().length > 0)
    .map((s) => ({ url: s.url, keyword: (s.keyword ?? "").trim() }));
  if (tracked.length === 0) throw new NoTrackedKeywordsError();

  // GSC data lags ~2 days behind real time.
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const endDate = isoDay(end);
  const startDate = isoDay(start);
  const dates = dateRange(startDate, endDate);

  const last7StartD = new Date(end);
  last7StartD.setUTCDate(last7StartD.getUTCDate() - 6);
  const prior7StartD = new Date(end);
  prior7StartD.setUTCDate(prior7StartD.getUTCDate() - 13);
  const last7Start = isoDay(last7StartD);
  const prior7Start = isoDay(prior7StartD);

  // One GSC call per keyword: daily series for page (incl. #fragment/?query
  // variants) filtered to the exact keyword (case-insensitive).
  const series = await mapWithConcurrency(tracked, 4, async (t) => {
    const rows = await queryGscDimension({
      siteId,
      startDate,
      endDate,
      dimension: "date",
      pageRegex: pageVariantsRegex(t.url),
      queryFilter: {
        expression: keywordExactRegex(t.keyword),
        operator: "includingRegex",
      },
    });
    const byDate = new Map(rows.map((r) => [r.key, r]));
    return { keyword: t.keyword, url: t.url, byDate } satisfies KeywordSeries;
  });

  const summaries = series.map((s) =>
    summarize(s, dates, last7Start, prior7Start),
  );
  const order = summaries
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.totalImpressions - a.s.totalImpressions);
  const sortedSeries = order.map((o) => series[o.i]!);
  const sortedSummaries = order.map((o) => o.s);

  const rangeLabel = days === 90 ? "3mo" : `${days}d`;
  // Legacy site keeps the exact historical title the operator bookmarked.
  const titlePrefix =
    siteId === LEGACY_SITE_ID ? "Wellows" : site.displayName || `Site ${siteId}`;
  const title = `${titlePrefix} — Target Keyword Daily Movement (${startDate} to ${endDate})`;
  const tabTitles = dedupeTabTitles(
    sortedSeries.map((s) => sanitizeTabTitle(s.keyword)),
  );

  const summaryGrid = {
    rowCount: sortedSummaries.length + 5,
    columnCount: 11,
    frozenRowCount: 1,
  };
  const keywordGrid = {
    rowCount: 12,
    columnCount: dates.length + 2,
    frozenColumnCount: 1,
  };

  // ---- Create the spreadsheet, or rewrite the stored one in place ----
  const storedId = await loadStoredSheetId(siteId);
  const existing = storedId ? await fetchExistingSheet(storedId) : null;

  let spreadsheetId: string;
  let spreadsheetUrl: string | undefined;
  let summarySheetId: number;
  let keywordSheetIds: number[];

  if (storedId && existing) {
    // Rewrite in place with one atomic batchUpdate: rename the old tabs out
    // of the way (title conflicts), add the new set, delete the old set,
    // refresh the doc title. Requests apply in order; add-before-delete keeps
    // the spreadsheet from ever having zero sheets.
    spreadsheetId = storedId;
    spreadsheetUrl = existing.spreadsheetUrl;
    const oldSheets = (existing.sheets ?? [])
      .map((s) => s.properties?.sheetId)
      .filter((id): id is number => typeof id === "number");
    const maxOldId = oldSheets.reduce((m, id) => Math.max(m, id), 0);
    summarySheetId = maxOldId + 1;
    keywordSheetIds = tabTitles.map((_, i) => maxOldId + 2 + i);

    await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: {
        requests: [
          ...oldSheets.map((sheetId) => ({
            updateSheetProperties: {
              properties: { sheetId, title: `__old_${sheetId}` },
              fields: "title",
            },
          })),
          {
            addSheet: {
              properties: {
                sheetId: summarySheetId,
                title: "Keyword summary",
                index: 0,
                gridProperties: summaryGrid,
              },
            },
          },
          ...tabTitles.map((tabTitle, i) => ({
            addSheet: {
              properties: {
                sheetId: keywordSheetIds[i]!,
                title: tabTitle,
                index: i + 1,
                gridProperties: keywordGrid,
              },
            },
          })),
          ...oldSheets.map((sheetId) => ({ deleteSheet: { sheetId } })),
          {
            updateSpreadsheetProperties: {
              properties: { title },
              fields: "title",
            },
          },
        ],
      },
    });
  } else {
    // First export ever, or the stored sheet was deleted from Drive.
    // Size grids up front — writing beyond a tab's grid 400s.
    summarySheetId = 0;
    keywordSheetIds = tabTitles.map((_, i) => 1000 + i);
    const created = await sheetsRequest<{
      spreadsheetId: string;
      spreadsheetUrl: string;
    }>("/v4/spreadsheets", {
      method: "POST",
      body: {
        properties: { title },
        sheets: [
          {
            properties: {
              sheetId: summarySheetId,
              title: "Keyword summary",
              gridProperties: summaryGrid,
            },
          },
          ...tabTitles.map((tabTitle, i) => ({
            properties: {
              sheetId: keywordSheetIds[i]!,
              title: tabTitle,
              gridProperties: keywordGrid,
            },
          })),
        ],
      },
    });
    spreadsheetId = created.spreadsheetId;
    spreadsheetUrl = created.spreadsheetUrl;
    await storeSheetId(spreadsheetId, siteId);
  }

  await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: {
      valueInputOption: "RAW",
      data: [
        {
          range: "'Keyword summary'!A1",
          values: summaryValues(sortedSummaries, rangeLabel),
        },
        ...sortedSeries.map((s, i) => ({
          range: `'${tabTitles[i]!.replace(/'/g, "''")}'!A1`,
          values: keywordTabValues(s, dates),
        })),
      ],
    },
  });

  // Bold headers: summary header row + label column on each keyword tab.
  await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: summarySheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: summarySheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: 11,
            },
          },
        },
        ...keywordSheetIds.map((sheetId) => ({
          repeatCell: {
            range: {
              sheetId,
              startColumnIndex: 0,
              endColumnIndex: 1,
            },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        })),
      ],
    },
  });

  // Strip the account-specific ?ouid=... param — hand back a clean /edit URL.
  const cleanUrl = spreadsheetUrl
    ? spreadsheetUrl.split("?")[0]!
    : `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  return { url: cleanUrl, title, keywordCount: tracked.length };
}
