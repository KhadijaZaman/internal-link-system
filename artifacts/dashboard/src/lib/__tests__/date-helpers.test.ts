import { describe, it, expect } from "vitest";
import { getUtcWindows, formatWindowDate } from "../date-helpers";

describe("date-helpers", () => {
  it("computes 12-week windows correctly with a 3-day lag", () => {
    // using a fixed reference date: Oct 31, 2024
    const windows = getUtcWindows(12, "2024-10-31T12:00:00Z");
    
    // currentEnd = Oct 28 (3 days lag)
    expect(windows.currentEnd).toBe("Oct 28, 2024");
    // 12 weeks = 84 days. start = Oct 28 - 83 days = Aug 6
    expect(windows.currentStart).toBe("Aug 6, 2024");
    // priorEnd = Aug 5
    expect(windows.priorEnd).toBe("Aug 5, 2024");
    // priorStart = Aug 5 - 83 = May 14
    expect(windows.priorStart).toBe("May 14, 2024");
  });

  it("computes 4-week windows correctly", () => {
    const windows = getUtcWindows(4, "2024-10-31T12:00:00Z");
    expect(windows.currentEnd).toBe("Oct 28, 2024");
    expect(windows.currentStart).toBe("Oct 1, 2024"); // 28 days back
    expect(windows.priorEnd).toBe("Sep 30, 2024");
    expect(windows.priorStart).toBe("Sep 3, 2024");
  });

  it("formats window date string safely", () => {
    expect(formatWindowDate("2024-10-01")).toBe("Oct 1, 2024");
    expect(formatWindowDate("")).toBe("");
  });
});
