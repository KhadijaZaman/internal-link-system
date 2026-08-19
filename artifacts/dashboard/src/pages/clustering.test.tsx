// @ts-nocheck
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import Clustering, { ExpandedClusterDetail } from "./clustering";
import { KeywordCluster, KeywordState, ClusterRun } from "@workspace/api-client-react";
import { TooltipProvider } from "@/components/ui/tooltip";

const { mockStartMutation, mockInvalidateQueries, mockListClusterRuns } = vi.hoisted(() => ({
  mockStartMutation: vi.fn(),
  mockInvalidateQueries: vi.fn(),
  mockListClusterRuns: vi.fn().mockReturnValue({ data: [] }),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useListClusterRuns: () => mockListClusterRuns(),
    getListClusterRunsQueryKey: () => ["/api/clustering/runs"],
    useStartClusterRun: () => ({ mutate: mockStartMutation, isPending: false }),
    useRebuildClusterRun: () => ({ mutate: vi.fn(), isPending: false }),
    useListClusterRunClusters: () => ({ data: [] }),
    getListClusterRunClustersQueryKey: (id: number) => ["/api/clustering/runs", id, "clusters"],
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

beforeEach(() => {
  mockStartMutation.mockReset();
  mockInvalidateQueries.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("direct start run", () => {
  it("submits the run immediately with no paid or location fields", () => {
    render(
      <TooltipProvider>
        <Clustering />
      </TooltipProvider>,
    );

    fireEvent.change(screen.getByRole("slider"), { target: { value: "4" } });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "10.5" } });
    fireEvent.click(screen.getByTestId("button-start-clustering"));

    expect(mockStartMutation).toHaveBeenCalledTimes(1);
    expect(mockStartMutation.mock.calls[0]?.[0]).toEqual({
      data: {
        weeks: 4,
        keywordLimit: 10,
        excludeBrand: true,
      },
    });
  });
});

describe("run history display", () => {
  it("renders GSC reports with badge and rebuild button", () => {
    mockListClusterRuns.mockReturnValue({
      data: [
        {
          id: 10,
          status: "complete",
          createdAt: new Date().toISOString(),
          progressDone: 100,
          progressTotal: 100,
          params: { weeks: 4, keywordLimit: 10, evidenceSource: "gsc_page" },
          stats: { clusters: 5, keywords: 10 }
        } as ClusterRun
      ]
    });

    render(
      <TooltipProvider>
        <Clustering />
      </TooltipProvider>
    );

    expect(screen.getByText("GSC landing-page evidence")).toBeInTheDocument();
    expect(screen.getByText("Improve cluster names (free)")).toBeInTheDocument();
  });

  it("renders legacy reports with badge and without rebuild button", () => {
    mockListClusterRuns.mockReturnValue({
      data: [
        {
          id: 11,
          status: "complete",
          createdAt: new Date().toISOString(),
          progressDone: 100,
          progressTotal: 100,
          params: { weeks: 4, keywordLimit: 10, evidenceSource: "serp" },
          stats: { clusters: 5, keywords: 10 }
        } as ClusterRun
      ]
    });

    render(
      <TooltipProvider>
        <Clustering />
      </TooltipProvider>
    );

    expect(screen.getByText("Legacy SERP report")).toBeInTheDocument();
    expect(screen.queryByText("Improve cluster names (free)")).not.toBeInTheDocument();
  });
});

describe("ExpandedClusterDetail", () => {
  it("renders a new-format keyword correctly, displaying query, actual gscPages, and formatting metrics including legacy state gracefully", () => {
    const cluster = {
      id: 1,
      clusterKey: 1,
      topic: "SEO Topics",
      quadrant: "opportunities" as const,
      isOutlier: false,
      keywordCount: 1,
      totalClicks: 15,
      totalImpressions: 200,
      blendedCtr: 7.5,
      avgPosition: 3,
      coreSimilarity: 0.5,
      coreTag: "core",
      keywords: [
        {
          query: "how to do seo",
          clicks: 10,
          impressions: 100,
          ctr: 0.1, // 10%
          position: 2.5,
          state: KeywordState.rising,
          priorClicks: 5,
          priorImpressions: 50,
          priorCtr: 0.1,
          priorPosition: 3.5,
          clickDelta: 1,
          clickDeltaAbs: 5,
          impressionDelta: 1,
          impressionDeltaAbs: 50,
          gscPages: [
            { url: "https://example.com/seo", impressions: 100, clicks: 10, position: 1 },
            { url: "https://example.com/other", impressions: 50, clicks: 5, position: 2 },
          ]
        },
        {
          query: "new keyword",
          clicks: 5,
          impressions: 100,
          ctr: 0.05,
          position: 5,
          state: KeywordState.new,
          priorClicks: 0,
          priorImpressions: 0,
          priorCtr: 0,
          priorPosition: 0,
          clickDelta: null,
          clickDeltaAbs: 5,
          impressionDelta: null,
          impressionDeltaAbs: 100,
          gscPages: []
        },
        {
          query: "legacy keyword",
          clicks: 5,
          impressions: 100,
          ctr: 0.05, // 5%
          position: 5,
          state: undefined,
        }
      ],
    } as unknown as KeywordCluster;

    render(
      <TooltipProvider>
        <ExpandedClusterDetail cluster={cluster} />
      </TooltipProvider>
    );

    // Renders the full query
    expect(screen.getByText("how to do seo")).toBeInTheDocument();
    
    // Renders the gscPages
    const seoLinks = screen.getAllByText("https://example.com/seo");
    expect(seoLinks.length).toBeGreaterThan(0);
    expect(seoLinks[0]).toBeInTheDocument();
    expect(screen.getByText("100 imp • 10 clicks • pos 1.0")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/other")).toBeInTheDocument();
    expect(screen.getByText("50 imp • 5 clicks • pos 2.0")).toBeInTheDocument();

    // Renders the percentages properly (clickDelta = 1 -> 100.0%)
    const textNodes = screen.getAllByText("+100.0%");
    expect(textNodes.length).toBeGreaterThan(0); // at least click and impression deltas

    // Renders the absolute deltas
    expect(screen.getAllByText("(+5)")[0]).toBeInTheDocument();
    expect(screen.getByText("(+50)")).toBeInTheDocument();

    // Renders the CTR properly (fraction converted to %)
    expect(screen.getByText("10.0%")).toBeInTheDocument();
    expect(screen.getByText("prev 10.0%")).toBeInTheDocument();
    
    // Renders the legacy keyword query
    expect(screen.getByText("legacy keyword")).toBeInTheDocument();
    // Legacy keyword should have a "-" for state
    expect(screen.getByText("-")).toBeInTheDocument();
    
    // Renders the new keyword query
    expect(screen.getByText("new keyword")).toBeInTheDocument();
    // It should have the "New" badge for state
    expect(screen.getAllByText("New")[0]).toBeInTheDocument();
    // It should have the "New" text for missing ratio
    expect(screen.getAllByText("New")[1]).toBeInTheDocument();
    
    // Competitor and own URLs should not be rendered
    expect(screen.queryByText("Your ranking URLs")).not.toBeInTheDocument();
    expect(screen.queryByText("Competitors ranking in results")).not.toBeInTheDocument();

    // Test formatting of state
    expect(screen.getByText("Rising")).toBeInTheDocument();
  });
});
