import { describe, expect, it } from "vitest";
import { estimateUsTrafficPotential } from "../jobs/enrichTopicalMapDemand";
import { balanceOpportunityFunnelStages } from "./topicalMapFunnelBalance";

describe("topical-map demand planning", () => {
  it("estimates monthly US traffic at the documented 20% target CTR", () => {
    expect(estimateUsTrafficPotential(1_000)).toBe(200);
    expect(estimateUsTrafficPotential(333)).toBe(67);
    expect(estimateUsTrafficPotential(null)).toBeNull();
    expect(estimateUsTrafficPotential(null, true)).toBe(0);
  });

  it("balances flexible opportunities across TOFU, MOFU, and BOFU", () => {
    const assignments = balanceOpportunityFunnelStages(
      Array.from({ length: 9 }, (_, id) => ({
        id,
        intent: id % 3 === 0 ? "informational" : id % 3 === 1 ? "commercial" : "transactional",
        predicate: id % 3 === 0 ? "how-to guide" : id % 3 === 1 ? "best comparison" : "pricing tool",
        pageType: "article",
        funnelStage: id % 3 === 0 ? "tofu" : id % 3 === 1 ? "mofu" : "bofu",
      })),
    );
    const counts = { tofu: 0, mofu: 0, bofu: 0 };
    for (const stage of assignments.values()) counts[stage]++;
    expect(counts).toEqual({ tofu: 3, mofu: 3, bofu: 3 });
  });

  it("does not force an educational topic into BOFU merely to fill a quota", () => {
    const assignments = balanceOpportunityFunnelStages([
      {
        id: 1,
        intent: "informational",
        predicate: "what-is guide",
        pageType: "glossary",
        funnelStage: "tofu",
      },
    ]);
    expect(assignments.get(1)).toBe("tofu");
  });
});