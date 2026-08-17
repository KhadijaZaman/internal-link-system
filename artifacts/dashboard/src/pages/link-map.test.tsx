// @vitest-environment jsdom
/**
 * Component-level integration tests for link-map.tsx — Map/Table tab toggle.
 *
 * Strategy
 * --------
 * 1. Render the real LinkMap component with mocked API hooks.
 * 2. Verify Map view shows an SVG with D3 content (a <g> group element appended
 *    synchronously by the force-graph effect).
 * 3. Toggle to Table view — verify the global links table appears with the
 *    expected columns (Source / Destination / Position / Links / Anchor text).
 * 4. Toggle back to Map — verify D3 re-ran and the SVG is re-populated.
 * 5. Repeat with Navigation and Footer placement switches toggled on/off,
 *    confirming the table updates accordingly.
 *
 * Note on D3 in jsdom
 * -------------------
 * D3's SVG effects (selectAll / append / join) are synchronous. The force
 * simulation kicks off asynchronous ticks, but the initial DOM mutations
 * (clearing the SVG and appending the top-level <g> group) happen before any
 * tick fires.  We therefore check for the presence of a <g> child inside the
 * <svg> immediately after React commits the effect, which is enough to confirm
 * the D3 effect ran and didn't bail out early.
 *
 * clientWidth / clientHeight return 0 in jsdom; we patch the SVGSVGElement
 * prototype so D3 reads non-zero dimensions and doesn't position everything at
 * the origin in a way that would mask real bugs.
 */

import React from "react";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import LinkMap from "./link-map";

