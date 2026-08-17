/**
 * Pure helpers for get_trend_data granularity resolution.
 * Extracted here so they can be unit-tested without mocking the whole route.
 */

export type DailyRow = {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type TrendPoint = { date: string; clicks: number; impressions: number };

/**
 * Aggregate daily GSC rows into ISO-week buckets (YYYY-Www).
 * Uses ISO-8601 week numbering: week 1 contains Jan 4.
 */
export function toWeeklyPoints(rows: DailyRow[]): TrendPoint[] {
  const byWeek: Record<string, { clicks: number; impressions: number }> = {};
  for (const row of rows) {
    const d = new Date(`${row.key}T00:00:00Z`);
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const startOfWeek = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000);
    const weekNum = Math.ceil(((d.getTime() - startOfWeek.getTime()) / 86_400_000 + 1) / 7);
    const label = `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    if (!byWeek[label]) byWeek[label] = { clicks: 0, impressions: 0 };
    byWeek[label]!.clicks += row.clicks;
    byWeek[label]!.impressions += row.impressions;
  }
  return Object.entries(byWeek)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));
}

export type TrendGranularityResult = {
  points: TrendPoint[];
  effectiveGranularity: "daily" | "weekly";
  /** Present only when a weekly request was auto-downgraded to daily. */
  notice?: string;
};

/**
 * Resolve the final set of trend points and effective granularity.
 *
 * When `granularity === "weekly"` but the date range produces fewer than 3
 * weekly buckets (not enough to show momentum), this automatically falls back
 * to daily granularity and sets a `notice` explaining the downgrade.
 */
export function resolveTrendPoints(
  dateRows: DailyRow[],
  granularity: "daily" | "weekly",
  startDate: string,
  endDate: string,
): TrendGranularityResult {
  const dailyPoints = dateRows
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => ({ date: r.key, clicks: r.clicks, impressions: r.impressions }));

  if (granularity !== "weekly") {
    return { points: dailyPoints, effectiveGranularity: "daily" };
  }

  const weeklyPoints = toWeeklyPoints(dateRows);

  // Fewer than 3 weekly buckets cannot show momentum — auto-downgrade.
  if (weeklyPoints.length < 3) {
    const bucketWord = weeklyPoints.length === 1 ? "bucket" : "buckets";
    return {
      points: dailyPoints,
      effectiveGranularity: "daily",
      notice:
        `Weekly granularity was requested but the date range (${startDate} to ${endDate}) ` +
        `produced only ${weeklyPoints.length} weekly ${bucketWord} — ` +
        `not enough to show momentum. Switched to daily granularity. ` +
        `Treat this as a snapshot, not a trend.`,
    };
  }

  return { points: weeklyPoints, effectiveGranularity: "weekly" };
}
