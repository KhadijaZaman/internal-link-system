import { describe, it, expect } from "vitest";
import { toWeeklyPoints, resolveTrendPoints, type DailyRow } from "./gscChatTrend";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a synthetic daily-row sequence covering `n` consecutive days from `startDate`. */
function makeDailyRows(startDate: string, n: number): DailyRow[] {
  const rows: DailyRow[] = [];
  const base = new Date(`${startDate}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const d = new Date(base.getTime() + i * 86_400_000);
    rows.push({
      key: d.toISOString().slice(0, 10),
      clicks: 10 + i,
      impressions: 100 + i,
      ctr: 0.1,
      position: 5,
    });
  }
  return rows;
}

// ─── toWeeklyPoints ───────────────────────────────────────────────────────────

describe("toWeeklyPoints", () => {
  it("returns an empty array for empty input", () => {
    expect(toWeeklyPoints([])).toEqual([]);
  });

  it("assigns all days of the same ISO week to one bucket", () => {
    // 2026-07-06 (Mon) through 2026-07-12 (Sun) = ISO week 2026-W28
    const rows = makeDailyRows("2026-07-06", 7);
    const points = toWeeklyPoints(rows);
    expect(points).toHaveLength(1);
    expect(points[0]!.date).toBe("2026-W28");
  });

  it("splits days across two adjacent calendar weeks into two buckets", () => {
    // 5 days ending on a Sunday + 2 days in the next week
    const rows = makeDailyRows("2026-07-09", 7); // Thu 09 Jul → Wed 15 Jul → spans W28 & W29
    const points = toWeeklyPoints(rows);
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points[0]!.date).toBe("2026-W28");
    expect(points[1]!.date).toBe("2026-W29");
  });

  it("returns buckets sorted in ascending week order", () => {
    const rows = makeDailyRows("2026-07-01", 28);
    const points = toWeeklyPoints(rows);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.date > points[i - 1]!.date).toBe(true);
    }
  });

  it("sums clicks and impressions within a week correctly", () => {
    // Single week: 2026-07-06 (Mon) – 2026-07-12 (Sun)
    const rows = makeDailyRows("2026-07-06", 7);
    const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
    const totalImpressions = rows.reduce((s, r) => s + r.impressions, 0);
    const points = toWeeklyPoints(rows);
    expect(points[0]!.clicks).toBe(totalClicks);
    expect(points[0]!.impressions).toBe(totalImpressions);
  });
});

// ─── resolveTrendPoints — short window (≤14 days) ────────────────────────────

describe("resolveTrendPoints — short date ranges (≤14 days)", () => {
  it("returns granularity=daily and a notice when weekly is requested over 7 days", () => {
    const rows = makeDailyRows("2026-07-06", 7); // one ISO week → 1 bucket
    const result = resolveTrendPoints(rows, "weekly", "2026-07-06", "2026-07-12");

    expect(result.effectiveGranularity).toBe("daily");
    expect(result.notice).toBeDefined();
    expect(result.notice).toContain("Switched to daily granularity");
    expect(result.notice).toContain("2026-07-06 to 2026-07-12");
  });

  it("returns granularity=daily and a notice when weekly is requested over 14 days", () => {
    // 14 days starting on a Monday spans exactly 2 ISO weeks → 2 buckets < 3
    const rows = makeDailyRows("2026-07-06", 14);
    const result = resolveTrendPoints(rows, "weekly", "2026-07-06", "2026-07-19");

    expect(result.effectiveGranularity).toBe("daily");
    expect(result.notice).toBeDefined();
    expect(result.notice).toContain("Switched to daily granularity");
  });

  it("notice mentions the actual number of weekly buckets produced", () => {
    const rows = makeDailyRows("2026-07-06", 7); // 1 bucket
    const result = resolveTrendPoints(rows, "weekly", "2026-07-06", "2026-07-12");

    expect(result.notice).toContain("1 weekly bucket");
  });

  it("notice uses 'buckets' (plural) when 2 buckets are produced", () => {
    const rows = makeDailyRows("2026-07-06", 14); // 2 buckets
    const result = resolveTrendPoints(rows, "weekly", "2026-07-06", "2026-07-19");

    expect(result.notice).toContain("2 weekly buckets");
  });

  it("falls back to daily even for a single-day range", () => {
    const rows = makeDailyRows("2026-07-15", 1);
    const result = resolveTrendPoints(rows, "weekly", "2026-07-15", "2026-07-15");

    expect(result.effectiveGranularity).toBe("daily");
    expect(result.notice).toBeDefined();
  });

  it("points returned on downgrade are sorted daily dates", () => {
    const rows = makeDailyRows("2026-07-10", 5);
    const result = resolveTrendPoints(rows, "weekly", "2026-07-10", "2026-07-14");

    const dates = result.points.map((p) => p.date);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]).toBe("2026-07-10");
    expect(dates[dates.length - 1]).toBe("2026-07-14");
  });
});

// ─── resolveTrendPoints — long window (≥21 days) ─────────────────────────────

describe("resolveTrendPoints — long date ranges (≥21 days)", () => {
  it("returns granularity=weekly with no notice when weekly is requested over 21 days", () => {
    // 21 days starting Mon 2026-07-06 spans 3 full ISO weeks → 3 buckets
    const rows = makeDailyRows("2026-07-06", 21);
    const result = resolveTrendPoints(rows, "weekly", "2026-07-06", "2026-07-26");

    expect(result.effectiveGranularity).toBe("weekly");
    expect(result.notice).toBeUndefined();
  });

  it("returns weekly buckets (not daily rows) when no downgrade occurs", () => {
    const rows = makeDailyRows("2026-07-06", 28); // 4 ISO weeks
    const result = resolveTrendPoints(rows, "weekly", "2026-07-06", "2026-08-02");

    // Weekly buckets are labelled YYYY-Www, not YYYY-MM-DD
    expect(result.points.every((p) => /^\d{4}-W\d{2}$/.test(p.date))).toBe(true);
    expect(result.points.length).toBeGreaterThanOrEqual(4);
  });

  it("returns no notice for a 28-day window", () => {
    const rows = makeDailyRows("2026-07-06", 28);
    const result = resolveTrendPoints(rows, "weekly", "2026-07-06", "2026-08-02");

    expect(result.notice).toBeUndefined();
  });

  it("returns no notice for a 90-day window", () => {
    const rows = makeDailyRows("2026-05-01", 90);
    const result = resolveTrendPoints(rows, "weekly", "2026-05-01", "2026-07-29");

    expect(result.effectiveGranularity).toBe("weekly");
    expect(result.notice).toBeUndefined();
  });
});

// ─── resolveTrendPoints — daily granularity passthrough ───────────────────────

describe("resolveTrendPoints — daily granularity (no aggregation)", () => {
  it("passes daily rows through unchanged regardless of range length", () => {
    const rows = makeDailyRows("2026-07-06", 7);
    const result = resolveTrendPoints(rows, "daily", "2026-07-06", "2026-07-12");

    expect(result.effectiveGranularity).toBe("daily");
    expect(result.notice).toBeUndefined();
    expect(result.points).toHaveLength(7);
    expect(result.points.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))).toBe(true);
  });

  it("sorts daily rows ascending even if input is unordered", () => {
    const rows = makeDailyRows("2026-07-06", 5).reverse();
    const result = resolveTrendPoints(rows, "daily", "2026-07-06", "2026-07-10");

    const dates = result.points.map((p) => p.date);
    expect(dates).toEqual([...dates].sort());
  });
});