// ---------------------------------------------------------------------------
// Patch SVGSVGElement so D3 reads non-zero dimensions in jsdom.
//
// d3-zoom v3 reads e.width.baseVal.value / e.height.baseVal.value when the
// SVG has no viewBox attribute, and e.clientWidth / e.clientHeight for the
// force-graph layout.  jsdom doesn't implement these as SVGAnimatedLength, so
// we stub them here.
// ---------------------------------------------------------------------------
beforeAll(() => {
  const makeAnimLen = (v: number) => ({ baseVal: { value: v }, animVal: { value: v } });

  Object.defineProperty(SVGSVGElement.prototype, "width", {
    get() { return makeAnimLen(800); },
    configurable: true,
  });
  Object.defineProperty(SVGSVGElement.prototype, "height", {
    get() { return makeAnimLen(600); },
    configurable: true,
  });
  Object.defineProperty(SVGSVGElement.prototype, "clientWidth", {
    get() { return 800; },
    configurable: true,
  });
  Object.defineProperty(SVGSVGElement.prototype, "clientHeight", {
    get() { return 600; },
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

/** Two core nodes and one outer node. */
const MOCK_NODES = [
  { id: "https://example.com/a", section: "core", isOrphan: false, isDeadEnd: false, pagerank: 0.5 },
  { id: "https://example.com/b", section: "core", isOrphan: false, isDeadEnd: false, pagerank: 0.3 },
  { id: "https://example.com/c", section: "outer", isOrphan: false, isDeadEnd: false, pagerank: 0.1 },
];

/**
 * Four edges:
 *   content: a→b, b→c
 *   nav:     a→c
 *   footer:  b→a
 *
 * Default view (content only) → 2 rows in the global table.
 * Nav on                       → 3 rows.
 * Footer on                    → 4 rows.
 * Both on                      → 4 rows.
 */
const MOCK_EDGES = [
  { source: "https://example.com/a", target: "https://example.com/b", placement: "content", anchorText: "read more about B", auditFlags: [], auditSimilarity: null },
  { source: "https://example.com/b", target: "https://example.com/c", placement: "content", anchorText: "see C", auditFlags: [], auditSimilarity: null },
  { source: "https://example.com/a", target: "https://example.com/c", placement: "nav",     anchorText: "C (nav)",           auditFlags: [], auditSimilarity: null },
  { source: "https://example.com/b", target: "https://example.com/a", placement: "footer",  anchorText: "Home",              auditFlags: [], auditSimilarity: null },
];

const MOCK_GRAPH = {
  nodes: MOCK_NODES,
  edges: MOCK_EDGES,
  audit: null,
};

// ---------------------------------------------------------------------------
// Mock: @workspace/api-client-react
// ---------------------------------------------------------------------------
const noopMutation = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  isPending: false,
  isError: false,
  isSuccess: false,
  reset: vi.fn(),
});

vi.mock("@workspace/api-client-react", () => ({
  useGetLinkGraph: () => ({ data: MOCK_GRAPH, isLoading: false }),
  useGetInventoryPage: () => ({ data: null, isLoading: false }),
  useGetLinkGraphFocus: () => ({ data: null, isLoading: false, error: null }),
  useGetJobStatus: () => ({ data: [], isLoading: false }),
  useRunJob: () => noopMutation(),
  getGetLinkGraphQueryKey: () => ["getLinkGraph"],
  getGetInventoryPageQueryKey: () => ["getInventoryPage"],
  getGetLinkGraphFocusQueryKey: () => ["getLinkGraphFocus"],
  getGetJobStatusQueryKey: () => ["getJobStatus"],
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Test wrapper
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

function renderPage() {
  const result = render(<LinkMap />, { wrapper: Wrapper });
  const q = within(result.container);
  return { ...result, q };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count rows in the global links table (excluding the header). */
function globalTableRowCount(container: HTMLElement): number {
  const table = container.querySelector("[data-testid='table-global-links']");
  if (!table) return -1;
  const tbody = table.querySelector("tbody");
  return tbody ? tbody.querySelectorAll("tr").length : 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinkMap — Map/Table tab toggle", () => {
  afterEach(() => cleanup());

  it("starts in Map view with a D3-populated SVG", async () => {
    const { container } = renderPage();

    // The Map button should be pressed.
    const mapBtn = container.querySelector("[data-testid='button-global-view-map']");
    expect(mapBtn).toBeTruthy();
    expect(mapBtn!.getAttribute("aria-pressed")).toBe("true");

    // D3 appends a top-level <g> to the force-graph SVG on mount.
    await waitFor(() => {
      const svg = container.querySelector("[data-testid='svg-global-map']");
      expect(svg).toBeTruthy();
      expect(svg!.querySelector("g")).toBeTruthy();
    });
  });

  it("switches to Table view and shows correct columns", async () => {
    const { container } = renderPage();

    const tableBtn = container.querySelector("[data-testid='button-global-view-table']")!;
    await act(async () => { fireEvent.click(tableBtn); });

    // Table should now be visible.
    await waitFor(() => {
      expect(container.querySelector("[data-testid='table-global-links']")).toBeTruthy();
    });

    const table = container.querySelector("[data-testid='table-global-links']")!;
    const headerText = table.querySelector("thead")!.textContent ?? "";

    expect(headerText).toContain("Source");
    expect(headerText).toContain("Destination");
    expect(headerText).toContain("Position");
    expect(headerText).toContain("Links");
    expect(headerText).toContain("Anchor text");
  });

  it("shows only content links by default (2 rows)", async () => {
    const { container } = renderPage();

    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid='button-global-view-table']")!);
    });

    await waitFor(() => {
      expect(globalTableRowCount(container)).toBe(2);
    });
  });

  it("switches back to Map view and D3 redraws (SVG re-populated)", async () => {
    const { container } = renderPage();

    // Go to Table.
    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid='button-global-view-table']")!);
    });
    await waitFor(() => {
      expect(container.querySelector("[data-testid='table-global-links']")).toBeTruthy();
    });

    // SVG should NOT be visible while in Table mode.
    // (It is unmounted, not hidden.)
    expect(container.querySelector("[data-testid='table-global-links']")).toBeTruthy();

    // Switch back to Map.
    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid='button-global-view-map']")!);
    });

    // Table is gone; SVG is back with D3 content.
    await waitFor(() => {
      expect(container.querySelector("[data-testid='table-global-links']")).toBeNull();
      const svg = container.querySelector("[data-testid='svg-global-map']");
      expect(svg).toBeTruthy();
      // D3 re-ran and appended its top-level <g>.
      expect(svg!.querySelector("g")).toBeTruthy();
    });

    // Map button is now pressed, Table button is not.
    expect(container.querySelector("[data-testid='button-global-view-map']")!.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-testid='button-global-view-table']")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("Map → Table → Map round-trip is repeatable (no blank SVG on second return)", async () => {
    const { container } = renderPage();

    for (let round = 0; round < 2; round++) {
      // → Table
      await act(async () => {
        fireEvent.click(container.querySelector("[data-testid='button-global-view-table']")!);
      });
      await waitFor(() => {
        expect(container.querySelector("[data-testid='table-global-links']")).toBeTruthy();
      });

      // → Map
      await act(async () => {
        fireEvent.click(container.querySelector("[data-testid='button-global-view-map']")!);
      });
      await waitFor(() => {
        expect(container.querySelector("[data-testid='table-global-links']")).toBeNull();
        const svg = container.querySelector("[data-testid='svg-global-map']");
        expect(svg).toBeTruthy();
        expect(svg!.querySelector("g")).toBeTruthy();
      });
    }
  });
});

