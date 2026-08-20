// @vitest-environment jsdom
/**
 * Component-level integration test for topical-map.tsx — hub-click clears selection.
 *
 * Strategy
 * --------
 * 1. Render the real TopicalMapPage with mocked API hooks and a canvas context stub
 *    so D3's canvas effect runs to completion and registers the native click listener.
 * 2. Select a node via the table view (sets selectedNodeId → detail panel opens).
 * 3. Dispatch a MouseEvent on the <canvas> at pixel (0, 0).
 *    In jsdom, getBoundingClientRect returns all-zeros, so d3.pointer maps the click
 *    to canvas-local (0, 0).  The D3 zoom transform is either identity (translate(0,0)
 *    scale(1)) or translate(0, height/2).scale(0.85) depending on whether D3's
 *    programmatic zoom fires in jsdom — in both cases invert([0,0]) places the world
 *    coordinate well outside every radial-tree node (which live at radius ~300), so
 *    hitTestNodes returns undefined, resolveClickSelection returns null, and the
 *    real setSelectedNodeId(null) runs.
 * 4. Assert the detail panel disappears — proving the ring/highlight is cleared.
 */

import React from "react";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import TopicalMapPage from "./topical-map";

// ---------------------------------------------------------------------------
// Canvas 2D context stub
// Patches HTMLCanvasElement.prototype.getContext so the D3 canvas effect
// doesn't short-circuit at `if (!ctx) return;`.
// ---------------------------------------------------------------------------
beforeAll(() => {
  const ctx2d: Record<string, unknown> = {
    // transform / clip
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    // clear
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    // path
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    ellipse: vi.fn(),
    // stroke / fill
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    // text
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn(() => ({ width: 50 })),
    // gradient
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    // settable style properties (plain values so assignments work)
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
  };

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    value: vi.fn().mockReturnValue(ctx2d),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    get: () => 900,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Mock: @workspace/api-client-react
// Covers all hooks imported by topical-map.tsx and spend-cap-badge.tsx.
// ---------------------------------------------------------------------------
/** All fields that topical-map.tsx reads from a node (including the detail panel). */
const baseNode = {
  parentId: null as number | null, runId: 1,
  section: "core", level: "pillar" as const,
  priority: "high", intent: "informational", predicate: "how-to",
  funnelStage: "tofu", pageType: "article",
  suggestedTitle: "Suggested title", attributeOwned: "best angle",
  informationGain: null as null, borderNote: null as null,
  matchedPagePath: null as null, matchSource: null as null,
  matchConfidence: null as null, pageTitle: null as null,
  suggestedSlug: "/suggested-slug",
  gscClicks: null as null, gscImpressions: null as null, gscPosition: null as null,
  competitors: [] as never[],
};

const MOCK_NODES = [
  {
    ...baseNode, id: 1, sortOrder: 1, status: "gap" as const,
    title: "Alpha Topic", canonicalQuery: "alpha query",
  },
  {
    // published + matched page to exercise the gscPosition branch
    ...baseNode, id: 2, sortOrder: 2, status: "published" as const,
    parentId: 1, level: "core_topic" as const,
    priority: "medium",
    title: "Beta Topic", canonicalQuery: "beta query",
    matchedPagePath: "/beta", matchSource: "embedding", matchConfidence: 0.92,
    pageTitle: "Beta page title",
    gscClicks: 42, gscImpressions: 1200, gscPosition: null,  // null → no toFixed call
  },
  {
    ...baseNode, id: 3, sortOrder: 3, status: "gap" as const,
    parentId: 2, level: "subtopic" as const, section: "outer", priority: "low",
    title: "Gamma Topic", canonicalQuery: "gamma query",
    informationGain: "High info gain",
  },
];

const MOCK_RUN = {
  id: 1,
  status: "complete" as const,
  phase: null,
  progressDone: 0,
  progressTotal: 0,
  centralEntity: "Test Entity",
  entitySynonyms: [],
  centralSearchIntent: "how to test effectively",
  sourceContext: "a testing context that is long enough",
  bordersWill: [],
  bordersWillNot: [],
  createdAt: new Date().toISOString(),
  competitorScanStatus: null,
  competitorScanError: null,
};

const MOCK_DETAIL = {
  map: MOCK_RUN,
  nodes: MOCK_NODES,
  bridges: [],
  coverage: {
    totalNodes: 3,
    publishedNodes: 1,
    gapNodes: 2,
    ignoredNodes: 0,
    coveragePct: 33,
    perPillar: [
      { nodeId: 1, title: "Alpha Topic", section: "core", total: 3, published: 1, coveragePct: 33 },
    ],
  },
};

const noopMutation = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  isPending: false,
  isError: false,
  isSuccess: false,
  reset: vi.fn(),
});

