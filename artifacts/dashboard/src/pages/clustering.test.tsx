// @ts-nocheck
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
import { render, screen, fireEvent } from "@testing-library/react";
import { ExpandedClusterDetail } from "./clustering";
import { KeywordCluster, KeywordState } from "@workspace/api-client-react";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("ExpandedClusterDetail", () => {
  it("renders a new-format keyword correctly, displaying query, actual serpUrls, and formatting metrics including legacy state gracefully", () => {
    const cluster = {
      id: 1,
      clusterKey: 1,
      topic: "SEO Topics",
      quadrant: "opportunities" as const,
      isOutlier: false,
      keywordCount: 1,
      totalClicks: 15,
      totalImpressions: 200,
      blendedCtr: 7.5,
      avgPosition: 3,
      coreSimilarity: 0.5,
      coreTag: "core",
      keywords: [
        {
          query: "how to do seo",
          clicks: 10,
          impressions: 100,
          ctr: 0.1, // 10%
          position: 2.5,
          state: KeywordState.rising,
          priorClicks: 5,
          priorImpressions: 50,
          priorCtr: 0.1,
          priorPosition: 3.5,
          clickDelta: 1,
          clickDeltaAbs: 5,
          impressionDelta: 1,
          impressionDeltaAbs: 50,
          serpUrls: [
            { url: "https://example.com/seo", position: 1 },
            { url: "https://example.com/other", position: 2 },
          ]
        },
        {
          query: "new keyword",
          clicks: 5,
          impressions: 100,
          ctr: 0.05,
          position: 5,
          state: KeywordState.new,
          priorClicks: 0,
          priorImpressions: 0,
          priorCtr: 0,
          priorPosition: 0,
          clickDelta: null,
          clickDeltaAbs: 5,
          impressionDelta: null,
          impressionDeltaAbs: 100,
          serpUrls: []
        },
        {
          query: "legacy keyword",
          clicks: 5,
          impressions: 100,
          ctr: 0.05, // 5%
          position: 5,
          state: undefined,
          serpUrls: []
        }
      ],
      ownUrls: [{ url: "https://mysite.com/seo", domain: "mysite.com", keywordCount: 2 }],
      competitorUrls: [{ url: "https://example.com/seo", domain: "example.com", keywordCount: 2 }]
    } as unknown as KeywordCluster;

    render(
      <TooltipProvider>
        <ExpandedClusterDetail cluster={cluster} />
      </TooltipProvider>
    );

    // Renders the full query
    expect(screen.getByText("how to do seo")).toBeInTheDocument();
    
    // Renders the serpUrls
    const seoLinks = screen.getAllByText("https://example.com/seo");
    expect(seoLinks.length).toBeGreaterThan(0);
    expect(seoLinks[0]).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/other")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();

    // Renders the percentages properly (clickDelta = 1 -> 100.0%)
    const textNodes = screen.getAllByText("+100.0%");
    expect(textNodes.length).toBeGreaterThan(0); // at least click and impression deltas

    // Renders the absolute deltas
    expect(screen.getAllByText("(+5)")[0]).toBeInTheDocument();
    expect(screen.getByText("(+50)")).toBeInTheDocument();

    // Renders the CTR properly (fraction converted to %)
    expect(screen.getByText("10.0%")).toBeInTheDocument();
    expect(screen.getByText("prev 10.0%")).toBeInTheDocument();
    
    // Renders the legacy keyword query
    expect(screen.getByText("legacy keyword")).toBeInTheDocument();
    // Legacy keyword should have a "-" for state
    expect(screen.getByText("-")).toBeInTheDocument();
    
    // Renders the new keyword query
    expect(screen.getByText("new keyword")).toBeInTheDocument();
    // It should have the "New" badge for state
    expect(screen.getAllByText("New")[0]).toBeInTheDocument();
    // It should have the "New" text for missing ratio
    expect(screen.getAllByText("New")[1]).toBeInTheDocument();
    
    // Renders own URLs and competitor URLs
    expect(screen.getByText("https://mysite.com/seo")).toBeInTheDocument();

    // Test formatting of state
    expect(screen.getByText("Rising")).toBeInTheDocument();
  });
});
