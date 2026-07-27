import { describe, it, expect } from "vitest";
import {
  computeDaily,
  changeColor,
  newRecordFlags,
  keywordTabColorMatrix,
  bestWeekFlags,
  trackedRowColors,
  type DailyMetricRow,
} from "./keywordMovementColors";

const day = (
  impressions: number,
  clicks = 0,
  position = 0,
): DailyMetricRow => ({ impressions, clicks, position });

describe("computeDaily", () => {
  it("computes day-over-day changes and treats missing days as zero", () => {
    const d = computeDaily([day(10, 1, 5), undefined, day(20, 3, 4.25)]);
    expect(d.impr).toEqual([10, 0, 20]);
    expect(d.imprChange).toEqual([null, -10, 20]);
    expect(d.clicks).toEqual([1, 0, 3]);
    expect(d.clicksChange).toEqual([null, -1, 3]);
    expect(d.pos).toEqual([5, null, 4.3]);
  });

  it("carries the last known position across no-data days for the change", () => {
    const d = computeDaily([day(10, 0, 8), day(0), day(5, 0, 6)]);
    expect(d.pos).toEqual([8, null, 6]);
    // change compares 6 against the last known 8, not against null
    expect(d.posChange).toEqual([null, null, 2]);
  });
});

describe("changeColor", () => {
  it("maps positive to green, negative to red, zero/null to none", () => {
    expect(changeColor(3)).toBe("green");
    expect(changeColor(-1)).toBe("red");
    expect(changeColor(0)).toBeNull();
    expect(changeColor(null)).toBeNull();
  });
});

describe("newRecordFlags", () => {
  it("flags only strict new highs, first value is baseline", () => {
    expect(newRecordFlags([5, 3, 5, 8, 8, 9], "higher")).toEqual([
      false,
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  it("never flags zeros as a high and flags first positive after zeros", () => {
    expect(newRecordFlags([0, 0, 0, 2], "higher")).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(newRecordFlags([0, 0], "higher")).toEqual([false, false]);
  });

  it("for lower-is-better, skips nulls and flags strict new bests", () => {
    expect(newRecordFlags([9, null, 7.5, 8, 7.5, 7], "lower")).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
  });
});

describe("keywordTabColorMatrix", () => {
  it("produces 6 rows aligned to the day count", () => {
    const d = computeDaily([day(10, 0, 9), day(20, 1, 7)]);
    const m = keywordTabColorMatrix(d);
    expect(m).toHaveLength(6);
    for (const row of m) expect(row).toHaveLength(2);
    // day 2: impressions record + positive change, clicks record, position record
    expect(m[0]).toEqual([null, "orange"]);
    expect(m[1]).toEqual([null, "green"]);
    expect(m[2]).toEqual([null, "orange"]);
    expect(m[4]).toEqual([null, "orange"]);
  });
});

describe("bestWeekFlags", () => {
  it("is all false when there is no earlier full window", () => {
    const d = computeDaily(Array.from({ length: 7 }, () => day(10)));
    expect(bestWeekFlags(d)).toEqual({ impr: false, clicks: false, pos: false });
  });

  it("flags a steadily climbing final week as record impressions", () => {
    // 14 days: first week flat 10/day, second week 20/day
    const rows = [
      ...Array.from({ length: 7 }, () => day(10, 0, 20)),
      ...Array.from({ length: 7 }, () => day(20, 1, 5)),
    ];
    const f = bestWeekFlags(computeDaily(rows));
    expect(f.impr).toBe(true);
    expect(f.clicks).toBe(true);
    expect(f.pos).toBe(true);
  });

  it("does not flag a final week merely equal to the best earlier week", () => {
    const rows = Array.from({ length: 21 }, () => day(10, 0, 5));
    const f = bestWeekFlags(computeDaily(rows));
    expect(f).toEqual({ impr: false, clicks: false, pos: false });
  });

  it("does not flag position when an earlier window was as good", () => {
    const rows = [
      ...Array.from({ length: 7 }, () => day(10, 0, 3)),
      ...Array.from({ length: 7 }, () => day(50, 0, 4)),
    ];
    const f = bestWeekFlags(computeDaily(rows));
    expect(f.pos).toBe(false);
    expect(f.impr).toBe(true);
  });
});

describe("trackedRowColors", () => {
  it("colors record value cells orange, change cells green/red, totals never", () => {
    const colors = trackedRowColors({
      gscBest: { impr: true, clicks: false, pos: false },
      gscImprChange: 12,
      gscClicksChange: -3,
      gscPosChange: 0,
      bingRecord: { impr: false, clicks: true, pos: false },
      bingImprChange: null,
      bingClicksChange: 4,
      bingPosChange: -0.5,
      aiRecord: true,
      aiChange: null,
    });
    expect(colors).toHaveLength(20);
    // Range-total cells (Google C..E, Bing L..N) are never colored.
    expect(colors.slice(0, 3)).toEqual([null, null, null]);
    expect(colors.slice(9, 12)).toEqual([null, null, null]);
    expect(colors[3]).toBe("orange"); // Google last-7d impressions record
    expect(colors[4]).toBe("green"); // impressions up
    expect(colors[6]).toBe("red"); // clicks down
    expect(colors[8]).toBeNull(); // unchanged position -> no color
    expect(colors[13]).toBeNull(); // no prior week -> no color
    expect(colors[14]).toBe("orange"); // Bing latest-week clicks record
    expect(colors[15]).toBe("green");
    expect(colors[17]).toBe("red"); // position change negative = declined
    expect(colors[18]).toBe("orange"); // AI citations record
    expect(colors[19]).toBeNull(); // no prior report
  });

  it("is all-null when nothing moved and nothing set a record", () => {
    const none = { impr: false, clicks: false, pos: false };
    const colors = trackedRowColors({
      gscBest: none,
      gscImprChange: 0,
      gscClicksChange: null,
      gscPosChange: null,
      bingRecord: none,
      bingImprChange: null,
      bingClicksChange: 0,
      bingPosChange: null,
      aiRecord: false,
      aiChange: 0,
    });
    expect(colors).toEqual(Array.from({ length: 20 }, () => null));
  });
});