vi.mock("@workspace/api-client-react", () => ({
  // Queries
  useListTopicalMapRuns: () => ({ data: [MOCK_RUN], isLoading: false, error: null }),
  useGetTopicalMapRun: () => ({ data: MOCK_DETAIL, isLoading: false, error: null }),
  useGetJobStatus: () => ({ data: [], isLoading: false }),
  // Mutations
  useGenerateTopicalMap: () => noopMutation(),
  useAnalyzeTopicalMapCompetitors: () => noopMutation(),
  useUpdateTopicalMapNode: () => noopMutation(),
  useRunJob: () => noopMutation(),
  // Query key factories
  getListTopicalMapRunsQueryKey: () => ["listTopicalMapRuns"],
  getGetTopicalMapRunQueryKey: (id: number) => ["getTopicalMapRun", id],
  getGetJobStatusQueryKey: () => ["getJobStatus"],
}));

// ---------------------------------------------------------------------------
// Mock: wouter (navigation hook only — no router context needed in tests)
// ---------------------------------------------------------------------------
vi.mock("wouter", () => ({
  useLocation: () => ["/topical-map", vi.fn()],
}));

// ---------------------------------------------------------------------------
// Mock: toast hook
// ---------------------------------------------------------------------------
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Test wrapper: provides React Query context
// ---------------------------------------------------------------------------
function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Render the page and return helpers scoped to that render's container. */
function renderPage() {
  const result = render(<TopicalMapPage />, { wrapper: Wrapper });
  const q = within(result.container);
  const canvas = () => result.container.querySelector("canvas")!;
  return { ...result, q, canvas };
}

describe("TopicalMapPage — hub click clears stale node selection", () => {
  // RTL does not guarantee automatic cleanup in all vitest setups — be explicit.
  afterEach(() => cleanup());

  it("renders the detail panel when a node is selected, then closes it on a canvas hub click", async () => {
    const { q, canvas } = renderPage();

    // ── Step 1: switch to table view so we can select a node reliably ──────
    fireEvent.click(q.getByTestId("button-view-table"));

    // ── Step 2: click a table row → selectedNodeId = 1 ───────────────────
    fireEvent.click(await q.findByTestId("row-topic-1"));

    // Detail panel must be visible with the selected topic's title.
    const panel = await q.findByTestId("card-node-detail");
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain("Alpha Topic");

    // ── Step 3: dispatch a click on the canvas at pixel (0, 0) ───────────
    // In jsdom, getBoundingClientRect returns all-zeros, so d3.pointer maps
    // the click to canvas-local (0, 0).  Inverting through any zoom transform
    // places the world coordinate far from every radial-tree node (radius 300),
    // so hitTestNodes returns undefined → resolveClickSelection returns null
    // → the real setSelectedNodeId(null) call runs inside the onClick handler.
    const cvs = canvas();
    expect(cvs).toBeTruthy();
    fireEvent.click(cvs, { clientX: 0, clientY: 0 });

    // ── Step 4: detail panel must disappear ──────────────────────────────
    await waitFor(() => {
      expect(q.queryByTestId("card-node-detail")).toBeNull();
    });
  });

  it("hub click from each pre-selected node always clears the panel", async () => {
    const { q, canvas } = renderPage();

    fireEvent.click(q.getByTestId("button-view-table"));

    for (const { id } of MOCK_NODES) {
      // Select node via table row.
      fireEvent.click(await q.findByTestId(`row-topic-${id}`));
      expect(await q.findByTestId("card-node-detail")).toBeTruthy();

      // Hub click clears it.
      fireEvent.click(canvas(), { clientX: 0, clientY: 0 });
      await waitFor(() => {
        expect(q.queryByTestId("card-node-detail")).toBeNull();
      });
    }
  });

  it("sequential hub clicks are idempotent — panel stays closed", async () => {
    const { q, canvas } = renderPage();

    // Select a node.
    fireEvent.click(q.getByTestId("button-view-table"));
    fireEvent.click(await q.findByTestId("row-topic-2"));
    expect(await q.findByTestId("card-node-detail")).toBeTruthy();

    // First hub click closes the panel.
    fireEvent.click(canvas(), { clientX: 0, clientY: 0 });
    await waitFor(() => {
      expect(q.queryByTestId("card-node-detail")).toBeNull();
    });

    // Second hub click must not re-open anything.
    fireEvent.click(canvas(), { clientX: 0, clientY: 0 });
    await waitFor(() => {
      expect(q.queryByTestId("card-node-detail")).toBeNull();
    });
  });
});

