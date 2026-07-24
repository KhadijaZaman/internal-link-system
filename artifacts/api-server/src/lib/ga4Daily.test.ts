import { describe, it, expect } from "vitest";
import {
  ga4DateToIso,
  buildGa4DailySeries,
  ga4DayPoint,
  aggregateGa4Days,
} from "./ga4Daily";

const HOST = "wellows.com";

describe("ga4DateToIso", () => {
  it("converts GA4 dates to ISO", () => {
    expect(ga4DateToIso("20260722")).toBe("2026-07-22");
  });
  it("rejects malformed dates", () => {
    expect(ga4DateToIso("(other)")).toBeNull();
    expect(ga4DateToIso("2026-07-22")).toBeNull();
    expect(ga4DateToIso("")).toBeNull();
  });
});

describe("buildGa4DailySeries", () => {
  const baseRow = {
    landingPage: "/blog/guide",
    channelGroup: "Organic Search",
    source: "google",
    sessions: 10,
    engagedSessions: 6,
    engagementDuration: 300,
  };

  it("aggregates engagement rows per day, sorted ascending", () => {
    const series = buildGa4DailySeries({
      engagementRows: [
        { ...baseRow, date: "20260702" },
        { ...baseRow, date: "20260701" },
        { ...baseRow, date: "20260701", channelGroup: "Direct", source: "(direct)" },
      ],
      keyEventRows: [],
      path: "/blog/guide",
      siteHost: HOST,
    });
    expect(series.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(series[0].sessions).toBe(20);
    expect(series[0].engagedSessions).toBe(12);
    expect(series[1].sessions).toBe(10);
  });

  it("drops rows whose canonical path differs (BEGINS_WITH over-match)", () => {
    const series = buildGa4DailySeries({
      engagementRows: [
        { ...baseRow, date: "20260701" },
        { ...baseRow, date: "20260701", landingPage: "/blog/guide-part-2" },
      ],
      keyEventRows: [],
      path: "/blog/guide",
      siteHost: HOST,
    });
    expect(series).toHaveLength(1);
    expect(series[0].sessions).toBe(10);
  });

  it("matches landing pages with query strings via canonical path", () => {
    const series = buildGa4DailySeries({
      engagementRows: [
        { ...baseRow, date: "20260701", landingPage: "/blog/guide?utm_source=x" },
      ],
      keyEventRows: [],
      path: "/blog/guide",
      siteHost: HOST,
    });
    expect(series).toHaveLength(1);
    expect(series[0].sessions).toBe(10);
  });

  it("counts AI sessions by channel group or source regex", () => {
    const series = buildGa4DailySeries({
      engagementRows: [
        { ...baseRow, date: "20260701", channelGroup: "AI Assistant", source: "something" },
        { ...baseRow, date: "20260701", channelGroup: "Referral", source: "chatgpt.com" },
        { ...baseRow, date: "20260701", channelGroup: "Referral", source: "example.com" },
      ],
      keyEventRows: [],
      path: "/blog/guide",
      siteHost: HOST,
    });
    expect(series[0].aiSessions).toBe(20);
    expect(series[0].sessions).toBe(30);
  });

  it("joins key events by canonical path even when engagement has no row that day", () => {
    const series = buildGa4DailySeries({
      engagementRows: [{ ...baseRow, date: "20260701" }],
      keyEventRows: [
        { date: "20260701", landingPage: "/blog/guide?ref=a", keyEvents: 2 },
        { date: "20260702", landingPage: "/blog/guide", keyEvents: 1 },
        { date: "20260702", landingPage: "/other", keyEvents: 5 },
      ],
      path: "/blog/guide",
      siteHost: HOST,
    });
    expect(series).toHaveLength(2);
    expect(series[0].keyEvents).toBe(2);
    expect(series[1].keyEvents).toBe(1);
    expect(series[1].sessions).toBe(0);
  });
});

describe("ga4DayPoint / aggregateGa4Days", () => {
  it("derives rates safely including zero-session days", () => {
    const point = ga4DayPoint({
      date: "2026-07-01",
      sessions: 0,
      engagedSessions: 0,
      engagementDuration: 0,
      keyEvents: 1,
      aiSessions: 0,
    });
    expect(point.engagementRate).toBe(0);
    expect(point.avgEngagementTime).toBe(0);
  });

  it("aggregates totals with weighted rates", () => {
    const totals = aggregateGa4Days([
      {
        date: "2026-07-01",
        sessions: 10,
        engagedSessions: 5,
        engagementDuration: 100,
        keyEvents: 1,
        aiSessions: 2,
      },
      {
        date: "2026-07-02",
        sessions: 30,
        engagedSessions: 25,
        engagementDuration: 500,
        keyEvents: 0,
        aiSessions: 0,
      },
    ]);
    expect(totals.sessions).toBe(40);
    expect(totals.engagementRate).toBeCloseTo(30 / 40);
    expect(totals.avgEngagementTime).toBeCloseTo(600 / 40);
    expect(totals.keyEvents).toBe(1);
    expect(totals.aiSessions).toBe(2);
  });
});
