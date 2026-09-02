import { describe, expect, it } from "vitest";
import {
  SAFE_GROUNDING_REFUSAL,
  validateGroundedAnswer,
  type EvidenceCapability,
  type SeoEvidence,
} from "./gscEvidence";

const evidence: SeoEvidence[] = [{
  id: "GSC-TOTALS",
  source: "Google Search Console",
  property: "sc-domain:example.com",
  filters: { page: null, country: "all", searchType: "web" },
  dateRange: { startDate: "2026-08-01", endDate: "2026-08-28" },
  freshness: "Queried for the selected range; GSC normally lags by about 48 hours.",
  rows: [{ clicks: 13, impressions: 200, ctr: 0.065 }],
  claimFields: [
    { path: "rows.**.clicks", capability: "search-performance", metric: "clicks" },
    { path: "rows.**.impressions", capability: "search-performance", metric: "impressions" },
    { path: "rows.**.ctr", capability: "search-performance", metric: "ctr" },
  ],
}, {
  id: "BING-WEBMASTER",
  source: "Bing Webmaster",
  property: "example.com",
  filters: { page: null },
  dateRange: { startDate: "2026-08-18", endDate: "2026-08-25" },
  freshness: "Latest synced weekly bucket.",
  rows: [{ clicks: 4, impressions: 80 }],
  claimFields: [
    { path: "rows.**.clicks", capability: "bing-performance", metric: "clicks" },
    { path: "rows.**.impressions", capability: "bing-performance", metric: "impressions" },
  ],
  limitation: "Weekly performance only; not Bing indexing evidence.",
}];

function answer(claims: unknown[]): string {
  return JSON.stringify({ claims });
}

function fact(
  text: string,
  capability: EvidenceCapability,
  metric: string,
  id = "GSC-TOTALS",
  path = "rows.0.clicks",
): string {
  return answer([{
    kind: "Fact",
    text,
    capability,
    metric,
    evidence: [{ id, path }],
  }]);
}

describe("validateGroundedAnswer", () => {
  it("accepts and renders a structured fact tied to an exact field", () => {
    expect(validateGroundedAnswer(
      fact("GSC recorded 13 clicks.", "search-performance", "clicks"),
      evidence,
    )).toEqual({
      ok: true,
      citedIds: ["GSC-TOTALS"],
      answer: "**Fact:** GSC recorded 13 clicks. [GSC-TOTALS#rows.0.clicks]",
    });
  });

  it("accepts a calculation only when its exact inputs are supplied", () => {
    const result = validateGroundedAnswer(answer([{
      kind: "Calculation",
      text: "GSC CTR was 6.5%.",
      capability: "search-performance",
      metric: "ctr",
      evidence: [{ id: "GSC-TOTALS", path: "rows.0.ctr" }],
      calculation: {
        formula: "clicks / impressions",
        inputs: [
          { id: "GSC-TOTALS", path: "rows.0.clicks" },
          { id: "GSC-TOTALS", path: "rows.0.impressions" },
        ],
      },
    }]), evidence);
    expect(result.ok).toBe(true);
  });

  it("rejects plain prose and invented evidence ids", () => {
    expect(validateGroundedAnswer("GSC recorded 13 clicks.", evidence).ok).toBe(false);
    const result = validateGroundedAnswer(
      fact("GSC recorded 13 clicks.", "search-performance", "clicks", "MADE-UP"),
      evidence,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("claim_0_evidence_0_unknown_id");
  });

  it("rejects a hallucinated number even with a valid field pointer", () => {
    const result = validateGroundedAnswer(
      fact("GSC recorded 99 clicks.", "search-performance", "clicks"),
      evidence,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("claim_0_numeric_value_not_supported");
  });

  it("rejects swapping a real value onto the wrong metric", () => {
    const result = validateGroundedAnswer(
      fact("GSC recorded 200 clicks.", "search-performance", "clicks", "GSC-TOTALS", "rows.0.impressions"),
      evidence,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("claim_0_metric_not_supported");
  });

  it("rejects Bing indexing claims cited to Bing performance", () => {
    const result = validateGroundedAnswer(
      fact("Bing indexing is healthy.", "bing-indexing", "index-status", "BING-WEBMASTER", "rows.0.clicks"),
      evidence,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("claim_0_capability_not_supported");
      expect(result.errors).toContain("claim_0_bing_indexing_capability_mismatch");
    }
  });

  it("rejects a page-indexed fact without URL Inspection evidence", () => {
    const result = validateGroundedAnswer(
      fact("This page is indexed.", "url-index-status", "index-status", "BING-WEBMASTER", "rows.0.clicks"),
      evidence,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("claim_0_url_index_status_capability_mismatch");
  });

  it("rejects Copilot and GA4 claims cited to search performance", () => {
    const copilot = validateGroundedAnswer(
      fact("Copilot visibility improved.", "copilot-citations", "citations"),
      evidence,
    );
    const ga4 = validateGroundedAnswer(
      fact("GA4 engagement improved.", "analytics", "engagement-rate"),
      evidence,
    );
    expect(copilot.ok).toBe(false);
    expect(ga4.ok).toBe(false);
  });

  it("rejects qualitative facts that cite a field but do not name its metric", () => {
    const result = validateGroundedAnswer(answer([{
      kind: "Fact",
      text: "SEO health is good.",
      capability: "search-performance",
      metric: "clicks",
      evidence: [{ id: "GSC-TOTALS", path: "rows.0.clicks" }],
    }]), evidence);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("claim_0_metric_not_named");
  });

  it("never includes rejected model text in the fixed user response", () => {
    const rejectedDraft = "Bing indexing is healthy.";
    expect(SAFE_GROUNDING_REFUSAL).not.toContain(rejectedDraft);
    expect(SAFE_GROUNDING_REFUSAL).not.toContain("Grounding issues");
  });

  it("rejects empty answers", () => {
    expect(validateGroundedAnswer("", evidence).ok).toBe(false);
  });
});