describe("TopicalMapPage — readable overview", () => {
  afterEach(() => cleanup());

  it("opens on the overview and shows the central entity with pillar coverage cues", () => {
    const { q } = renderPage();

    expect(q.getByTestId("topical-map-overview")).toBeTruthy();
    expect(q.getByTestId("text-overview-central-entity").textContent).toContain(
      "Test Entity",
    );
    expect(q.getByTestId("card-overview-pillar-1")).toBeTruthy();
    expect(q.getByTestId("text-overview-covered-1").textContent).toContain(
      "1 covered",
    );
    expect(q.getByTestId("text-overview-gaps-1").textContent).toContain("2 gaps");
    expect(q.getByTestId("text-overview-priority-1").textContent).toContain(
      "1 high priority",
    );
    expect(q.getByTestId("tree-overview-node-2")).toBeTruthy();
    expect(q.getByTestId("tree-overview-node-3")).toBeTruthy();
    expect(q.getByTestId("text-overview-page-2").textContent).toContain("/beta");
  });

  it("opens the existing detail panel when a topic is selected from the overview", async () => {
    const { q } = renderPage();

    fireEvent.click(q.getByTestId("button-overview-node-2"));

    const panel = await q.findByTestId("card-node-detail");
    expect(panel.textContent).toContain("Beta Topic");
  });

  it("applies the existing status filters to the overview", () => {
    const { q } = renderPage();

    expect(q.getByTestId("card-overview-pillar-1")).toBeTruthy();
    fireEvent.click(q.getByTestId("button-filter-gap"));

    expect(q.getByTestId("card-overview-pillar-1")).toBeTruthy();
    expect(
      (q.getByTestId("button-overview-pillar-1") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(q.getByTestId("tree-overview-node-2")).toBeTruthy();
    expect(q.queryByTestId("tree-overview-node-3")).toBeNull();
  });

  it("keeps a usable canvas when switching from the default overview to the map", () => {
    const { q, canvas } = renderPage();
    const mapButton = q.getByTestId("button-view-map");

    expect(q.getByTestId("button-view-overview").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(canvas().parentElement?.className.split(/\s+/)).not.toContain("hidden");
    expect(canvas().style.width).toBe("900px");
    fireEvent.click(mapButton);

    expect(mapButton.getAttribute("aria-pressed")).toBe("true");
    expect(q.getByTestId("button-view-overview").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(canvas().parentElement?.getAttribute("aria-hidden")).toBe("false");
  });
});
