/**
 * @vitest-environment jsdom
 *
 * Regression test: the empty-state overlay ("No topics generated") must appear
 * when a completed run returns zero nodes.  This guards against future
 * refactors of the canvas section silently removing the overlay or breaking
 * the `layout.nodes.length === 0` guard.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import TopicalMapPage from "./topical-map";

// ---------------------------------------------------------------------------
// Canvas stub — jsdom does not implement getContext("2d").
// The canvas effect checks for a null ctx and returns early, so this is safe.
// ---------------------------------------------------------------------------
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

// ---------------------------------------------------------------------------
// Mock heavy external dependencies
// ---------------------------------------------------------------------------

// Wouter navigation
vi.mock("wouter", () => ({
  useLocation: () => ["/topical-map", vi.fn()],
}));

// All API hooks — we supply controlled return values in each test via the mock.
vi.mock("@workspace/api-client-react", async () => {
  // Stable stub for mutation hooks.
  const stubMutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    reset: vi.fn(),
  });

  return {
    // Run list query — returns one completed run.
    useListTopicalMapRuns: () => ({
      data: [
        {
          id: 1,
          status: "complete",
          phase: null,
          progressDone: 0,
          progressTotal: 0,
          centralEntity: "Acme SaaS",
          entitySynonyms: [],
          centralSearchIntent: "Users looking to manage projects",
          sourceContext: "A project management tool",
          bordersWill: [],
          bordersWillNot: [],
          competitorScanStatus: null,
          createdAt: new Date().toISOString(),
        },
      ],
      isLoading: false,
    }),

    // Run detail query — returns a run with zero nodes and zero bridges.
    useGetTopicalMapRun: () => ({
      data: {
        map: {
          id: 1,
          status: "complete",
          centralEntity: "Acme SaaS",
        },
        nodes: [],
        bridges: [],
      },
    }),

    // Mutation hooks — stubs only.
    useGenerateTopicalMap: () => ({ mutation: stubMutation() }),
    useUpdateTopicalMapNode: () => ({ mutation: stubMutation() }),
    useAnalyzeTopicalMapCompetitors: () => ({ mutation: stubMutation() }),

    // Query-key helpers — return stable arrays so hooks can be called.
    getListTopicalMapRunsQueryKey: () => ["topical-map-runs"],
    getGetTopicalMapRunQueryKey: (id: number) => ["topical-map-run", id],
    getGetJobStatusQueryKey: () => ["job-status"],

    // Used by JobSpendCapNotice (rendered inside the page).
    useRunJob: () => stubMutation(),
    useGetJobStatus: () => ({ data: undefined }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <TopicalMapPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TopicalMapPage — empty-state overlay (zero nodes)", () => {
  afterEach(() => cleanup());
  it('shows "No topics generated" when a completed run has an empty node list', () => {
    renderPage();
    expect(screen.getByText("No topics generated")).toBeTruthy();
  });

  it("shows the regeneration hint text alongside the empty-state heading", () => {
    renderPage();
    expect(
      screen.getByText(/try regenerating with a broader charter/i),
    ).toBeTruthy();
  });

  it("keeps the canvas element in the DOM even when no nodes were generated", () => {
    const { container } = renderPage();
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
  });

  it("does not throw a JS error during render with an empty node list", () => {
    expect(() => renderPage()).not.toThrow();
  });
});
