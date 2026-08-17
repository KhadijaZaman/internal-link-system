import { describe, expect, it } from "vitest";
import { hitTestNodes, type HitTestNode } from "./map-hittest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal HitTestNode at position (x, y) with radius r. */
function node(
  overrides: Partial<HitTestNode> & { id: number; x: number; y: number; r: number },
): HitTestNode {
  return {
    status: "gap",
    priority: "high",
    ...overrides,
  };
}

const ALL_VISIBLE = { published: true, gap: true, ignored: true };
const ALL_PRIORITIES = { high: true, medium: true, low: true };
const K = 1; // zoom scale = 1 (identity transform)

// ---------------------------------------------------------------------------
// Basic hit detection
// ---------------------------------------------------------------------------

describe("hitTestNodes — basic hit detection", () => {
  it("returns undefined when the node list is empty", () => {
    expect(hitTestNodes(0, 0, K, [], ALL_VISIBLE, ALL_PRIORITIES)).toBeUndefined();
  });

  it("returns undefined when the cursor is outside every node's hit area", () => {
    const nodes = [node({ id: 1, x: 100, y: 100, r: 5 })];
    // 6/k touch padding means effective radius is 11; cursor at (120,120) is ~28 px away
    expect(hitTestNodes(120, 120, K, nodes, ALL_VISIBLE, ALL_PRIORITIES)).toBeUndefined();
  });

  it("returns a node when the cursor is inside its radius", () => {
    const n = node({ id: 1, x: 50, y: 50, r: 8 });
    const result = hitTestNodes(52, 50, K, [n], ALL_VISIBLE, ALL_PRIORITIES);
    expect(result?.id).toBe(1);
  });

  it("returns a node when the cursor is within the 6-px touch-target padding beyond radius", () => {
    const n = node({ id: 1, x: 0, y: 0, r: 5 });
    // exactly at r + 6 / k = 11 world units away
    const result = hitTestNodes(11, 0, K, [n], ALL_VISIBLE, ALL_PRIORITIES);
    expect(result?.id).toBe(1);
  });

  it("returns undefined when the cursor is just beyond the touch target", () => {
    const n = node({ id: 1, x: 0, y: 0, r: 5 });
    // 11.1 > r + 6 / k
    expect(hitTestNodes(11.1, 0, K, [n], ALL_VISIBLE, ALL_PRIORITIES)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ghost-node skip: status filter
// ---------------------------------------------------------------------------

describe("hitTestNodes — ghost nodes filtered by status", () => {
  it("skips a node whose status is hidden by the filter", () => {
    const n = node({ id: 1, x: 0, y: 0, r: 10, status: "ignored" });
    const statusFilter = { published: true, gap: true, ignored: false }; // ignored is OFF
    expect(hitTestNodes(0, 0, K, [n], statusFilter, ALL_PRIORITIES)).toBeUndefined();
  });

  it("returns a visible node even when a ghost (status-filtered) sits at the same position", () => {
    const ghost = node({ id: 1, x: 0, y: 0, r: 10, status: "ignored" });
    const visible = node({ id: 2, x: 0, y: 0, r: 8, status: "gap" });
    const statusFilter = { published: true, gap: true, ignored: false };

    const result = hitTestNodes(0, 0, K, [ghost, visible], statusFilter, ALL_PRIORITIES);
    expect(result?.id).toBe(2);
  });

  it("returns the visible node regardless of node array order (ghost last)", () => {
    const visible = node({ id: 2, x: 0, y: 0, r: 8, status: "gap" });
    const ghost = node({ id: 1, x: 0, y: 0, r: 10, status: "ignored" });
    const statusFilter = { published: true, gap: true, ignored: false };

    const result = hitTestNodes(0, 0, K, [visible, ghost], statusFilter, ALL_PRIORITIES);
    expect(result?.id).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Ghost-node skip: priority filter
// ---------------------------------------------------------------------------

describe("hitTestNodes — ghost nodes filtered by priority", () => {
  it("skips a node whose priority is hidden by the filter", () => {
    const n = node({ id: 1, x: 0, y: 0, r: 10, priority: "low" });
    const priorityFilter = { high: true, medium: true, low: false }; // low is OFF
    expect(hitTestNodes(0, 0, K, [n], ALL_VISIBLE, priorityFilter)).toBeUndefined();
  });

  it("returns a high-priority visible node when a low-priority ghost overlaps it", () => {
    const ghost = node({ id: 1, x: 0, y: 0, r: 10, priority: "low" });
    const visible = node({ id: 2, x: 0, y: 0, r: 8, priority: "high" });
    const priorityFilter = { high: true, medium: true, low: false };

    const result = hitTestNodes(0, 0, K, [ghost, visible], ALL_VISIBLE, priorityFilter);
    expect(result?.id).toBe(2);
  });

  it("skips a node that is ghost by both status AND priority", () => {
    const ghost = node({ id: 1, x: 0, y: 0, r: 10, status: "ignored", priority: "low" });
    const statusFilter = { published: true, gap: true, ignored: false };
    const priorityFilter = { high: true, medium: true, low: false };

    expect(hitTestNodes(0, 0, K, [ghost], statusFilter, priorityFilter)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Closest-node wins (multiple overlapping visible nodes)
// ---------------------------------------------------------------------------

describe("hitTestNodes — closest visible node wins", () => {
  it("returns the closer of two overlapping visible nodes", () => {
    const far = node({ id: 1, x: 0, y: 0, r: 20 });  // 5 units away from cursor
    const near = node({ id: 2, x: 3, y: 0, r: 20 }); // 2 units away from cursor
    const result = hitTestNodes(5, 0, K, [far, near], ALL_VISIBLE, ALL_PRIORITIES);
    expect(result?.id).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Zoom scale affects touch-target padding
// ---------------------------------------------------------------------------

describe("hitTestNodes — zoom scale", () => {
  it("shrinks the touch-target padding when zoomed in (higher k)", () => {
    const n = node({ id: 1, x: 0, y: 0, r: 2 });
    // At k=1, effective radius = 2 + 6 = 8. At k=4, effective radius = 2 + 6/4 = 3.5.
    // Cursor at distance 5: hit at k=1, miss at k=4.
    expect(hitTestNodes(5, 0, 1, [n], ALL_VISIBLE, ALL_PRIORITIES)?.id).toBe(1);
    expect(hitTestNodes(5, 0, 4, [n], ALL_VISIBLE, ALL_PRIORITIES)).toBeUndefined();
  });
});
