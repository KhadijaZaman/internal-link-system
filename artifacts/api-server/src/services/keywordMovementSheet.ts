// "Wellows — Target Keyword Daily Movement" Google Sheet template.
//
// Reproduces the workbook layout the operator approved as the template:
//   - Tab "Keyword summary" (frozen header row): one row per tracked keyword
//     with full-range totals plus last-7d vs prior-7d movement.
//   - Tab "Tracked pages — Google, Bing & AI" (frozen header row + Page
//     column): one row per tracked page with page-level Google Search
//     Console impressions/clicks/position (range totals + last-7d movement,
//     across ALL queries), the same Bing metrics (range totals +
//     latest-vs-prior weekly movement), and AI citations from the newest
//     uploaded Bing AI Performance report — all color-coded like the
//     summary tab (green/red change, orange record).
//   - One tab per keyword (frozen first column): Target keyword / Page /
//     blank / Date / Impressions / Impr change / Clicks / Clicks change /
//     Position / Position change (+ = moved up), with one column per day.
//
// Every header cell (and keyword-tab label cell) carries a hover note — an
// in-sheet tooltip explaining the metric, its comparison window, and what
// the cell colors mean.
//
// Data sources are Search Console plus already-synced Bing/AI-citation rows
// from our own database — no crawling, no paid fetches, no AI calls.
// GSC reads use dataState "all" (fresh included): the range ends at
// yesterday Pacific Time and the newest ~2 days revise upward until Google
// finalizes them (position stays blank on days with zero impressions).
// Google's "Generative AI performance" report (AI Overviews / AI Mode) is
// deliberately absent: as of 2026-07 it is UI-only (subset rollout) and the
// Search Analytics API exposes no generative-AI type or searchAppearance.
//
// The spreadsheet is PERSISTENT: the first export creates it and stores its id
// in app_state; every later export (and the daily sync_keyword_sheet job)
// rewrites the SAME spreadsheet in place, so the operator's bookmarked sheet
// rolls forward every day instead of going stale.
import {
  db,
  trackedSubmissionsTable,
  appStateTable,
  bingPageStatsTable,
  aiCitationUploadsTable,
  aiCitationRowsTable,
  type BingPageStat,
} from "@workspace/db";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { LEGACY_SITE_ID, type SiteContext } from "../lib/site";
import { canonicalPath } from "../lib/urlCanon";
import {
  queryGscDimension,
  pageVariantsRegex,
  keywordContainsRegex,
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
  newRecordFlags,
  trackedRowColors,
  type CellColor,
  type DailyComputed,
  type RecordTriple,
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

/** A column header plus the hover note (tooltip) attached to its header cell. */
interface HeaderCol {
  label: string;
  note: string;
}

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

// Hover notes for the label column (rows Date..Position change, A4:A10) on
// every keyword tab — keyword tabs have terse labels, so the tooltip carries
// the explanation instead of a wider header.
const KEYWORD_ROW_NOTES: string[] = [
  "One column per day (Pacific Time), through yesterday. The most recent ~2 days are fresh Search Console estimates and can revise upward until Google finalizes them.",
  "Times the page appeared in US Google results for the target keyword that day, including longer queries containing it (e.g. \"best <keyword>\") — matches the GSC UI with a United States filter + \"Queries containing\". Orange = new record high up to that day.",
  "Impressions vs the day before. Green = up, red = down.",
  "Google clicks for the target keyword that day. Orange = new record high.",
  "Clicks vs the day before. Green = up, red = down.",
  "Average Google position for the keyword that day. Lower is better; orange = best position yet.",
  "The prior day's position minus this day's, so positive = moved up the rankings. Green = improved, red = dropped.",
];

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

/** Headers + hover notes (tooltips) for the Keyword summary tab. */
function summaryHeaderCols(rangeLabel: string): HeaderCol[] {
  return [
    {
      label: "Target keyword",
      note: "Tracked keyword from My Submissions. The matching keyword tab holds its day-by-day detail.",
    },
    { label: "Page", note: "The page this keyword is tracked against." },
    {
      label: `Impressions (${rangeLabel})`,
      note: "US Google impressions for this keyword — including longer queries containing it as a phrase — on this page over the whole range (Search Console, United States filter). Range totals are context only — never color-coded.",
    },
    {
      label: `Clicks (${rangeLabel})`,
      note: "Google clicks for this keyword on this page over the whole range.",
    },
    {
      label: `Avg position (${rangeLabel})`,
      note: "Impression-weighted average Google position for this keyword over the range. Lower is better.",
    },
    {
      label: "Impressions (last 7d)",
      note: "Impressions in the last 7 days. Orange = best week of the tracking period.",
    },
    {
      label: "Impr change vs prior 7d",
      note: "Last 7 days minus the 7 days before. Green = grew, red = fell.",
    },
    {
      label: "Clicks (last 7d)",
      note: "Clicks in the last 7 days. Orange = best week of the tracking period.",
    },
    {
      label: "Clicks change vs prior 7d",
      note: "Last 7 days minus the 7 days before. Green = grew, red = fell.",
    },
    {
      label: "Position (last 7d)",
      note: "Impression-weighted average position over the last 7 days. Lower is better; orange = best week of the tracking period.",
    },
    {
      label: "Position change vs prior 7d (+ = moved up)",
      note: "Prior 7 days minus last 7 days, so positive = moved up the rankings. Green = improved, red = dropped.",
    },
  ];
}

function summaryValues(rows: SummaryRow[], rangeLabel: string): Cell[][] {
  const header: Cell[] = summaryHeaderCols(rangeLabel).map((c) => c.label);
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

// ---------- Tracked pages — Google, Bing & AI citations tab ----------

const TRACKED_TAB_TITLE = "Tracked pages — Google, Bing & AI";

interface TrackedPageStats {
  url: string;
  keyword: string;
  /** Page-level Search Console totals/movement across ALL queries. */
  gsc: SummaryRow;
  gscBest: RecordTriple;
  bingImpressions: number;
  bingClicks: number;
  bingPosition: number | null;
  bingLatestWeekImpressions: number;
  bingImprChange: number | null;
  bingLatestWeekClicks: number;
  bingClicksChange: number | null;
  bingLatestWeekPosition: number | null;
  bingPosChange: number | null;
  bingRecord: RecordTriple;
  aiCitations: number | null;
  aiCitationsChange: number | null;
  aiRecord: boolean;
}

interface TrackedPagesData {
  rows: TrackedPageStats[];
  bingSynced: boolean;
  latestUploadLabel: string | null;
  hasPriorUpload: boolean;
}

/**
 * Google (Search Console), Bing, and AI-citation stats for every tracked
 * page. Bing/AI come purely from rows the sync_bing_pages job / AI-report
 * uploads already stored; Google adds one free-quota GSC call per unique
 * tracked page (daily series across ALL queries — the keyword tabs filter to
 * the target keyword, this tab shows the whole page). No crawling, no paid
 * fetches, no AI calls.
 */
async function loadTrackedPagesData(
  siteId: number,
  siteHost: string,
  subs: Array<{ url: string; keyword: string | null }>,
  dates: string[],
  last7Start: string,
  prior7Start: string,
): Promise<TrackedPagesData> {
  const startDate = dates[0]!;
  const endDate = dates[dates.length - 1]!;
  const pages = subs
    .map((s) => ({
      url: s.url,
      keyword: (s.keyword ?? "").trim(),
      path: canonicalPath(s.url, siteHost),
    }))
    .filter(
      (p): p is { url: string; keyword: string; path: string } =>
        p.path != null,
    );
  const paths = Array.from(new Set(pages.map((p) => p.path)));

  const [anyBing, bingRows, bucketRows, uploads] = await Promise.all([
    db
      .select({ id: bingPageStatsTable.id })
      .from(bingPageStatsTable)
      .where(eq(bingPageStatsTable.siteId, siteId))
      .limit(1),
    paths.length > 0
      ? db
          .select()
          .from(bingPageStatsTable)
          .where(
            and(
              eq(bingPageStatsTable.siteId, siteId),
              inArray(bingPageStatsTable.path, paths),
              gte(bingPageStatsTable.bucketDate, startDate),
            ),
          )
      : Promise.resolve<BingPageStat[]>([]),
    // Every weekly bucket inside the range (ascending): the last two give
    // latest-vs-prior movement, the full list powers record (orange) flags.
    db
      .selectDistinct({ bucketDate: bingPageStatsTable.bucketDate })
      .from(bingPageStatsTable)
      .where(
        and(
          eq(bingPageStatsTable.siteId, siteId),
          gte(bingPageStatsTable.bucketDate, startDate),
        ),
      )
      .orderBy(bingPageStatsTable.bucketDate),
    // ALL "pages" uploads (newest first): [0]/[1] give latest-vs-prior, the
    // chronological series powers the AI-citation record flag.
    db
      .select()
      .from(aiCitationUploadsTable)
      .where(
        and(
          eq(aiCitationUploadsTable.siteId, siteId),
          eq(aiCitationUploadsTable.kind, "pages"),
        ),
      )
      .orderBy(desc(aiCitationUploadsTable.uploadedAt)),
  ]);

  // One page-level GSC daily series per unique tracked URL (no query filter).
  const uniqueUrls = Array.from(new Set(pages.map((p) => p.url)));
  const gscSeries = await mapWithConcurrency(uniqueUrls, 4, async (url) => {
    const rows = await queryGscDimension({
      siteId,
      startDate,
      endDate,
      dimension: "date",
      pageRegex: pageVariantsRegex(url),
      countryFilter: "usa",
      dataState: "all",
    });
    return { url, byDate: new Map(rows.map((r) => [r.key, r])) };
  });
  const gscByUrl = new Map(
    gscSeries.map((s) => {
      const summary = summarize(
        { keyword: "", url: s.url, byDate: s.byDate },
        dates,
        last7Start,
        prior7Start,
      );
      const best = bestWeekFlags(
        computeDaily(dates.map((d) => s.byDate.get(d))),
      );
      return [s.url, { summary, best }] as const;
    }),
  );

  const citationRows =
    uploads.length > 0 && paths.length > 0
      ? await db
          .select()
          .from(aiCitationRowsTable)
          .where(
            and(
              eq(aiCitationRowsTable.siteId, siteId),
              inArray(
                aiCitationRowsTable.uploadId,
                uploads.map((u) => u.id),
              ),
              inArray(aiCitationRowsTable.path, paths),
            ),
          )
      : [];

  const bingByPath = new Map<string, BingPageStat[]>();
  for (const r of bingRows) {
    const list = bingByPath.get(r.path);
    if (list) list.push(r);
    else bingByPath.set(r.path, [r]);
  }
  // Bing reports weekly buckets; "latest week" movement compares the two most
  // recent bucket dates inside the export range (both filtered gte startDate,
  // or a prior week outside the range would sum to 0 and fake a big change).
  const allBuckets = bucketRows.map((b) => b.bucketDate);
  const bucket0 = allBuckets.length > 0 ? allBuckets[allBuckets.length - 1]! : null;
  const bucket1 = allBuckets.length > 1 ? allBuckets[allBuckets.length - 2]! : null;

  const latestUploadId = uploads[0]?.id ?? null;
  const priorUploadId = uploads[1]?.id ?? null;
  const uploadsChrono = [...uploads].reverse(); // oldest -> newest
  const citationsFor = (uploadId: number | null, path: string): number => {
    if (uploadId == null) return 0;
    let sum = 0;
    for (const r of citationRows) {
      if (r.uploadId === uploadId && r.path === path) sum += r.citations;
    }
    return sum;
  };

  interface WeekAgg {
    clicks: number;
    impr: number;
    posSum: number;
    posW: number;
  }
  const weekPos = (b: WeekAgg | undefined): number | null =>
    b != null && b.posW > 0 ? b.posSum / b.posW : null;

  const rows = pages.map((p): TrackedPageStats => {
    const prows = bingByPath.get(p.path) ?? [];
    let clicks = 0;
    let impressions = 0;
    let posSum = 0;
    let posWeight = 0;
    const byBucket = new Map<string, WeekAgg>();
    for (const r of prows) {
      clicks += r.clicks;
      impressions += r.impressions;
      // Null positions (Bing "-1"/unknown) are excluded from the weighted
      // average — mapping them to 0 would fake a better rank.
      if (r.position != null && r.impressions > 0) {
        posSum += r.position * r.impressions;
        posWeight += r.impressions;
      }
      let agg = byBucket.get(r.bucketDate);
      if (!agg) {
        agg = { clicks: 0, impr: 0, posSum: 0, posW: 0 };
        byBucket.set(r.bucketDate, agg);
      }
      agg.clicks += r.clicks;
      agg.impr += r.impressions;
      if (r.position != null && r.impressions > 0) {
        agg.posSum += r.position * r.impressions;
        agg.posW += r.impressions;
      }
    }
    const latest = bucket0 != null ? byBucket.get(bucket0) : undefined;
    const prior = bucket1 != null ? byBucket.get(bucket1) : undefined;
    const latestPos = weekPos(latest);
    const priorPos = weekPos(prior);
    // Weekly series across every bucket in range (missing week = no traffic,
    // unknown position = skipped) -> strict-record flags for the orange
    // highlights, same rules the keyword tabs use for daily records.
    const wkImpr = allBuckets.map((b) => byBucket.get(b)?.impr ?? 0);
    const wkClicks = allBuckets.map((b) => byBucket.get(b)?.clicks ?? 0);
    const wkPos = allBuckets.map((b) => weekPos(byBucket.get(b)));
    const bingRecord: RecordTriple = {
      impr: newRecordFlags(wkImpr, "higher").at(-1) ?? false,
      clicks: newRecordFlags(wkClicks, "higher").at(-1) ?? false,
      pos: newRecordFlags(wkPos, "lower").at(-1) ?? false,
    };

    const latestCitations = citationsFor(latestUploadId, p.path);
    const priorCitations = citationsFor(priorUploadId, p.path);
    const aiSeries = uploadsChrono.map((u) => citationsFor(u.id, p.path));

    const gsc = gscByUrl.get(p.url) ?? {
      summary: summarize(
        { keyword: "", url: p.url, byDate: new Map() },
        dates,
        last7Start,
        prior7Start,
      ),
      best: { impr: false, clicks: false, pos: false } satisfies RecordTriple,
    };

    return {
      url: p.url,
      keyword: p.keyword,
      gsc: gsc.summary,
      gscBest: gsc.best,
      bingImpressions: impressions,
      bingClicks: clicks,
      bingPosition: posWeight > 0 ? posSum / posWeight : null,
      bingLatestWeekImpressions: latest?.impr ?? 0,
      bingImprChange:
        bucket1 != null ? (latest?.impr ?? 0) - (prior?.impr ?? 0) : null,
      bingLatestWeekClicks: latest?.clicks ?? 0,
      bingClicksChange:
        bucket1 != null ? (latest?.clicks ?? 0) - (prior?.clicks ?? 0) : null,
      bingLatestWeekPosition: latestPos,
      // Positive = moved up the rankings (position number went down).
      bingPosChange:
        latestPos != null && priorPos != null ? priorPos - latestPos : null,
      bingRecord,
      aiCitations: latestUploadId != null ? latestCitations : null,
      aiCitationsChange:
        priorUploadId != null ? latestCitations - priorCitations : null,
      aiRecord: newRecordFlags(aiSeries, "higher").at(-1) ?? false,
    };
  });
  rows.sort(
    (a, b) =>
      b.gsc.totalImpressions - a.gsc.totalImpressions ||
      b.bingClicks - a.bingClicks ||
      (b.aiCitations ?? 0) - (a.aiCitations ?? 0),
  );

  return {
    rows,
    bingSynced: anyBing.length > 0,
    latestUploadLabel: uploads[0]?.label ?? null,
    hasPriorUpload: uploads.length > 1,
  };
}

/** Headers + hover notes (tooltips) for the tracked-pages tab. */
function trackedHeaderCols(rangeLabel: string): HeaderCol[] {
  return [
    {
      label: "Page",
      note: "Tracked page from My Submissions. Rows are sorted by Google impressions over the range (ties: Bing clicks, then AI citations).",
    },
    {
      label: "Target keyword",
      note: "The keyword this page is tracked against on the Keyword summary tab. Blank = page is tracked without a target keyword.",
    },
    {
      label: `Google impressions (${rangeLabel})`,
      note: "Times this page appeared in US Google Search across ALL queries over the whole range (Search Console, United States filter). Range totals are context only — never color-coded.",
    },
    {
      label: `Google clicks (${rangeLabel})`,
      note: "Google clicks to this page across all queries over the whole range.",
    },
    {
      label: `Google avg position (${rangeLabel})`,
      note: "Impression-weighted average Google position over the range. Lower is better.",
    },
    {
      label: "Google impressions (last 7d)",
      note: "Google impressions in the last 7 days. Orange = best week of the tracking period.",
    },
    {
      label: "Impr change vs prior 7d",
      note: "Last 7 days minus the 7 days before. Green = grew, red = fell.",
    },
    {
      label: "Google clicks (last 7d)",
      note: "Google clicks in the last 7 days. Orange = best week of the tracking period.",
    },
    {
      label: "Clicks change vs prior 7d",
      note: "Last 7 days minus the 7 days before. Green = grew, red = fell.",
    },
    {
      label: "Google position (last 7d)",
      note: "Impression-weighted average position over the last 7 days. Lower is better; orange = best week of the tracking period.",
    },
    {
      label: "Position change vs prior 7d (+ = moved up)",
      note: "Prior 7 days minus last 7 days, so positive = moved up the rankings. Green = improved, red = dropped.",
    },
    {
      label: `Bing impressions (${rangeLabel})`,
      note: "Times this page appeared in Bing search over the whole range (Bing Webmaster weekly data). Range totals aren't color-coded.",
    },
    {
      label: `Bing clicks (${rangeLabel})`,
      note: "Bing clicks to this page over the whole range.",
    },
    {
      label: `Bing avg position (${rangeLabel})`,
      note: "Impression-weighted average Bing position over the range (weeks with unknown position excluded). Lower is better.",
    },
    {
      label: "Bing impressions (latest week)",
      note: "Impressions in Bing's most recent weekly bucket. Bing only reports the site's top pages each week, so 0 can simply mean the page fell out of that week's report. Orange = record week in the range.",
    },
    {
      label: "Impr change vs prior week",
      note: "Latest weekly bucket minus the one before. Green = grew, red = fell.",
    },
    {
      label: "Bing clicks (latest week)",
      note: "Clicks in Bing's most recent weekly bucket. Orange = record week in the range.",
    },
    {
      label: "Clicks change vs prior week",
      note: "Latest weekly bucket minus the one before. Green = grew, red = fell.",
    },
    {
      label: "Bing position (latest week)",
      note: "Impression-weighted average position in the latest weekly bucket. Lower is better; orange = best weekly position in the range.",
    },
    {
      label: "Position change vs prior week (+ = moved up)",
      note: "Prior week minus latest week, so positive = moved up the rankings. Green = improved, red = dropped.",
    },
    {
      label: "AI citations (latest report)",
      note: "How often Bing's AI (Copilot) cited this page in your latest uploaded AI Performance report. Orange = record high across all uploads. (Google doesn't expose AI Overviews / AI Mode data per page in its API yet.)",
    },
    {
      label: "Citations change vs prior report",
      note: "Latest report minus the previous upload. Green = cited more, red = cited less.",
    },
  ];
}

function trackedPagesValues(
  data: TrackedPagesData,
  rangeLabel: string,
): Cell[][] {
  const header: Cell[] = trackedHeaderCols(rangeLabel).map((c) => c.label);
  // Bing cells stay blank until the first Bing sync; null values (unknown
  // position, no prior week/report to compare) render blank, never 0.
  const bing = (v: Cell | null): Cell =>
    data.bingSynced && v != null ? v : "";
  const body = data.rows.map((r): Cell[] => [
    pagePath(r.url),
    r.keyword,
    r.gsc.totalImpressions,
    r.gsc.totalClicks,
    r.gsc.avgPosition == null ? "" : round1(r.gsc.avgPosition),
    r.gsc.last7Impressions,
    r.gsc.imprChange,
    r.gsc.last7Clicks,
    r.gsc.clicksChange,
    r.gsc.last7Position == null ? "" : round1(r.gsc.last7Position),
    r.gsc.positionChange == null ? "" : round1(r.gsc.positionChange),
    bing(r.bingImpressions),
    bing(r.bingClicks),
    bing(r.bingPosition == null ? null : round1(r.bingPosition)),
    bing(r.bingLatestWeekImpressions),
    bing(r.bingImprChange),
    bing(r.bingLatestWeekClicks),
    bing(r.bingClicksChange),
    bing(
      r.bingLatestWeekPosition == null
        ? null
        : round1(r.bingLatestWeekPosition),
    ),
    bing(r.bingPosChange == null ? null : round1(r.bingPosChange)),
    r.aiCitations == null ? "" : r.aiCitations,
    r.aiCitationsChange == null ? "" : r.aiCitationsChange,
  ]);
  return [header, ...body];
}

/** Color band (columns C..V) for every data row of the tracked-pages tab. */
function trackedPagesColorRows(data: TrackedPagesData): CellColor[][] {
  return data.rows.map((r) =>
    trackedRowColors({
      gscBest: r.gscBest,
      gscImprChange: r.gsc.imprChange,
      gscClicksChange: r.gsc.clicksChange,
      gscPosChange: r.gsc.positionChange,
      bingRecord: r.bingRecord,
      bingImprChange: r.bingImprChange,
      bingClicksChange: r.bingClicksChange,
      bingPosChange: r.bingPosChange,
      aiRecord: r.aiRecord,
      aiChange: r.aiCitationsChange,
    }),
  );
}

const TRACKED_LEGEND: Array<{ color: Exclude<CellColor, null>; text: string }> = [
  {
    color: "green",
    text: "Green = improved (Google: last 7 days vs the 7 before; Bing: latest weekly bucket vs the one before; AI: latest report vs the prior upload)",
  },
  { color: "red", text: "Red = declined over the same comparison" },
  {
    color: "orange",
    text: "Orange = best in this tracking period (record impressions/clicks/citations, or best position yet)",
  },
];

function trackedPagesNotes(data: TrackedPagesData): string[] {
  const notes: string[] = [
    "Google columns read Search Console for each page across ALL search queries, US traffic only (the Keyword summary tab filters to queries containing the target keyword, also US-only); includes fresh data — the most recent ~2 days can revise upward.",
  ];
  if (data.bingSynced) {
    notes.push(
      "Bing reports weekly totals; the 'latest week' columns compare Bing's two most recent weekly buckets.",
    );
  } else {
    notes.push(
      "Bing hasn't synced yet — connect Bing Webmaster in Settings to fill the Bing columns.",
    );
  }
  if (data.latestUploadLabel != null) {
    notes.push(
      `AI citations count how often Bing's AI (Copilot) cited each page — from your latest uploaded AI Performance report (${data.latestUploadLabel}).${
        data.hasPriorUpload ? "" : " Change columns fill in after your next upload."
      }`,
    );
  } else {
    notes.push(
      "No AI citation report uploaded yet — the AI columns fill in after you upload Bing's AI Performance export on the Bing page.",
    );
  }
  return notes;
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
  // allSettled so a second worker's rejection is never left unobserved
  // (an unhandled rejection crashes the whole process on Node 24).
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((s) => s.status === "rejected");
  if (failed && failed.status === "rejected") throw failed.reason;
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
  site: Pick<SiteContext, "id" | "displayName" | "host">,
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

  // With fresh data (dataState "all") GSC covers through yesterday Pacific
  // Time — the most recent ~2 days can still revise upward until finalized.
  // Compute "yesterday" in PT (not UTC) so the 06:00-UTC cron doesn't grab
  // the still-in-progress PT day.
  const ptToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date());
  const end = new Date(`${ptToday}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
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

  // Google + Bing + AI-citation stats for ALL tracked pages (keyword or
  // not), kicked off alongside the per-keyword GSC calls below.
  const trackedDataPromise = loadTrackedPagesData(
    siteId,
    site.host,
    subs,
    dates,
    last7Start,
    prior7Start,
  );
  // Observe the rejection now: if the per-keyword GSC calls below throw first
  // (e.g. GSC not connected), this function exits before the `await` at the
  // end and an unobserved rejection here would crash the whole process on
  // Node 24. The real error still propagates at the awaited use site.
  trackedDataPromise.catch(() => {});

  // One GSC call per keyword: daily series for page (incl. #fragment/?query
  // variants), US traffic only, queries CONTAINING the keyword as a phrase
  // (case-insensitive) — "best peec ai alternatives" counts toward "peec ai
  // alternatives". User directive 2026-07-30: US filter matches their GSC
  // view; exact-only matching was tried and rejected the same day because it
  // zeroed out keywords whose real traffic arrives via variants. Matches the
  // GSC UI with US country filter + "Queries containing" (not "Exact query").
  const series = await mapWithConcurrency(tracked, 4, async (t) => {
    const rows = await queryGscDimension({
      siteId,
      startDate,
      endDate,
      dimension: "date",
      pageRegex: pageVariantsRegex(t.url),
      queryFilter: {
        expression: keywordContainsRegex(t.keyword),
        operator: "includingRegex",
      },
      countryFilter: "usa",
      dataState: "all",
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
  const trackedData = await trackedDataPromise;
  const trackedNotes = trackedPagesNotes(trackedData);
  const trackedGrid = {
    rowCount:
      trackedData.rows.length +
      TRACKED_LEGEND.length +
      trackedNotes.length +
      6,
    columnCount: 22,
    frozenRowCount: 1,
    frozenColumnCount: 1,
  };

  // ---- Create the spreadsheet, or rewrite the stored one in place ----
  const storedId = await loadStoredSheetId(siteId);
  const existing = storedId ? await fetchExistingSheet(storedId) : null;

  let spreadsheetId: string;
  let spreadsheetUrl: string | undefined;
  let summarySheetId: number;
  let trackedSheetId: number;
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
    trackedSheetId = maxOldId + 2;
    keywordSheetIds = tabTitles.map((_, i) => maxOldId + 3 + i);

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
          {
            addSheet: {
              properties: {
                sheetId: trackedSheetId,
                title: TRACKED_TAB_TITLE,
                index: 1,
                gridProperties: trackedGrid,
              },
            },
          },
          ...tabTitles.map((tabTitle, i) => ({
            addSheet: {
              properties: {
                sheetId: keywordSheetIds[i]!,
                title: tabTitle,
                index: i + 2,
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
    trackedSheetId = 500;
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
          {
            properties: {
              sheetId: trackedSheetId,
              title: TRACKED_TAB_TITLE,
              gridProperties: trackedGrid,
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
        {
          range: `'${TRACKED_TAB_TITLE}'!A1`,
          values: trackedPagesValues(trackedData, rangeLabel),
        },
        ...sortedSeries.map((s, i) => ({
          range: `'${tabTitles[i]!.replace(/'/g, "''")}'!A1`,
          values: keywordTabValues(s, dates, sortedDaily[i]!),
        })),
      ],
    },
  });

  // Bold headers: summary header row + label column on each keyword tab.
  const summaryCols = summaryHeaderCols(rangeLabel);
  const trackedCols = trackedHeaderCols(rangeLabel);
  await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [
        // Hover notes (tooltips) on every header cell and keyword-tab label
        // cell. `fields: "note"` touches nothing else about the cells.
        {
          updateCells: {
            start: { sheetId: summarySheetId, rowIndex: 0, columnIndex: 0 },
            rows: [{ values: summaryCols.map((c) => ({ note: c.note })) }],
            fields: "note",
          },
        },
        {
          updateCells: {
            start: { sheetId: trackedSheetId, rowIndex: 0, columnIndex: 0 },
            rows: [{ values: trackedCols.map((c) => ({ note: c.note })) }],
            fields: "note",
          },
        },
        ...keywordSheetIds.map((sheetId) => ({
          updateCells: {
            start: { sheetId, rowIndex: 3, columnIndex: 0 },
            rows: KEYWORD_ROW_NOTES.map((note) => ({
              values: [{ note }],
            })),
            fields: "note",
          },
        })),
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
        {
          repeatCell: {
            range: { sheetId: trackedSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: trackedSheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: 22,
            },
          },
        },
        // Color coding — tracked-pages tab: columns C..V (Google last-7d,
        // Bing latest-week, AI citations + all their changes) per page row.
        ...(trackedData.rows.length > 0
          ? [
              {
                updateCells: {
                  start: {
                    sheetId: trackedSheetId,
                    rowIndex: 1,
                    columnIndex: 2,
                  },
                  rows: trackedPagesColorRows(trackedData).map((row) => ({
                    values: row.map(bgCell),
                  })),
                  fields: "userEnteredFormat.backgroundColor",
                },
              },
            ]
          : []),
        // Legend swatches under the tracked table (text written below,
        // after autoResize, so long legend lines don't stretch column A).
        {
          updateCells: {
            start: {
              sheetId: trackedSheetId,
              rowIndex: trackedData.rows.length + 2,
              columnIndex: 0,
            },
            rows: TRACKED_LEGEND.map((l) => ({ values: [bgCell(l.color)] })),
            fields: "userEnteredFormat.backgroundColor",
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

  // Tracked-pages legend text + footnotes — same pattern: written after
  // autoResize so the long explainer lines don't stretch the Page column.
  await sheetsRequest(
    `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      `'${TRACKED_TAB_TITLE}'!A${trackedData.rows.length + 3}`,
    )}?valueInputOption=RAW`,
    {
      method: "PUT",
      body: {
        values: [
          ...TRACKED_LEGEND.map((l) => [l.text]),
          ...trackedNotes.map((n) => [n]),
        ],
      },
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
