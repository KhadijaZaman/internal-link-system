import { describe, it, expect } from "vitest";
import { aggregateBingWeeks } from "./bingWeeks";

describe("aggregateBingWeeks", () => {
  it("returns empty result for no rows", () => {
    expect(aggregateBingWeeks([])).toEqual({
      weeks: [],
      totals: { clicks: 0, impressions: 0, position: null },
      lastSyncDate: null,
    });
  });

  it("sorts weeks ascending and reports the newest week as lastSyncDate", () => {
    const res = aggregateBingWeeks([
      { bucketDate: "2026-07-13", clicks: 2, impressions: 20, position: 5 },
      { bucketDate: "2026-06-29", clicks: 1, impressions: 10, position: 8 },
      { bucketDate: "2026-07-06", clicks: 3, impressions: 30, position: 6 },
    ]);
    expect(res.weeks.map((w) => w.weekStart)).toEqual([
      "2026-06-29",
      "2026-07-06",
      "2026-07-13",
    ]);
    expect(res.lastSyncDate).toBe("2026-07-13");
  });

  it("merges duplicate buckets by summing clicks/impressions and weighting position", () => {
    const res = aggregateBingWeeks([
      { bucketDate: "2026-07-06", clicks: 1, impressions: 100, position: 10 },
      { bucketDate: "2026-07-06", clicks: 2, impressions: 300, position: 2 },
    ]);
    expect(res.weeks).toHaveLength(1);
    expect(res.weeks[0].clicks).toBe(3);
    expect(res.weeks[0].impressions).toBe(400);
    // (10*100 + 2*300) / 400 = 4
    expect(res.weeks[0].position).toBeCloseTo(4);
  });

  it("excludes null-position rows from the weighted average instead of treating them as 0", () => {
    const res = aggregateBingWeeks([
      { bucketDate: "2026-07-06", clicks: 0, impressions: 500, position: null },
      { bucketDate: "2026-07-06", clicks: 1, impressions: 100, position: 12 },
    ]);
    // A null→0 bug would drag this toward 2; the correct answer is 12.
    expect(res.weeks[0].position).toBeCloseTo(12);
    expect(res.weeks[0].impressions).toBe(600);
  });

  it("returns null position when no row in a bucket has a known position", () => {
    const res = aggregateBingWeeks([
      { bucketDate: "2026-07-06", clicks: 0, impressions: 50, position: null },
    ]);
    expect(res.weeks[0].position).toBeNull();
    expect(res.totals.position).toBeNull();
  });

  it("computes totals across weeks with null-safe weighting", () => {
    const res = aggregateBingWeeks([
      { bucketDate: "2026-06-29", clicks: 1, impressions: 100, position: 10 },
      { bucketDate: "2026-07-06", clicks: 2, impressions: 100, position: 20 },
      { bucketDate: "2026-07-13", clicks: 0, impressions: 800, position: null },
    ]);
    expect(res.totals.clicks).toBe(3);
    expect(res.totals.impressions).toBe(1000);
    // Null-position week excluded: (10*100 + 20*100) / 200 = 15
    expect(res.totals.position).toBeCloseTo(15);
  });

  it("falls back to a simple mean when all impression weights are zero", () => {
    const res = aggregateBingWeeks([
      { bucketDate: "2026-07-06", clicks: 0, impressions: 0, position: 4 },
      { bucketDate: "2026-07-06", clicks: 0, impressions: 0, position: 8 },
    ]);
    expect(res.weeks[0].position).toBeCloseTo(6);
  });
});
