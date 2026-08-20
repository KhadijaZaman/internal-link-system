import { describe, expect, it } from "vitest";
import {
  buildRoadmapColumnPlan,
  CENTRAL_PAGE_PATH,
  classifyRoadmapPage,
  inferCitationWindow,
  scoreRoadmapOpportunity,
  type RoadmapMetrics,
  type RoadmapSourceFreshness,
} from "./optimizationRoadmap";

const freshness: RoadmapSourceFreshness[] = [
  {
    source: "GSC",
    state: "fresh",
    windowStart: "2026-07-19",
    windowEnd: "2026-08-17",
    observedAt: "2026-08-20T10:00:00.000Z",
    detail: "fresh",
  },
  {
    source: "GA4",
    state: "missing",
    windowStart: "2026-07-21",
    windowEnd: "2026-08-19",
    observedAt: null,
    detail: "not connected",
  },
  {
    source: "Bing",
    state: "stale",
    windowStart: "2026-07-16",
    windowEnd: "2026-08-14",
    observedAt: "2026-08-15T04:00:00.000Z",
    detail: "old sync",
  },
  {
    source: "AI citations",
    state: "missing",
    windowStart: null,
    windowEnd: null,
    observedAt: null,
    detail: "no upload",
  },
  {
    source: "Content links",
    state: "fresh",
    windowStart: null,
    windowEnd: null,
    observedAt: "2026-08-18T02:00:00.000Z",
    detail: "content edges",
  },
];

function metric(overrides: Partial<RoadmapMetrics> = {}): RoadmapMetrics {
  return {
    path: "/blog/example",
    url: "https://wellows.com/blog/example",
    title: "Example",
    gscImpressions: 1_000,
    gscClicks: 5,
    gscCtr: 0.005,
    gscPosition: 8,
    gscTopQuery: "example query",
    ga4Sessions: 50,
    ga4EngagementRate: 0.25,
    ga4AvgEngagementTime: 20,
    ga4KeyEvents: 0,
    ga4AiSessions: 0,
    bingImpressions: 100,
    bingClicks: 1,
    bingPosition: 12,
    aiCitations: 2,
    aiPromptInstances: 4,
    contentInboundLinks: 2,
    contentOutboundLinks: 5,
    ...overrides,
  };
}

describe("optimization roadmap refresh planning", () => {
  it("preserves row order and reviewed classification cells", () => {
    const headers = [
      "Path",
      "Manual Review",
      "Topic Cluster",
      "AI Visibility Role",
      "Opportunity Score",
    ];
    const rows = [
      ["/blog/second", "Approved", "Reviewed cluster", "Supporting page", 12],
      ["/blog/first", "Keep me", "", "", 9],
    ];
    const metricsByPath = new Map([
      ["/blog/first", metric({ path: "/blog/first" })],
      ["/blog/second", metric({ path: "/blog/second" })],
    ]);

    const plan = buildRoadmapColumnPlan({
      headers,
      rows,
      metricsByPath,
      refreshedAt: "2026-08-20T10:00:00.000Z",
      freshness,
    });

    const topicColumn = plan.columns.find((column) => column.header === "Topic Cluster");
    const roleColumn = plan.columns.find(
      (column) => column.header === "AI Visibility Role",
    );
    const scoreColumn = plan.columns.find(
      (column) => column.header === "Opportunity Score",
    );

    expect(topicColumn?.values[0]).toBe("Reviewed cluster");
    expect(roleColumn?.values[0]).toBe("Supporting page");
    expect(topicColumn?.values[1]).not.toBe("");
    expect(roleColumn?.values[1]).not.toBe("");
    expect(scoreColumn?.values).toEqual([
      scoreRoadmapOpportunity(metric({ path: "/blog/second" }), "Supporting page").score,
      scoreRoadmapOpportunity(metric({ path: "/blog/first" }), "Outside core cluster")
        .score,
    ]);
    expect(plan.columns.some((column) => column.header === "Manual Review")).toBe(false);
  });

  it("labels unavailable and stale sources instead of writing fresh zeroes", () => {
    const missing = metric({
      ga4Sessions: null,
      ga4EngagementRate: null,
      ga4AvgEngagementTime: null,
      ga4KeyEvents: null,
      ga4AiSessions: null,
      aiCitations: null,
      aiPromptInstances: null,
    });
    const plan = buildRoadmapColumnPlan({
      headers: ["Path", "Opportunity Score"],
      rows: [["/blog/example", 1]],
      metricsByPath: new Map([[missing.path, missing]]),
      refreshedAt: "2026-08-20T10:00:00.000Z",
      freshness,
    });

    expect(
      plan.columns.find((column) => column.header === "GA4 Sessions (30d)")?.values,
    ).toEqual([""]);
    expect(
      plan.columns.find((column) => column.header === "GA4 Data Through")?.values,
    ).toEqual(["2026-08-19 (missing)"]);
    expect(
      plan.columns.find((column) => column.header === "Bing Data Through")?.values,
    ).toEqual(["2026-08-14 (stale)"]);
    expect(
      plan.columns.find((column) => column.header === "Citation Data As Of")
        ?.values[0],
    ).toContain("missing");
  });

  it("uses only the supplied content-link support signal in scoring", () => {
    const weakContentSupport = scoreRoadmapOpportunity(
      metric({ contentInboundLinks: 1 }),
      "Supporting page",
    );
    const strongContentSupport = scoreRoadmapOpportunity(
      metric({ contentInboundLinks: 25 }),
      "Supporting page",
    );

    expect(weakContentSupport.score).toBeGreaterThan(strongContentSupport.score);
    expect(weakContentSupport.reason).toContain("Content-only internal-link support");
  });

  it("never calls topical relevance alone low-hanging fruit", () => {
    const noEvidence = metric({
      gscImpressions: 0,
      gscClicks: 0,
      gscCtr: 0,
      gscPosition: null,
      ga4Sessions: 0,
      ga4EngagementRate: 0,
      bingImpressions: 0,
      bingClicks: 0,
      bingPosition: null,
      aiCitations: 0,
      aiPromptInstances: 0,
      contentInboundLinks: null,
      contentOutboundLinks: null,
    });
    const result = scoreRoadmapOpportunity(noEvidence, "Central page");

    expect(result.lowHangingFruit).toBe(false);
    expect(result.reason).toContain("No current performance evidence");
  });

  it("keeps the AI Search Visibility central-page convention stable", () => {
    expect(classifyRoadmapPage({ path: CENTRAL_PAGE_PATH })).toEqual({
      topicCluster: "AI Search Visibility",
      clusterRole: "Central page",
    });
    expect(
      classifyRoadmapPage({
        path: "/blog/ai-search-visibility-for-healthcare-brands",
      }),
    ).toEqual({
      topicCluster: "Industry AI Visibility",
      clusterRole: "Supporting page",
    });
  });

  it("only treats a citation upload as 30-day when the label proves it", () => {
    expect(inferCitationWindow("wellows explicit citations 30d")).toEqual({
      isThirtyDay: true,
      windowStart: null,
      windowEnd: null,
    });
    expect(
      inferCitationWindow("citations 2026-07-20 to 2026-08-18"),
    ).toEqual({
      isThirtyDay: true,
      windowStart: "2026-07-20",
      windowEnd: "2026-08-18",
    });
    expect(inferCitationWindow("latest citations export")).toEqual({
      isThirtyDay: false,
      windowStart: null,
      windowEnd: null,
    });
  });
});
