import { describe, expect, it } from "vitest";
import {
  CLUSTER_SIMILARITY_THRESHOLD,
  matchSimilarPagesByPillar,
  type EmbeddedSitePage,
} from "./topicalMapSimilarPages";

function unitVector(x: number): number[] {
  return [x, Math.sqrt(1 - x * x)];
}

describe("matchSimilarPagesByPillar", () => {
  const pages: EmbeddedSitePage[] = [
    { path: "/anchor/", title: "Anchor", embedding: [1, 0] },
    { path: "/strong/", title: "Strong", embedding: unitVector(0.8) },
    { path: "/threshold/", title: "Threshold", embedding: unitVector(0.42) },
    { path: "/unrelated/", title: "Unrelated", embedding: unitVector(0.41) },
  ];

  it("includes every page at or above the related-page threshold in score order", () => {
    const result = matchSimilarPagesByPillar(
      [{ nodeId: 1, anchorPaths: ["/anchor/"] }],
      pages,
    );

    expect(result.get(1)).toEqual([
      { path: "/anchor/", title: "Anchor", similarity: 1 },
      { path: "/strong/", title: "Strong", similarity: 0.8 },
      { path: "/threshold/", title: "Threshold", similarity: 0.42 },
    ]);
    expect(CLUSTER_SIMILARITY_THRESHOLD).toBe(0.42);
  });

  it("deduplicates canonical paths and keeps their strongest cosine score", () => {
    const result = matchSimilarPagesByPillar(
      [{ nodeId: 1, anchorPaths: ["/anchor/"] }],
      [
        ...pages,
        { path: "/strong/", title: null, embedding: unitVector(0.9) },
      ],
    );

    expect(result.get(1)?.filter((page) => page.path === "/strong/")).toEqual([
      { path: "/strong/", title: "Strong", similarity: 0.9 },
    ]);
  });

  it("allows a page to appear in every pillar whose anchors clear the threshold", () => {
    const result = matchSimilarPagesByPillar(
      [
        { nodeId: 1, anchorPaths: ["/anchor/"] },
        { nodeId: 2, anchorPaths: ["/strong/"] },
      ],
      pages,
    );

    expect(result.get(1)?.some((page) => page.path === "/strong/")).toBe(true);
    expect(result.get(2)?.some((page) => page.path === "/strong/")).toBe(true);
  });

  it("returns no related pages when a pillar has no embedded anchor", () => {
    const result = matchSimilarPagesByPillar(
      [{ nodeId: 1, anchorPaths: ["/missing/"] }],
      pages,
    );

    expect(result.get(1)).toEqual([]);
  });
});