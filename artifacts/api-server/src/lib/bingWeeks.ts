/**
 * Pure aggregation of stored Bing weekly buckets for a single canonical path.
 *
 * Bing's Webmaster API only reports weekly buckets over a rolling ~6-month
 * window, so the report shows week-by-week movement rather than daily rows.
 * Position may be null (Bing reports -1 for "unknown"); null-position rows
 * are excluded from the impression-weighted average — mapping null→0 would
 * dilute the average toward a falsely "better" rank.
 */

export interface BingWeekRowIn {
  bucketDate: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface BingWeekOut {
  weekStart: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface BingWeeksResult {
  weeks: BingWeekOut[];
  totals: { clicks: number; impressions: number; position: number | null };
  lastSyncDate: string | null;
}

function weightedPosition(
  entries: { position: number | null; impressions: number }[],
): number | null {
  const withPos = entries.filter((e) => e.position !== null);
  if (withPos.length === 0) return null;
  const weight = withPos.reduce((s, e) => s + e.impressions, 0);
  if (weight > 0) {
    const sum = withPos.reduce((s, e) => s + (e.position as number) * e.impressions, 0);
    return sum / weight;
  }
  // All impression counts are zero — fall back to a simple mean.
  const sum = withPos.reduce((s, e) => s + (e.position as number), 0);
  return sum / withPos.length;
}

export function aggregateBingWeeks(rows: BingWeekRowIn[]): BingWeeksResult {
  const byWeek = new Map<string, BingWeekRowIn[]>();
  for (const row of rows) {
    if (!row.bucketDate) continue;
    const list = byWeek.get(row.bucketDate);
    if (list) list.push(row);
    else byWeek.set(row.bucketDate, [row]);
  }

  const weeks: BingWeekOut[] = [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStart, entries]) => ({
      weekStart,
      clicks: entries.reduce((s, e) => s + e.clicks, 0),
      impressions: entries.reduce((s, e) => s + e.impressions, 0),
      position: weightedPosition(entries),
    }));

  const totals = {
    clicks: weeks.reduce((s, w) => s + w.clicks, 0),
    impressions: weeks.reduce((s, w) => s + w.impressions, 0),
    position: weightedPosition(weeks),
  };

  const lastSyncDate = weeks.length > 0 ? weeks[weeks.length - 1].weekStart : null;

  return { weeks, totals, lastSyncDate };
}