describe("LinkMap — placement toggles update the Table view", () => {
  afterEach(() => cleanup());

  async function openTable(container: HTMLElement) {
    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid='button-global-view-table']")!);
    });
    await waitFor(() => {
      expect(container.querySelector("[data-testid='table-global-links']")).toBeTruthy();
    });
  }

  it("enabling Navigation adds nav-placement rows", async () => {
    const { container } = renderPage();
    await openTable(container);

    // Default: 2 content rows.
    expect(globalTableRowCount(container)).toBe(2);

    // Enable Navigation.
    const navSwitch = container.querySelector("[data-testid='switch-placement-nav']")!;
    await act(async () => { fireEvent.click(navSwitch); });

    await waitFor(() => {
      // Content (2) + nav (1) = 3 rows.
      expect(globalTableRowCount(container)).toBe(3);
    });

    // Check that "Navigation" badge appears in the table.
    const tableText = container.querySelector("[data-testid='table-global-links']")!.textContent ?? "";
    expect(tableText).toContain("Navigation");
  });

  it("enabling Footer adds footer-placement rows", async () => {
    const { container } = renderPage();
    await openTable(container);

    expect(globalTableRowCount(container)).toBe(2);

    const footerSwitch = container.querySelector("[data-testid='switch-placement-footer']")!;
    await act(async () => { fireEvent.click(footerSwitch); });

    await waitFor(() => {
      // Content (2) + footer (1) = 3 rows.
      expect(globalTableRowCount(container)).toBe(3);
    });

    const tableText = container.querySelector("[data-testid='table-global-links']")!.textContent ?? "";
    expect(tableText).toContain("Footer");
  });

  it("enabling both Navigation and Footer shows all four edges", async () => {
    const { container } = renderPage();
    await openTable(container);

    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid='switch-placement-nav']")!);
    });
    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid='switch-placement-footer']")!);
    });

    await waitFor(() => {
      // Content (2) + nav (1) + footer (1) = 4 rows.
      expect(globalTableRowCount(container)).toBe(4);
    });
  });

  it("disabling Navigation after enabling removes nav rows again", async () => {
    const { container } = renderPage();
    await openTable(container);

    const navSwitch = container.querySelector("[data-testid='switch-placement-nav']")!;

    // Enable.
    await act(async () => { fireEvent.click(navSwitch); });
    await waitFor(() => { expect(globalTableRowCount(container)).toBe(3); });

    // Disable.
    await act(async () => { fireEvent.click(navSwitch); });
    await waitFor(() => { expect(globalTableRowCount(container)).toBe(2); });
  });

  it("placement switches work the same after a Map → Table round-trip", async () => {
    const { container } = renderPage();

    // Map → Table → Map → Table (ensures state is preserved across remounts).
    await openTable(container);
    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid='button-global-view-map']")!);
    });
    await waitFor(() => {
      expect(container.querySelector("[data-testid='table-global-links']")).toBeNull();
    });
    await openTable(container);

    // Nav should still be off; 2 content rows.
    expect(globalTableRowCount(container)).toBe(2);

    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid='switch-placement-nav']")!);
    });
    await waitFor(() => { expect(globalTableRowCount(container)).toBe(3); });
  });
});
