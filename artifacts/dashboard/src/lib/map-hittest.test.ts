import { describe, expect, it } from "vitest";
import { hitTestNodes, resolveClickSelection, resolveHoverTransition, type HitTestNode } from "./map-hittest";

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

// ---------------------------------------------------------------------------
// Central-entity hub node at (0,0)
//
// The central entity is drawn as a static decorative circle at world origin
// (0, 0). It has NO corresponding LaidOutNode entry in the nodes array that
// hitTestNodes searches. Clicking exactly on it must therefore return
// undefined so the onClick handler calls setSelectedNodeId(null) — closing
// any open detail panel — rather than crashing or showing a stale selection.
// ---------------------------------------------------------------------------

describe("hitTestNodes — central-entity hub node at (0,0)", () => {
  it("returns undefined for a click at (0,0) when the node list is empty (identity transform)", () => {
    // The central hub is not in the nodes list; clicking it must not crash.
    expect(hitTestNodes(0, 0, K, [], ALL_VISIBLE, ALL_PRIORITIES)).toBeUndefined();
  });

  it("returns undefined for a click at (0,0) when all nodes are positioned away from origin", () => {
    // Nodes exist but none overlap the hub; clicking the hub returns undefined.
    const nodes = [
      node({ id: 1, x: 200, y: 100, r: 12 }),
      node({ id: 2, x: -150, y: 80, r: 10 }),
    ];
    expect(hitTestNodes(0, 0, K, nodes, ALL_VISIBLE, ALL_PRIORITIES)).toBeUndefined();
  });

  it("does NOT return undefined when a real topic node is placed at the origin", () => {
    // Edge-case: a topic node coincidentally placed at (0,0) should still be
    // found (the hub circle doesn't 'block' the hit-test).
    const n = node({ id: 42, x: 0, y: 0, r: 8 });
    const result = hitTestNodes(0, 0, K, [n], ALL_VISIBLE, ALL_PRIORITIES);
    expect(result?.id).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// resolveClickSelection — panel-close on hub click
//
// The onClick handler in topical-map.tsx calls resolveClickSelection(hit) to
// derive the next selectedNodeId. When the user clicks the central-entity hub
// at (0,0) — which has no LaidOutNode — hitTestNodes returns undefined and
// resolveClickSelection must return null so the detail panel closes cleanly
// rather than leaving a stale selection on screen.
// ---------------------------------------------------------------------------

describe("resolveClickSelection — panel closes when hub is clicked", () => {
  it("returns null when no node was hit (central-entity hub click)", () => {
    expect(resolveClickSelection(undefined)).toBe(null);
  });

  it("closes a previously open detail panel: undefined hit clears a stale selection", () => {
    // Simulate: panel was open showing node 42, user clicks the hub.
    // The full chain: hub click → hitTestNodes(0,0, identity, []) → undefined
    //                          → resolveClickSelection(undefined) → null
    const priorSelection = 42; // panel was open
    const hit = hitTestNodes(0, 0, K, [], ALL_VISIBLE, ALL_PRIORITIES); // hub → undefined
    const next = resolveClickSelection(hit);
    expect(next).toBe(null);
    expect(next).not.toBe(priorSelection); // stale selection is gone
  });

  it("does not throw when the hit is undefined (no crash on hub click)", () => {
    expect(() => resolveClickSelection(undefined)).not.toThrow();
  });

  it("returns the hit node's id when a real topic node is clicked", () => {
    const n = node({ id: 7, x: 50, y: 50, r: 8 });
    const hit = hitTestNodes(50, 50, K, [n], ALL_VISIBLE, ALL_PRIORITIES);
    expect(resolveClickSelection(hit)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// resolveHoverTransition — hub area hover transitions
//
// topical-map.tsx onMove calls resolveHoverTransition(hit, hoverRef.current)
// and only writes cursor + calls draw() when didChange is true.
//
// The central-entity hub circle is drawn at world-space origin (0, 0) but has
// NO corresponding LaidOutNode, so hitTestNodes always returns undefined for
// coordinates inside the hub.  The critical contracts are:
//
//   1. null → null (open space / hub → hub): didChange=false, no redraw.
//   2. nodeId → null (node → hub):           didChange=true, cursor="grab".
//   3. null → nodeId (hub → node):           didChange=true, cursor="pointer".
//   4. Repeated hub moves after null is set: didChange=false every time.
// ---------------------------------------------------------------------------

describe("resolveHoverTransition — hub area hover transitions", () => {
  const NODES_AWAY = [
    node({ id: 1, x: 200, y: 100, r: 12 }),
    node({ id: 2, x: -150, y: 80, r: 10 }),
  ];

  it("cursor already over open space → enters hub → didChange=false (null stays null, no redraw)", () => {
    // Prior hover: null (open space). Cursor moves to hub at (0,0).
    // hitTestNodes returns undefined because hub has no LaidOutNode.
    const hit = hitTestNodes(0, 0, K, NODES_AWAY, ALL_VISIBLE, ALL_PRIORITIES);
    const result = resolveHoverTransition(hit, null);
    expect(result.nextHoverId).toBeNull();
    expect(result.didChange).toBe(false);
  });

  it("cursor over hub → subsequent move still inside hub → didChange=false (no extra redraw)", () => {
    // hoverRef is already null (entered hub in a prior move). Another move
    // within the hub must not trigger a second draw().
    const hit = hitTestNodes(3, 4, K, NODES_AWAY, ALL_VISIBLE, ALL_PRIORITIES);
    const result = resolveHoverTransition(hit, null); // currentHoverId already null
    expect(result.nextHoverId).toBeNull();
    expect(result.didChange).toBe(false);
  });

  it("cursor over a topic node → enters hub → didChange=true, cursor='grab'", () => {
    // Prior hover: node 1. Cursor drifts into hub area.
    const hit = hitTestNodes(0, 0, K, NODES_AWAY, ALL_VISIBLE, ALL_PRIORITIES);
    const result = resolveHoverTransition(hit, 1 /* prior hover node id */);
    expect(result.nextHoverId).toBeNull();
    expect(result.didChange).toBe(true);
    expect(result.cursor).toBe("grab"); // must NOT be "pointer" over hub
  });

  it("cursor over hub → exits onto a topic node → didChange=true, cursor='pointer'", () => {
    // Prior hover: null (was over hub). Cursor moves onto node 1 at (200,100).
    const hit = hitTestNodes(200, 100, K, NODES_AWAY, ALL_VISIBLE, ALL_PRIORITIES);
    const result = resolveHoverTransition(hit, null);
    expect(result.nextHoverId).toBe(1);
    expect(result.didChange).toBe(true);
    expect(result.cursor).toBe("pointer");
  });

  it("cursor is never 'pointer' while it remains inside the hub area", () => {
    // Five positions inside the hub — none overlap the displaced nodes.
    const hubPositions: [number, number][] = [
      [0, 0], [2, 3], [-4, 1], [0, 5], [-3, -3],
    ];
    for (const [x, y] of hubPositions) {
      const hit = hitTestNodes(x, y, K, NODES_AWAY, ALL_VISIBLE, ALL_PRIORITIES);
      const result = resolveHoverTransition(hit, null);
      expect(result.cursor).toBe("grab");
    }
  });

  it("exactly one didChange=true when hover transitions node→hub; subsequent hub moves are didChange=false", () => {
    // Verifies the real production guard prevents spurious extra redraws
    // when the cursor continues to drift within the hub after the first entry.
    let drawCount = 0;
    let currentHoverId: number | null = 2; // was hovering node 2

    // Move 1: onto hub at (0,0)
    const hit1 = hitTestNodes(0, 0, K, NODES_AWAY, ALL_VISIBLE, ALL_PRIORITIES);
    const t1 = resolveHoverTransition(hit1, currentHoverId);
    if (t1.didChange) { drawCount++; currentHoverId = t1.nextHoverId; }

    // Move 2: still inside hub at (1,1)
    const hit2 = hitTestNodes(1, 1, K, NODES_AWAY, ALL_VISIBLE, ALL_PRIORITIES);
    const t2 = resolveHoverTransition(hit2, currentHoverId);
    if (t2.didChange) { drawCount++; currentHoverId = t2.nextHoverId; }

    // Move 3: still inside hub at (-2,2)
    const hit3 = hitTestNodes(-2, 2, K, NODES_AWAY, ALL_VISIBLE, ALL_PRIORITIES);
    const t3 = resolveHoverTransition(hit3, currentHoverId);
    if (t3.didChange) { drawCount++; currentHoverId = t3.nextHoverId; }

    // Only the first entry (node→null) should have triggered a redraw.
    expect(drawCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: full onClick chain in topical-map.tsx
//
// topical-map.tsx onClick handler does:
//   const [mx, my] = d3.pointer(ev, canvas);
//   const n = findNode(mx, my);           // hitTestNodes after transform.invert
//   setSelectedNodeId(resolveClickSelection(n));
//
// The canvas is initialised with:
//   zoom.transform → d3.zoomIdentity.translate(width/2, height/2).scale(0.85)
//
// Inverting canvas-centre pixel coords (width/2, height/2) through that
// transform always yields world origin (0, 0) — the hub position — regardless
// of canvas dimensions:
//
//   invert([px, py]) = [(px − tx) / k, (py − ty) / k]
//                    = [(w/2 − w/2) / 0.85, (h/2 − h/2) / 0.85]
//                    = [0, 0]
//
// The hub has no LaidOutNode in the nodes array, so hitTestNodes(0, 0, …)
// returns undefined, and resolveClickSelection(undefined) returns null —
// which is the value the handler passes to setSelectedNodeId.
//
// These tests verify the complete chain produces null starting from a
// non-null prior selection, confirming that clicking the hub clears any
// stale highlighted ring in the canvas re-render.
// ---------------------------------------------------------------------------

describe("onClick integration — hub click clears stale node selection", () => {
  // Nodes placed at realistic radial-tree positions (radius ≈ 300 world units)
  // so none of them overlap the hub at world origin.
  const LAYOUT_NODES: HitTestNode[] = [
    node({ id: 1, x: 260, y: 150,   r: 10, status: "published", priority: "high" }),
    node({ id: 2, x: -130, y: 260,  r: 7,  status: "gap",       priority: "high" }),
    node({ id: 3, x: -300, y: 0,    r: 7,  status: "gap",       priority: "medium" }),
    node({ id: 4, x: 0,   y: -300,  r: 5,  status: "gap",       priority: "low" }),
    node({ id: 5, x: 130, y: -260,  r: 5,  status: "ignored",   priority: "low" }),
  ];

  // Simulate the default zoom transform's invert of canvas-centre.
  // Canvas dimensions don't matter — the math always yields (0, 0).
  function invertCanvasCentre(_width: number, _height: number, k: number): [number, number] {
    // translate(w/2, h/2).scale(k) → invert([w/2, h/2]) = (0, 0)
    // Computed explicitly so the expectation is obvious.
    const tx = _width / 2;
    const ty = _height / 2;
    const px = _width / 2;
    const py = _height / 2;
    return [(px - tx) / k, (py - ty) / k];
  }

  it("canvas-centre pixel coords invert to world origin (0,0) under the default transform", () => {
    const [wx, wy] = invertCanvasCentre(1200, 640, 0.85);
    expect(wx).toBeCloseTo(0);
    expect(wy).toBeCloseTo(0);
  });

  it("full chain: hub click → hitTestNodes(0,0) → undefined → resolveClickSelection → null", () => {
    const [wx, wy] = invertCanvasCentre(1200, 640, 0.85);
    const hit = hitTestNodes(wx, wy, 0.85, LAYOUT_NODES, ALL_VISIBLE, ALL_PRIORITIES);
    expect(hit).toBeUndefined(); // hub has no LaidOutNode
    const nextId = resolveClickSelection(hit);
    expect(nextId).toBeNull();
  });

  it("selectedNodeId transitions from a real node id to null after a hub click", () => {
    // Simulate: node 2 was clicked first (panel open), then user clicks hub.
    let selectedNodeId: number | null = null;

    // Step 1 — click on node 2 at (-130, 260): panel opens.
    const hit1 = hitTestNodes(-130, 260, 0.85, LAYOUT_NODES, ALL_VISIBLE, ALL_PRIORITIES);
    selectedNodeId = resolveClickSelection(hit1);
    expect(selectedNodeId).toBe(2); // panel is open

    // Step 2 — click at canvas centre → hub → panel must close.
    const [wx, wy] = invertCanvasCentre(1200, 640, 0.85);
    const hit2 = hitTestNodes(wx, wy, 0.85, LAYOUT_NODES, ALL_VISIBLE, ALL_PRIORITIES);
    selectedNodeId = resolveClickSelection(hit2);
    expect(selectedNodeId).toBeNull(); // stale ring is gone
  });

  it("selectedNodeId clears regardless of which node was previously selected", () => {
    for (const n of LAYOUT_NODES) {
      // Open the panel on this node.
      const hitOpen = hitTestNodes(n.x, n.y, 0.85, LAYOUT_NODES, ALL_VISIBLE, ALL_PRIORITIES);
      let selectedNodeId = resolveClickSelection(hitOpen);
      expect(selectedNodeId).toBe(n.id);

      // Click the hub — panel must close for every prior selection.
      const [wx, wy] = invertCanvasCentre(1200, 640, 0.85);
      const hitHub = hitTestNodes(wx, wy, 0.85, LAYOUT_NODES, ALL_VISIBLE, ALL_PRIORITIES);
      selectedNodeId = resolveClickSelection(hitHub);
      expect(selectedNodeId).toBeNull();
    }
  });

  it("hub click does not restore a previously cleared selection (idempotent)", () => {
    // Panel already closed (selectedNodeId is null). Clicking hub again must
    // keep it null — no accidental re-selection.
    let selectedNodeId: number | null = null;

    const [wx, wy] = invertCanvasCentre(1200, 640, 0.85);
    const hit = hitTestNodes(wx, wy, 0.85, LAYOUT_NODES, ALL_VISIBLE, ALL_PRIORITIES);
    selectedNodeId = resolveClickSelection(hit);
    expect(selectedNodeId).toBeNull();

    // Second hub click.
    const hit2 = hitTestNodes(wx, wy, 0.85, LAYOUT_NODES, ALL_VISIBLE, ALL_PRIORITIES);
    selectedNodeId = resolveClickSelection(hit2);
    expect(selectedNodeId).toBeNull();
  });

  it("hub click clears selection even when a ghost-filtered node overlaps origin", () => {
    // A low-priority ignored node placed exactly at origin (an extreme edge case).
    // It must be skipped by the ghost filter, keeping the hub miss.
    const ghostAtOrigin = node({ id: 99, x: 0, y: 0, r: 14, status: "ignored", priority: "low" });
    const nodesWithGhost = [...LAYOUT_NODES, ghostAtOrigin];
    const statusFilter = { published: true, gap: true, ignored: false };
    const priorityFilter = { high: true, medium: true, low: false };

    let selectedNodeId: number | null = 3; // panel open on node 3

    const hit = hitTestNodes(0, 0, 0.85, nodesWithGhost, statusFilter, priorityFilter);
    selectedNodeId = resolveClickSelection(hit);
    // Ghost was skipped; hub click still closes the panel.
    expect(selectedNodeId).toBeNull();
  });
});
