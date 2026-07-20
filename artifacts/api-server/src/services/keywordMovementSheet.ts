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
import { db, trackedSubmissionsTable } from "@workspace/db";
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

export async function exportKeywordMovementSheet(days: number): Promise<{
  url: string;
  title: string;
  keywordCount: number;
}> {
  const subs = await db.select().from(trackedSubmissionsTable);
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
  const title = `Wellows — Target Keyword Daily Movement (${startDate} to ${endDate})`;
  const tabTitles = dedupeTabTitles(
    sortedSeries.map((s) => sanitizeTabTitle(s.keyword)),
  );

  // Size grids up front — writing beyond a tab's grid 400s.
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
            sheetId: 0,
            title: "Keyword summary",
            gridProperties: {
              rowCount: sortedSummaries.length + 5,
              columnCount: 11,
              frozenRowCount: 1,
            },
          },
        },
        ...tabTitles.map((tabTitle, i) => ({
          properties: {
            sheetId: 1000 + i,
            title: tabTitle,
            gridProperties: {
              rowCount: 12,
              columnCount: dates.length + 2,
              frozenColumnCount: 1,
            },
          },
        })),
      ],
    },
  });

  await sheetsRequest(
    `/v4/spreadsheets/${created.spreadsheetId}/values:batchUpdate`,
    {
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
    },
  );

  // Bold headers: summary header row + label column on each keyword tab.
  await sheetsRequest(`/v4/spreadsheets/${created.spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: 0,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: 11,
            },
          },
        },
        ...tabTitles.map((_, i) => ({
          repeatCell: {
            range: {
              sheetId: 1000 + i,
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
  const cleanUrl = created.spreadsheetUrl
    ? created.spreadsheetUrl.split("?")[0]!
    : `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`;

  return { url: cleanUrl, title, keywordCount: tracked.length };
}
