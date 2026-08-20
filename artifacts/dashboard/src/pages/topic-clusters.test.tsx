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

const DEFAULT_SIMILAR_PAGES = [
  {
    path: "/blog/ai-search-visibility/",
    title: "AI Search Visibility Guide",
    similarity: 0.91,
  },
  {
    path: "/blog/search-engine-visibility/",
    title: "Search Engine Visibility",
    similarity: 0.87,
  },
  {
    path: "/blog/visibility-checklist/",
    title: "Visibility Checklist",
    similarity: 0.42,
  },
  {
    path: "/blog/ai-search-metrics/",
    title: "AI Search Metrics",
    similarity: 0.76,
  },
];
let pillarSimilarPages = [...DEFAULT_SIMILAR_PAGES];

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
            similarPages: pillarSimilarPages,
          },
        ],
      },
    },
    isLoading: false,
  }),
  getListTopicalMapRunsQueryKey: () => ["topical-map-runs"],
  getGetTopicalMapRunQueryKey: (id: number) => ["topical-map-run", id],
}));

vi.mock("@/lib/site-context", () => ({
  useSiteContext: () => ({
    activeSite: { host: "example.com" },
  }),
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
  afterEach(() => {
    cleanup();
    pillarSimilarPages = [...DEFAULT_SIMILAR_PAGES];
  });

  it("renders the cluster hierarchy as a separate page", () => {
    renderPage();

    expect(screen.getByTestId("page-topic-clusters")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Topic Clusters" })).toBeTruthy();
    expect(screen.getByTestId("topic-cluster-map")).toBeTruthy();
    expect(screen.getByTestId("button-cluster-map-node-1")).toBeTruthy();
    expect(screen.getByTestId("cluster-url-group-1")).toBeTruthy();
    expect(
      screen
        .getByTestId("cluster-url-1-/blog/search-engine-visibility/")
        .getAttribute("href"),
    ).toBe("https://example.com/blog/search-engine-visibility/");
    expect(
      screen
        .getByTestId("cluster-url-1-/blog/visibility-checklist/")
        .getAttribute("href"),
    ).toBe("https://example.com/blog/visibility-checklist/");
    expect(
      screen
        .getByTestId("cluster-url-1-/blog/visibility-checklist/")
        .getAttribute("target"),
    ).toBe("_blank");
    expect(
      screen.getByLabelText("42% cosine similarity"),
    ).toBeTruthy();
    expect(screen.getByText("Show 1 more page")).toBeTruthy();
    const mapPageLink = screen.getByTestId("cluster-map-open-page-1");
    expect(mapPageLink.getAttribute("href")).toBe(
      "https://example.com/blog/ai-search-visibility/",
    );
    expect(mapPageLink.getAttribute("target")).toBe("_blank");
    expect(mapPageLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByTestId("topical-map-overview")).toBeTruthy();
    expect(screen.getAllByText("AI Search Visibility").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("/blog/search-engine-visibility/").length,
    ).toBeGreaterThan(0);
  });

  it("selects a topic and shows its cluster detail", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("button-cluster-map-node-1"));

    const detail = screen.getByTestId("card-cluster-topic-detail");
    expect(detail.textContent).toContain("AI Search Visibility");
    expect(detail.textContent).toContain("No matching page yet");
  });

  it("does not fall back to unscored node matches when no page clears the threshold", () => {
    pillarSimilarPages = [];
    renderPage();

    expect(
      screen.queryByTestId("cluster-url-1-/blog/search-engine-visibility/"),
    ).toBeNull();
    expect(screen.queryByTestId("cluster-map-open-page-1")).toBeNull();
    expect(
      screen.getByText("No embedded pages clear the 42% similarity threshold yet."),
    ).toBeTruthy();
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