/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import TopicClustersPage from "./topic-clusters";

const RUN = {
  id: 1,
  status: "complete",
  phase: null,
  progressDone: 0,
  progressTotal: 0,
  centralEntity: "AI Visibility",
  entitySynonyms: [],
  centralSearchIntent: "Measure and improve AI visibility",
  sourceContext: "AI visibility platform",
  bordersWill: [],
  bordersWillNot: [],
  competitorScanStatus: null,
  createdAt: "2026-08-20T10:00:00.000Z",
};

const PILLAR = {
  id: 1,
  mapId: 1,
  parentId: null,
  level: "pillar",
  section: "core",
  title: "AI Search Visibility",
  canonicalQuery: "ai search visibility",
  attributeOwned: "measurement",
  intent: "informational",
  predicate: "what is",
  funnelStage: "top",
  pageType: "guide",
  suggestedSlug: "ai-search-visibility",
  suggestedTitle: "AI Search Visibility Guide",
  informationGain: null,
  borderNote: null,
  priority: "high",
  status: "gap",
  matchedPagePath: null,
  matchSource: null,
  matchConfidence: null,
  sortOrder: 0,
  pageTitle: null,
  gscClicks: null,
  gscImpressions: null,
  gscPosition: null,
  competitors: [],
};

const SUPPORTING = {
  ...PILLAR,
  id: 2,
  parentId: 1,
  level: "core_topic",
  title: "Search Engine Visibility",
  canonicalQuery: "search engine visibility",
  status: "published",
  matchedPagePath: "/blog/search-engine-visibility/",
  sortOrder: 1,
};

vi.mock("@workspace/api-client-react", () => ({
  useListTopicalMapRuns: () => ({
    data: [RUN],
    isLoading: false,
  }),
  useGetTopicalMapRun: () => ({
    data: {
      map: RUN,
      nodes: [PILLAR, SUPPORTING],
      bridges: [],
      coverage: {
        totalNodes: 2,
        publishedNodes: 1,
        gapNodes: 1,
        ignoredNodes: 0,
        coveragePct: 50,
        perPillar: [
          {
            nodeId: 1,
            title: "AI Search Visibility",
            section: "core",
            total: 2,
            published: 1,
            coveragePct: 50,
          },
        ],
      },
    },
    isLoading: false,
  }),
  getListTopicalMapRunsQueryKey: () => ["topical-map-runs"],
  getGetTopicalMapRunQueryKey: (id: number) => ["topical-map-run", id],
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <TopicClustersPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("TopicClustersPage", () => {
  afterEach(() => cleanup());

  it("renders the cluster hierarchy as a separate page", () => {
    renderPage();

    expect(screen.getByTestId("page-topic-clusters")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Topic Clusters" })).toBeTruthy();
    expect(screen.getByTestId("topic-cluster-map")).toBeTruthy();
    expect(screen.getByTestId("button-cluster-map-node-1")).toBeTruthy();
    expect(screen.getByTestId("topical-map-overview")).toBeTruthy();
    expect(screen.getAllByText("AI Search Visibility").length).toBeGreaterThan(0);
    expect(screen.getByText("/blog/search-engine-visibility/")).toBeTruthy();
  });

  it("selects a topic and shows its cluster detail", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("button-cluster-map-node-1"));

    const detail = screen.getByTestId("card-cluster-topic-detail");
    expect(detail.textContent).toContain("AI Search Visibility");
    expect(detail.textContent).toContain("No matching page yet");
  });

  it("filters gaps without hiding covered descendant context", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("button-cluster-filter-gap"));

    expect(screen.getByTestId("tree-overview-node-2")).toBeTruthy();
    expect(
      (screen.getByTestId("button-overview-pillar-1") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});