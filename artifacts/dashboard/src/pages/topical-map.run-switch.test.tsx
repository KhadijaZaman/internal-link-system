/**
 * @vitest-environment jsdom
 *
 * Regression test: switching between runs must update the empty-state overlay
 * correctly.  Specifically:
 *  - Selecting an empty run (zero nodes) must show the "No topics generated" overlay.
 *  - Selecting a run that has nodes must hide the overlay.
 *
 * This guards against regressions in the memoised layout or the selected-run
 * derivation that could silently leave a stale empty-state (or stale map) after
 * the user picks a different historical run.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import TopicalMapPage from "./topical-map";

// ---------------------------------------------------------------------------
// jsdom stubs — fill in browser APIs that jsdom does not implement.
// ---------------------------------------------------------------------------
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  // Radix UI Select calls scrollIntoView on the highlighted option; jsdom
  // does not implement it, so we stub it to prevent the test from crashing.
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------

const BASE_RUN = {
  status: "complete" as const,
  phase: null,
  progressDone: 0,
  progressTotal: 0,
  entitySynonyms: [],
  centralSearchIntent: "Users looking to manage projects",
  sourceContext: "A project management tool",
  bordersWill: [],
  bordersWillNot: [],
  competitorScanStatus: null,
};

/** Run 1 — has one pillar node. Shown first in the list (auto-selected on load). */
const RUN_WITH_NODES = {
  ...BASE_RUN,
  id: 1,
  centralEntity: "Project Tools",
  createdAt: new Date("2026-01-01T10:00:00Z").toISOString(),
};

/** Run 2 — produced zero nodes (empty map). */
const EMPTY_RUN = {
  ...BASE_RUN,
  id: 2,
  centralEntity: "Empty Run",
  createdAt: new Date("2026-01-02T10:00:00Z").toISOString(),
};

/** Minimal node that satisfies the layout memo and all render paths. */
const PILLAR_NODE = {
  id: 101,
  mapId: 1,
  parentId: null,
  level: "pillar" as const,
  section: "core",
  sortOrder: 0,
  status: "gap" as const,
  priority: "high",
  title: "Project Management",
  canonicalQuery: "project management software",
  attributeOwned: "ease of use",
  intent: "informational",
  predicate: "how to",
  funnelStage: "top",
  pageType: "guide",
  suggestedSlug: "project-management",
  suggestedTitle: "Project Management Guide",
  informationGain: null,
  borderNote: null,
  matchedPagePath: null,
  matchSource: null,
  matchConfidence: null,
  pageTitle: null,
  gscClicks: null,
  gscImpressions: null,
  gscPosition: null,
  competitors: [],
};

const DETAIL_WITH_NODES = {
  map: { id: 1, status: "complete", centralEntity: "Project Tools" },
  nodes: [PILLAR_NODE],
  bridges: [],
};

const DETAIL_EMPTY = {
  map: { id: 2, status: "complete", centralEntity: "Empty Run" },
  nodes: [],
  bridges: [],
};

// ---------------------------------------------------------------------------
// Mock heavy external dependencies
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  useLocation: () => ["/topical-map", vi.fn()],
}));

// useGetTopicalMapRun is a vi.fn() so individual tests can configure its
// return value via vi.mocked(useGetTopicalMapRun).mockImplementation(…).
vi.mock("@workspace/api-client-react", async () => {
  const stubMutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    reset: vi.fn(),
  });

  return {
    // Two completed runs so the run-selector is rendered.
    useListTopicalMapRuns: () => ({
      data: [RUN_WITH_NODES, EMPTY_RUN],
      isLoading: false,
    }),

    // Configured per-test (see vi.mocked calls below).
    useGetTopicalMapRun: vi.fn(),

    useGenerateTopicalMap: () => ({ mutation: stubMutation() }),
    useUpdateTopicalMapNode: () => ({ mutation: stubMutation() }),
    useAnalyzeTopicalMapCompetitors: () => ({ mutation: stubMutation() }),
    useRefreshTopicalMapDemand: () => ({ mutation: stubMutation() }),

    getListTopicalMapRunsQueryKey: () => ["topical-map-runs"],
    getGetTopicalMapRunQueryKey: (id: number) => ["topical-map-run", id],
    getGetJobStatusQueryKey: () => ["job-status"],

    useRunJob: () => stubMutation(),
    useGetJobStatus: () => ({ data: undefined }),
  };
});

// Import the mock so we can configure it per-test.
import { useGetTopicalMapRun } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPage() {
  return render(
    <QueryClientProvider client={makeClient()}>
      <TooltipProvider>
        <TopicalMapPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TopicalMapPage — run switching", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the empty-state overlay after switching to a run with no nodes", async () => {
    // Run 1 (with nodes) is selected by default because it is first in completeRuns.
    // Run 2 (empty) is the one we will switch to.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(useGetTopicalMapRun).mockImplementation((id: number) =>
      (id === 1 ? { data: DETAIL_WITH_NODES } : { data: DETAIL_EMPTY }) as any,
    );

    renderPage();

    // Initially no overlay — run 1 has nodes.
    expect(screen.queryByText("No topics generated")).toBeNull();

    // Open the run selector and pick run 2 (empty).
    const trigger = screen.getByTestId("select-run");
    await act(async () => {
      fireEvent.click(trigger);
    });

    // Radix renders options in a portal attached to document.body.
    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    // Run 2 is the second item in the list.
    const run2Option = options.find((o) => o.textContent?.includes("Empty Run"));
    expect(run2Option).toBeTruthy();

    await act(async () => {
      fireEvent.click(run2Option!);
    });

    // After switching, the empty-state overlay must be visible.
    expect(screen.getByText("No topics generated")).toBeTruthy();
  });

  it("hides the empty-state overlay after switching to a run that has nodes", async () => {
    // Start with run 2 (empty) effectively active by returning empty detail
    // for run 1 and node detail for run 2 — swap the IDs so the auto-selected
    // first run (id=1) shows the empty state initially.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(useGetTopicalMapRun).mockImplementation((id: number) =>
      (id === 1 ? { data: DETAIL_EMPTY } : { data: DETAIL_WITH_NODES }) as any,
    );

    renderPage();

    // Run 1 is auto-selected (first in list) and is empty — overlay must show.
    expect(screen.getByText("No topics generated")).toBeTruthy();

    // Open the run selector and pick run 2 (which has nodes in this config).
    const trigger = screen.getByTestId("select-run");
    await act(async () => {
      fireEvent.click(trigger);
    });

    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    // Run 2 ("Empty Run" entity label in the fixture, but mocked with nodes here)
    // is the second SelectItem rendered.
    const run2Option = options[1];
    expect(run2Option).toBeTruthy();

    await act(async () => {
      fireEvent.click(run2Option!);
    });

    // After switching to the run with nodes, overlay must be gone.
    expect(screen.queryByText("No topics generated")).toBeNull();
  });
});
