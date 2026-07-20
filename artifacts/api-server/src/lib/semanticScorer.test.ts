import { describe, it, expect } from "vitest";
import {
  cosineSim,
  authorityScore,
  anchorFitScore,
  freshnessScore,
  combineScore,
  tierAllowed,
  tierPair,
  isBannedAnchor,
  buildWhyLine,
} from "./semanticScorer";

describe("cosineSim", () => {
  it("returns 0 for null, empty, or mismatched-length vectors", () => {
    expect(cosineSim(null, [1, 2])).toBe(0);
    expect(cosineSim([1, 2], null)).toBe(0);
    expect(cosineSim([], [])).toBe(0);
    expect(cosineSim([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 1 for identical vectors and -1 for opposite vectors", () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("returns 0 for orthogonal vectors and for zero vectors", () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });
});

describe("authorityScore", () => {
  it("returns 0 when maxInbound is 0 or negative", () => {
    expect(authorityScore(5, 0)).toBe(0);
    expect(authorityScore(5, -1)).toBe(0);
  });

  it("returns 1 when inbound equals the max and scales logarithmically below", () => {
    expect(authorityScore(10, 10)).toBeCloseTo(1, 10);
    const mid = authorityScore(3, 10);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // log scaling: 3-of-10 is well above 0.3 linearly
    expect(mid).toBeGreaterThan(0.3);
  });

  it("caps at 1 even if inbound exceeds max", () => {
    expect(authorityScore(100, 10)).toBe(1);
  });
});

describe("anchorFitScore", () => {
  it("returns 0 for missing anchor or body", () => {
    expect(anchorFitScore("", "body")).toBe(0);
    expect(anchorFitScore("anchor", null)).toBe(0);
  });

  it("returns 1 when the exact anchor appears in the body (case-insensitive)", () => {
    expect(anchorFitScore("Internal Linking", "a guide to internal linking today")).toBe(1);
  });

  it("returns partial token overlap otherwise (tokens > 3 chars)", () => {
    // tokens: "semantic", "linking" — only "linking" appears
    expect(anchorFitScore("semantic linking", "all about linking pages")).toBeCloseTo(0.5);
  });

  it("returns 0 when no usable tokens exist", () => {
    expect(anchorFitScore("a of it", "some body text")).toBe(0);
  });
});

describe("freshnessScore", () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

  it("returns 0.2 when no date is available", () => {
    expect(freshnessScore(null)).toBe(0.2);
    expect(freshnessScore(undefined)).toBe(0.2);
  });

  it("bands by age: <30d=1, <90d=0.8, <180d=0.6, <365d=0.4, else 0.2", () => {
    expect(freshnessScore(daysAgo(5))).toBe(1);
    expect(freshnessScore(daysAgo(60))).toBe(0.8);
    expect(freshnessScore(daysAgo(120))).toBe(0.6);
    expect(freshnessScore(daysAgo(300))).toBe(0.4);
    expect(freshnessScore(daysAgo(500))).toBe(0.2);
  });
});

describe("combineScore", () => {
  it("weights 50/20/20/10", () => {
    expect(
      combineScore({ similarity: 1, authority: 1, anchorFit: 1, freshness: 1 }),
    ).toBeCloseTo(1, 10);
    expect(
      combineScore({ similarity: 1, authority: 0, anchorFit: 0, freshness: 0 }),
    ).toBeCloseTo(0.5, 10);
    expect(
      combineScore({ similarity: 0, authority: 1, anchorFit: 0, freshness: 1 }),
    ).toBeCloseTo(0.3, 10);
  });
});

describe("tierAllowed", () => {
  it("allows the SOP tier flows", () => {
    for (const [d, r] of [
      [4, 2], [4, 3], [3, 2], [3, 3], [3, 1], [2, 1], [2, 2], [2, 3], [1, 1], [1, 2],
    ] as const) {
      expect(tierAllowed(d, r)).toBe(true);
    }
  });

  it("rejects disallowed flows (e.g. deep pages linking to T4, T1->T3, T4->T1)", () => {
    expect(tierAllowed(1, 4)).toBe(false);
    expect(tierAllowed(2, 4)).toBe(false);
    expect(tierAllowed(1, 3)).toBe(false);
    expect(tierAllowed(4, 1)).toBe(false);
    expect(tierAllowed(4, 4)).toBe(false);
  });
});

describe("tierPair", () => {
  it("formats tiers and uses ? for unknown", () => {
    expect(tierPair(4, 2)).toBe("T4->T2");
    expect(tierPair(null, 2)).toBe("T?->T2");
    expect(tierPair(3, null)).toBe("T3->T?");
  });
});

describe("isBannedAnchor", () => {
  it("bans generic anchors regardless of case/whitespace", () => {
    expect(isBannedAnchor("click here")).toBe(true);
    expect(isBannedAnchor("  Read More ")).toBe(true);
    expect(isBannedAnchor("LEARN MORE")).toBe(true);
  });

  it("bans raw URLs and over-long anchors", () => {
    expect(isBannedAnchor("https://example.com/page")).toBe(true);
    expect(isBannedAnchor("one two three four five six seven eight nine")).toBe(true);
  });

  it("bans single very short words but allows real anchors", () => {
    expect(isBannedAnchor("ai")).toBe(true);
    expect(isBannedAnchor("semantic internal linking")).toBe(false);
    expect(isBannedAnchor("keyword research")).toBe(false);
  });
});

describe("buildWhyLine", () => {
  const empty = { similarity: null, authority: null, anchorFit: null, freshness: null };

  it("returns null when every sub-score is missing (legacy rows)", () => {
    expect(buildWhyLine(empty, "T3->T2")).toBeNull();
    expect(buildWhyLine(empty, null)).toBeNull();
  });

  it("describes similarity with bands calibrated for compressed embedding cosines", () => {
    expect(buildWhyLine({ ...empty, similarity: 0.75 }, null)).toContain(
      "very closely related topics",
    );
    expect(buildWhyLine({ ...empty, similarity: 0.6 }, null)).toContain(
      "closely related topics",
    );
    expect(buildWhyLine({ ...empty, similarity: 0.45 }, null)).toContain(
      "related topics",
    );
    expect(buildWhyLine({ ...empty, similarity: 0.3 }, null)).toContain(
      "loosely related topics",
    );
    expect(buildWhyLine({ ...empty, similarity: 0.6 }, null)).toContain("60% topic match");
  });

  it("explains the tier flow for both -> and → separators", () => {
    const a = buildWhyLine({ ...empty, similarity: 0.5 }, "T4->T2");
    expect(a).toContain("from a deep-dive article to a pillar (hub) page");
    const b = buildWhyLine({ ...empty, similarity: 0.5 }, "T3 → T1");
    expect(b).toContain("from a supporting article to a key landing page");
  });

  it("skips the tier sentence when a tier is unknown or malformed", () => {
    expect(buildWhyLine({ ...empty, similarity: 0.5 }, "T?->T2")).not.toContain("The link goes");
    expect(buildWhyLine({ ...empty, similarity: 0.5 }, "hub->spoke")).not.toContain(
      "The link goes",
    );
  });

  it("describes low and high authority, and stays silent in the middle band", () => {
    expect(buildWhyLine({ ...empty, authority: 0.1 }, null)).toContain("real boost");
    expect(buildWhyLine({ ...empty, authority: 0.9 }, null)).toContain(
      "already attracts many internal links",
    );
    expect(buildWhyLine({ ...empty, authority: 0.5 }, null)).toBeNull();
  });

  it("describes anchor fit bands", () => {
    expect(buildWhyLine({ ...empty, anchorFit: 0.9 }, null)).toContain(
      "already appears naturally",
    );
    expect(buildWhyLine({ ...empty, anchorFit: 0.5 }, null)).toContain(
      "Most of the anchor's words",
    );
    expect(buildWhyLine({ ...empty, anchorFit: 0.2 }, null)).toBeNull();
  });

  it("mentions freshness only when the source page is recent", () => {
    expect(buildWhyLine({ ...empty, freshness: 1 }, null)).toContain("updated recently");
    expect(buildWhyLine({ ...empty, freshness: 0.4 }, null)).toBeNull();
  });

  it("joins multiple sentences into one line", () => {
    const line = buildWhyLine(
      { similarity: 0.72, authority: 0.1, anchorFit: 0.85, freshness: 1 },
      "T4->T2",
    );
    expect(line).toBeTruthy();
    expect(line).toContain("very closely related topics");
    expect(line).toContain("deep-dive article");
    expect(line).toContain("real boost");
    expect(line).toContain("appears naturally");
    expect(line).toContain("updated recently");
  });
});
