// @ts-nocheck
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
import { render, screen, fireEvent, within } from "@testing-library/react";
import Clustering, { ExpandedClusterDetail } from "./clustering";
import { KeywordCluster, KeywordState } from "@workspace/api-client-react";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockStartMutation = vi.fn();
const mockInvalidateQueries = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useListClusterRuns: () => ({ data: [] }),
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

vi.mock("@/components/spend-cap-badge", () => ({
  JobSpendCapNotice: () => null,
}));

beforeEach(() => {
  mockStartMutation.mockReset();
  mockInvalidateQueries.mockReset();
});

describe("paid clustering confirmation", () => {
  it("does not submit on cancel and submits the displayed 4-week, 10-keyword estimate only after approval", () => {
    render(
      <TooltipProvider>
        <Clustering />
      </TooltipProvider>,
    );

    fireEvent.change(screen.getByRole("slider"), { target: { value: "4" } });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("button-open-clustering-confirmation"));

    const confirmation = screen.getByTestId("dialog-confirm-clustering-run");
    expect(within(confirmation).getByTestId("text-confirmed-serp-estimate")).toHaveTextContent("$0.01");
    expect(within(confirmation).getByText("4 weeks")).toBeInTheDocument();
    expect(within(confirmation).getByText("10")).toBeInTheDocument();
    expect(mockStartMutation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("button-cancel-clustering-run"));
    expect(screen.queryByTestId("dialog-confirm-clustering-run")).not.toBeInTheDocument();
    expect(mockStartMutation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("button-open-clustering-confirmation"));
    fireEvent.click(screen.getByTestId("button-confirm-clustering-run"));

    expect(mockStartMutation).toHaveBeenCalledTimes(1);
    expect(mockStartMutation.mock.calls[0]?.[0]).toEqual({
      data: {
        weeks: 4,
        keywordLimit: 10,
        locationCode: 2840,
        excludeBrand: true,
        paidRunConfirmed: true,
      },
    });
  });
});

describe("ExpandedClusterDetail", () => {
  it("renders a new-format keyword correctly, displaying query, actual serpUrls, and formatting metrics including legacy state gracefully", () => {
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
          serpUrls: [
            { url: "https://example.com/seo", position: 1 },
            { url: "https://example.com/other", position: 2 },
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
          serpUrls: []
        },
        {
          query: "legacy keyword",
          clicks: 5,
          impressions: 100,
          ctr: 0.05, // 5%
          position: 5,
          state: undefined,
          serpUrls: []
        }
      ],
      ownUrls: [{ url: "https://mysite.com/seo", domain: "mysite.com", keywordCount: 2 }],
      competitorUrls: [{ url: "https://example.com/seo", domain: "example.com", keywordCount: 2 }]
    } as unknown as KeywordCluster;

    render(
      <TooltipProvider>
        <ExpandedClusterDetail cluster={cluster} />
      </TooltipProvider>
    );

    // Renders the full query
    expect(screen.getByText("how to do seo")).toBeInTheDocument();
    
    // Renders the serpUrls
    const seoLinks = screen.getAllByText("https://example.com/seo");
    expect(seoLinks.length).toBeGreaterThan(0);
    expect(seoLinks[0]).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/other")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();

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
    
    // Renders own URLs and competitor URLs
    expect(screen.getByText("https://mysite.com/seo")).toBeInTheDocument();

    // Test formatting of state
    expect(screen.getByText("Rising")).toBeInTheDocument();
  });
});
