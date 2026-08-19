import { describe, expect, it } from "vitest";
import {
  estimateClusterSerpCostCents,
  SERP_PRICE_MICRODOLLARS_PER_KEYWORD,
} from "./clustering";

describe("cluster SERP estimate", () => {
  it("has one provider price rule", () => {
    expect(SERP_PRICE_MICRODOLLARS_PER_KEYWORD).toBe(600);
  });

  it.each([
    [10, 1],
    [16, 1],
    [17, 2],
    [250, 15],
    [1000, 60],
  ])("rounds %i keywords up to %i cents", (keywordCount, expectedCents) => {
    expect(estimateClusterSerpCostCents(keywordCount)).toBe(expectedCents);
  });
});