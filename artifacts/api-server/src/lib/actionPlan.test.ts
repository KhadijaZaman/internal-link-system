import { describe, it, expect } from "vitest";
import { buildActionPlan, type ActionPlanInput } from "./actionPlan";

const base: ActionPlanInput = {
  url: "https://wellows.com/blog/guide",
  keyword: "internal linking",
  days: 28,
  gsc: {
    overallTotals: { clicks: 50, impressions: 500, ctr: 0.1, position: 5 },
    keywordTotals: { clicks: 20, impressions: 200, ctr: 0.1, position: 5 },
    topQueries: [
      {
        query: "internal linking",
        clicks: 20,
        impressions: 200,
        ctr: 0.1,
        position: 5,
        isTracked: true,
      },
    ],
  },
  indexing: {
    verdict: "PASS",
    coverageState: "Submitted and indexed",
    robotsTxtState: "ALLOWED",
    pageFetchState: "SUCCESSFUL",
  },
  bing: { connected: true, clicks: 5, impressions: 100 },
  ga4: { sessions: 100, engagementRate: 0.6, keyEvents: 3, aiSessions: 2 },
  aiCitations: { hasUpload: true, citations: 1 },
  cannibalizedWith: [],
};

function ids(input: ActionPlanInput): string[] {
  return buildActionPlan(input).map((a) => a.id);
}

