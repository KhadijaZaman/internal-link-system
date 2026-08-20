import { describe, expect, it } from "vitest";
import type { TopicalMapNode } from "@workspace/api-client-react";
import {
  TOPICAL_MAP_EXPORT_HEADERS,
  buildTopicalMapExportRows,
  topicalMapExportTsv,
} from "./topical-map-export";

function node(
  overrides: Partial<TopicalMapNode>,
): TopicalMapNode {
  return {
    id: 1,
    mapId: 1,
    parentId: null,
    level: "pillar",
    section: "core",
    title: "Search visibility",
    canonicalQuery: "search visibility",
    attributeOwned: "visibility",
    intent: "informational",
    predicate: "learn",
    funnelStage: "tofu",
    pageType: "guide",
    suggestedSlug: "/search-visibility/",
    suggestedTitle: "Search visibility",
    informationGain: null,
    borderNote: null,
    priority: "high",
    status: "gap",
    matchedPagePath: null,
    matchSource: null,
    matchConfidence: null,
    sortOrder: 0,
    pageTitle: null,
    gscClicks: null,
    gscImpressions: null,
    gscPosition: null,
    usSearchVolume: 500,
    globalSearchVolume: 1_000,
    estimatedUsTraffic: 100,
    estimatedUsTrafficCtr: 0.2,
    usVolumeFetchedAt: "2026-08-20T00:00:00.000Z",
    globalVolumeFetchedAt: "2026-08-20T00:00:00.000Z",
    demandFetchedAt: "2026-08-20T00:00:00.000Z",
    competitors: [],
    ...overrides,
  };
}

const allStatuses = { published: true, gap: true, ignored: true };
const allPriorities = { high: true, medium: true, low: true };

describe("topical-map export", () => {
  it("exports the hierarchy in outline order with demand columns", () => {
    const pillar = node({ id: 10, title: "Pillar", sortOrder: 0 });
    const child = node({
      id: 11,
      parentId: 10,
      level: "supporting",
      title: "Child topic",
      sortOrder: 0,
      usSearchVolume: null,
      globalSearchVolume: null,
      estimatedUsTraffic: 0,
    });
    const sibling = node({ id: 12, title: "Sibling topic", sortOrder: 1 });

    const rows = buildTopicalMapExportRows(
      [sibling, child, pillar],
      allStatuses,
      allPriorities,
    );

    expect(TOPICAL_MAP_EXPORT_HEADERS).toContain("Estimated US Traffic");
    expect(TOPICAL_MAP_EXPORT_HEADERS).toContain("US Search Volume");
    expect(TOPICAL_MAP_EXPORT_HEADERS).toContain("Global Search Volume");
    expect(rows.map((row) => row[0])).toEqual([
      "Pillar",
      "Child topic",
      "Sibling topic",
    ]);
    expect(rows[1]?.[7]).toBe("No measurable volume");
    expect(rows[1]?.[8]).toBe("No measurable volume");
  });

  it("respects status and priority filters and neutralizes spreadsheet formulas", () => {
    const gap = node({ canonicalQuery: "=external-formula" });
    const covered = node({
      id: 2,
      status: "published",
      priority: "low",
      title: "Already covered",
    });
    const tsv = topicalMapExportTsv(
      [gap, covered],
      { published: false, gap: true, ignored: false },
      { high: true, medium: false, low: false },
    );

    expect(tsv).toContain("=external-formula");
    expect(tsv).toContain("'=external-formula");
    expect(tsv).not.toContain("Already covered");
  });
});