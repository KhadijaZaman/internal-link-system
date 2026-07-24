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
import {
  sheetsRequest,
  shareSheetWithAnyone,
} from "../integrations/googleSheets";
import {
  computeDaily,
  keywordTabColorMatrix,
  bestWeekFlags,
  changeColor,
  type CellColor,
  type DailyComputed,
} from "./keywordMovementColors";

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
  daily: DailyComputed,
): Cell[][] {
  const blank = (v: number | null): Cell => (v == null ? "" : v);
  return [
    ["Target keyword", series.keyword],
    ["Page", series.url],
    [],
    ["Date", ...dates],
    ["Impressions", ...daily.impr],
    ["Impr change", ...daily.imprChange.map(blank)],
    ["Clicks", ...daily.clicks],
    ["Clicks change", ...daily.clicksChange.map(blank)],
    ["Position", ...daily.pos.map(blank)],
    ["Position change (+ = moved up)", ...daily.posChange.map(blank)],
  ];
}

// Light backgrounds readable under black text; picked to match the standard
// Sheets palette (light red/green/orange 3).
const COLOR_RGB: Record<Exclude<CellColor, null>, {
  red: number;
  green: number;
  blue: number;
}> = {
  green: { red: 0.851, green: 0.918, blue: 0.827 },
  red: { red: 0.957, green: 0.8, blue: 0.8 },
  orange: { red: 0.976, green: 0.796, blue: 0.612 },
};
const WHITE = { red: 1, green: 1, blue: 1 };

function bgCell(c: CellColor): {
  userEnteredFormat: { backgroundColor: { red: number; green: number; blue: number } };
} {
  return {
    userEnteredFormat: { backgroundColor: c == null ? WHITE : COLOR_RGB[c] },
  };
}

const LEGEND_ROWS: Array<{ color: Exclude<CellColor, null>; text: string }> = [
  { color: "green", text: "Green = improved (vs the day before on keyword tabs; vs the prior 7 days on this tab)" },
  { color: "red", text: "Red = declined" },
  { color: "orange", text: "Orange = best ever in this tracking period (new record high for impressions/clicks, or best position yet)" },
];

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

/**
 * URL of the site's persistent movement sheet, or null when no export or
 * daily sync has created one yet. Pure DB read — no Sheets API call, so a
 * deleted-from-Drive sheet may still return a (stale) URL; the next export
 * or daily job run heals that by creating a fresh sheet.
 */
export async function getStoredSheetUrl(siteId: number): Promise<string | null> {
  const id = await loadStoredSheetId(siteId);
  return id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null;
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

// The sheet lives in the operator's Google Drive, so owners clicking the
// dashboard link would hit "Request access" unless the sheet is shared as
// anyone-with-link viewer (Drive permissions API). We record WHICH spreadsheet
// id was successfully shared so the daily rewrite doesn't re-call Drive every
// run, and so the UI can warn when sharing hasn't happened yet (e.g. the
// google-drive connector isn't authorized).
function sharedStateKey(siteId: number): string {
  return `${sheetStateKey(siteId)}:shared`;
}

async function loadSharedSheetId(siteId: number): Promise<string | null> {
  const [row] = await db
    .select()
    .from(appStateTable)
    .where(eq(appStateTable.key, sharedStateKey(siteId)))
    .limit(1);
  return row?.value ?? null;
}

async function storeSharedSheetId(id: string, siteId: number): Promise<void> {
  await db
    .insert(appStateTable)
    .values({ key: sharedStateKey(siteId), value: id, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appStateTable.key,
      set: { value: id, updatedAt: new Date() },
    });
}

/**
 * Best-effort: ensure the site's movement sheet is link-viewable. Skips the
 * Drive call when this spreadsheet id was already shared; retries on every
 * export/daily run otherwise (covers pre-existing sheets and the connector
 * being authorized later). Never throws.
 */
async function ensureSheetShared(
  spreadsheetId: string,
  siteId: number,
): Promise<boolean> {
  const alreadyShared = await loadSharedSheetId(siteId);
  if (alreadyShared === spreadsheetId) return true;
  const ok = await shareSheetWithAnyone(spreadsheetId);
  if (ok) await storeSharedSheetId(spreadsheetId, siteId);
  return ok;
}

/** Whether the stored movement sheet is known to be link-viewable. */
export async function isStoredSheetShared(siteId: number): Promise<boolean> {
  const [sheetId, sharedId] = await Promise.all([
    loadStoredSheetId(siteId),
    loadSharedSheetId(siteId),
  ]);
  return sheetId != null && sheetId === sharedId;
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
  sheetShared: boolean;
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
  const sortedDaily = sortedSeries.map((s) =>
    computeDaily(dates.map((d) => s.byDate.get(d))),
  );

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
          values: keywordTabValues(s, dates, sortedDaily[i]!),
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
        // Color coding — keyword tabs: rows Impressions..Position change
        // (row indexes 4-9), one background per day column. Orange marks a
        // new record on the value rows; green/red mark the change rows.
        ...keywordSheetIds.map((sheetId, i) => ({
          updateCells: {
            start: { sheetId, rowIndex: 4, columnIndex: 1 },
            rows: keywordTabColorMatrix(sortedDaily[i]!).map((row) => ({
              values: row.map(bgCell),
            })),
            fields: "userEnteredFormat.backgroundColor",
          },
        })),
        // Color coding — summary tab: columns F..K (last-7d values + their
        // change vs prior 7d) per keyword row.
        {
          updateCells: {
            start: { sheetId: summarySheetId, rowIndex: 1, columnIndex: 5 },
            rows: sortedSummaries.map((s, i) => {
              const best = bestWeekFlags(sortedDaily[i]!);
              return {
                values: [
                  bgCell(best.impr ? "orange" : null),
                  bgCell(changeColor(s.imprChange)),
                  bgCell(best.clicks ? "orange" : null),
                  bgCell(changeColor(s.clicksChange)),
                  bgCell(best.pos ? "orange" : null),
                  bgCell(changeColor(s.positionChange)),
                ],
              };
            }),
            fields: "userEnteredFormat.backgroundColor",
          },
        },
        // Legend swatches under the summary table (text written below,
        // after autoResize, so long legend lines don't stretch column A).
        {
          updateCells: {
            start: {
              sheetId: summarySheetId,
              rowIndex: sortedSummaries.length + 2,
              columnIndex: 0,
            },
            rows: LEGEND_ROWS.map((l) => ({ values: [bgCell(l.color)] })),
            fields: "userEnteredFormat.backgroundColor",
          },
        },
      ],
    },
  });

  // Legend text — written AFTER the autoResize above so the long labels
  // (which overflow into the empty cells to their right) don't inflate the
  // width of column A.
  await sheetsRequest(
    `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      `'Keyword summary'!A${sortedSummaries.length + 3}`,
    )}?valueInputOption=RAW`,
    {
      method: "PUT",
      body: { values: LEGEND_ROWS.map((l) => [l.text]) },
    },
  );

  // Make the sheet openable by the site owner (not just the operator's
  // Google account). Best-effort — export still succeeds if Drive isn't
  // connected; existing sheets pick this up on their next rewrite.
  const sheetShared = await ensureSheetShared(spreadsheetId, siteId);

  // Strip the account-specific ?ouid=... param — hand back a clean /edit URL.
  const cleanUrl = spreadsheetUrl
    ? spreadsheetUrl.split("?")[0]!
    : `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  return { url: cleanUrl, title, keywordCount: tracked.length, sheetShared };
}
