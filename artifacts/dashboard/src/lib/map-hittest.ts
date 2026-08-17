/**
 * Pure hit-test utility for the topical-map canvas.
 *
 * Extracted from the inline `findNode` closure so the ghost-node skip logic
 * can be unit-tested without a DOM or a D3 zoom transform.
 *
 * Callers are responsible for inverting canvas pixel coordinates to world
 * coordinates before passing them here (via `d3.ZoomTransform.invert`).
 */

export interface HitTestNode {
  id: number;
  x: number;
  y: number;
  r: number;
  status: string;
  priority: string;
}

/**
 * Returns the closest visible node whose hit area (radius + 6-world-unit
 * touch-target padding) contains the given world-space point, or `undefined`
 * when no visible node is hit.
 *
 * Ghost nodes — those filtered out by `statusFilter` or `priorityFilter` —
 * are unconditionally skipped so they can never steal a click or hover from
 * a visible node behind them.
 */
export function hitTestNodes<T extends HitTestNode>(
  /** World-space X (canvas coordinate already inverted through the zoom transform). */
  x: number,
  /** World-space Y. */
  y: number,
  /** Current zoom scale `k` from the D3 transform (used to scale the touch padding). */
  k: number,
  nodes: T[],
  statusFilter: Record<string, boolean>,
  priorityFilter: Record<string, boolean>,
): T | undefined {
  let best: T | undefined;
  let bestDist = Infinity;

  for (const n of nodes) {
    // Ghost nodes are invisible and must not receive pointer events.
    if (!statusFilter[n.status] || !priorityFilter[n.priority]) continue;

    const dist = Math.hypot(n.x - x, n.y - y);
    if (dist <= n.r + 6 / k && dist < bestDist) {
      best = n;
      bestDist = dist;
    }
  }

  return best;
}

/**
 * Resolves the next `selectedNodeId` value after a canvas click.
 *
 * Returns the hit node's `id` when a visible topic node was clicked, or `null`
 * when the click missed every node — for example when the user clicks the
 * central-entity hub circle drawn at world origin (0, 0), which has no
 * corresponding `LaidOutNode` entry and therefore makes `hitTestNodes` return
 * `undefined`.  A `null` result tells the caller to close the detail panel.
 *
 * Extracting this one-liner into a named function makes the "hub click closes
 * the panel" contract unit-testable without a DOM or a D3 event.
 */
export function resolveClickSelection(hit: HitTestNode | undefined): number | null {
  return hit !== undefined ? hit.id : null;
}