describe("buildActionPlan", () => {
  it("returns no actions for a healthy page", () => {
    expect(ids(base)).toEqual([]);
  });

  it("flags an indexing problem as do_first with coverage state in the why", () => {
    const plan = buildActionPlan({
      ...base,
      indexing: {
        verdict: "NEUTRAL",
        coverageState: "Discovered - currently not indexed",
        robotsTxtState: "ALLOWED",
        pageFetchState: "SUCCESSFUL",
      },
    });
    const action = plan.find((a) => a.id === "fix_indexing");
    expect(action).toBeDefined();
    expect(action!.priority).toBe("do_first");
    expect(action!.why).toContain("Discovered - currently not indexed");
  });

  it("adds robots and fetch steps only when those states are bad", () => {
    const plan = buildActionPlan({
      ...base,
      indexing: {
        verdict: "FAIL",
        coverageState: "Blocked by robots.txt",
        robotsTxtState: "DISALLOWED",
        pageFetchState: "SOFT_404",
      },
    });
    const action = plan.find((a) => a.id === "fix_indexing")!;
    expect(action.steps.some((s) => s.includes("robots.txt"))).toBe(true);
    expect(action.steps.some((s) => s.includes("SOFT_404"))).toBe(true);
  });

  it("flags striking distance using keyword scope and links to the link map", () => {
    const plan = buildActionPlan({
      ...base,
      gsc: {
        ...base.gsc!,
        keywordTotals: { clicks: 2, impressions: 150, ctr: 0.013, position: 13.4 },
      },
    });
    const action = plan.find((a) => a.id === "push_top10");
    expect(action).toBeDefined();
    expect(action!.priority).toBe("do_first");
    expect(action!.why).toContain("13.4");
    expect(action!.link).toContain("/link-map?url=");
  });

  it("does not flag striking distance below the impression floor", () => {
    const plan = buildActionPlan({
      ...base,
      gsc: {
        ...base.gsc!,
        keywordTotals: { clicks: 0, impressions: 5, ctr: 0, position: 15 },
      },
    });
    expect(plan.find((a) => a.id === "push_top10")).toBeUndefined();
  });

  it("falls back to overall totals when the keyword has no impressions", () => {
    const plan = buildActionPlan({
      ...base,
      keyword: null,
      gsc: {
        overallTotals: { clicks: 3, impressions: 400, ctr: 0.0075, position: 12 },
        keywordTotals: null,
        topQueries: [],
      },
    });
    const action = plan.find((a) => a.id === "push_top10");
    expect(action).toBeDefined();
    expect(action!.why).toContain("this page");
  });

  it("flags CTR underperformance with missed clicks in the why", () => {
    // Position 3 expects ~11% CTR; 1% on 1000 impressions is way under.
    const plan = buildActionPlan({
      ...base,
      gsc: {
        ...base.gsc!,
        keywordTotals: { clicks: 10, impressions: 1000, ctr: 0.01, position: 3 },
      },
    });
    const action = plan.find((a) => a.id === "rewrite_snippet");
    expect(action).toBeDefined();
    expect(action!.why).toMatch(/missed clicks/);
  });

  it("flags an invisible tracked keyword", () => {
    const plan = buildActionPlan({
      ...base,
      gsc: { ...base.gsc!, keywordTotals: null },
    });
    const action = plan.find((a) => a.id === "keyword_invisible");
    expect(action).toBeDefined();
    expect(action!.title).toContain("internal linking");
  });

  it("flags a keyword mismatch when the top query dwarfs the tracked keyword", () => {
    const plan = buildActionPlan({
      ...base,
      gsc: {
        overallTotals: { clicks: 50, impressions: 900, ctr: 0.055, position: 6 },
        keywordTotals: { clicks: 5, impressions: 100, ctr: 0.05, position: 8 },
        topQueries: [
          {
            query: "link building software",
            clicks: 30,
            impressions: 600,
            ctr: 0.05,
            position: 4,
            isTracked: false,
          },
          {
            query: "internal linking",
            clicks: 5,
            impressions: 100,
            ctr: 0.05,
            position: 8,
            isTracked: true,
          },
        ],
      },
    });
    const action = plan.find((a) => a.id === "align_content");
    expect(action).toBeDefined();
    expect(action!.why).toContain("link building software");
  });

  it("does not flag a mismatch when the tracked keyword is the top query", () => {
    const plan = buildActionPlan({
      ...base,
      gsc: {
        ...base.gsc!,
        topQueries: [
          {
            query: "internal linking",
            clicks: 20,
            impressions: 200,
            ctr: 0.1,
            position: 5,
            isTracked: true,
          },
          {
            query: "other query",
            clicks: 30,
            impressions: 600,
            ctr: 0.05,
            position: 4,
            isTracked: false,
          },
        ],
      },
    });
    expect(plan.find((a) => a.id === "align_content")).toBeUndefined();
  });

  it("flags cannibalization with the competing URLs named", () => {
    const plan = buildActionPlan({
      ...base,
      cannibalizedWith: ["/blog/other-guide", "/blog/third"],
    });
    const action = plan.find((a) => a.id === "consolidate_pages");
    expect(action).toBeDefined();
    expect(action!.why).toContain("/blog/other-guide");
  });

  it("flags weak engagement only above the session floor", () => {
    const weak = { sessions: 50, engagementRate: 0.2, keyEvents: 1, aiSessions: 0 };
    expect(ids({ ...base, ga4: weak })).toContain("improve_engagement");
    expect(
      ids({ ...base, ga4: { ...weak, sessions: 5 } }),
    ).not.toContain("improve_engagement");
  });

  it("flags zero conversions only with real traffic", () => {
    const plan = buildActionPlan({
      ...base,
      gsc: {
        ...base.gsc!,
        overallTotals: { clicks: 100, impressions: 2000, ctr: 0.05, position: 5 },
      },
      ga4: { sessions: 80, engagementRate: 0.6, keyEvents: 0, aiSessions: 0 },
    });
    expect(plan.map((a) => a.id)).toContain("add_cta");
  });

  it("flags AI-only visibility when Google sends zero clicks", () => {
    const plan = buildActionPlan({
      ...base,
      gsc: {
        overallTotals: { clicks: 0, impressions: 40, ctr: 0, position: 30 },
        keywordTotals: null,
        topQueries: [],
      },
      keyword: null,
      ga4: { sessions: 10, engagementRate: 0.5, keyEvents: 0, aiSessions: 8 },
      aiCitations: { hasUpload: true, citations: 4 },
    });
    const action = plan.find((a) => a.id === "ai_no_google");
    expect(action).toBeDefined();
    expect(action!.why).toContain("4 AI citations");
    expect(action!.why).toContain("8 visits");
  });

  it("flags the Bing gap only when Bing is connected and Google impressions are real", () => {
    const gapBase = {
      ...base,
      bing: { connected: true, clicks: 0, impressions: 0 },
    };
    expect(ids(gapBase)).toContain("bing_missing");
    expect(
      ids({ ...gapBase, bing: { connected: false, clicks: 0, impressions: 0 } }),
    ).not.toContain("bing_missing");
    expect(
      ids({
        ...gapBase,
        gsc: {
          ...base.gsc!,
          overallTotals: { clicks: 1, impressions: 50, ctr: 0.02, position: 9 },
        },
      }),
    ).not.toContain("bing_missing");
  });

  it("sorts actions do_first > next > later", () => {
    const plan = buildActionPlan({
      ...base,
      indexing: {
        verdict: "NEUTRAL",
        coverageState: "Crawled - currently not indexed",
        robotsTxtState: "ALLOWED",
        pageFetchState: "SUCCESSFUL",
      },
      ga4: { sessions: 50, engagementRate: 0.1, keyEvents: 0, aiSessions: 0 },
      bing: { connected: true, clicks: 0, impressions: 0 },
    });
    const priorities = plan.map((a) => a.priority);
    const order = { do_first: 0, next: 1, later: 2 } as const;
    const ranks = priorities.map((p) => order[p]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(priorities[0]).toBe("do_first");
  });

  it("handles all-null sections without throwing", () => {
    const plan = buildActionPlan({
      url: "https://wellows.com/x",
      keyword: null,
      days: 28,
      gsc: null,
      indexing: null,
      bing: null,
      ga4: null,
      aiCitations: null,
      cannibalizedWith: [],
    });
    expect(plan).toEqual([]);
  });
});
