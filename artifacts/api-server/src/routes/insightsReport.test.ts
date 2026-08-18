import { describe, it, expect } from "vitest";
import { expectedCtrFor } from "../lib/insights";
import {
  buildQueryIntegrity,
  buildCtrCurve,
  buildStrikingDistance,
  pickDiscoveryDates,
  buildIndexingByTemplate,
  buildInvestMap,
  buildTitleRewrites,
  buildWrongIntent,
  buildBingOnlyQueries,
  countDistinctQueriesByPath,
  resolveGa4Sections,
  type QueryPageRow,
  type IndexingPageRow,
  type JoinPageRow,
  type BingQueryRow,
  type JoinLoad,
} from "./insightsReport";

/**
 * Pure-builder unit tests for the strategic SEO report (v2). The builders take
 * pre-fetched data so no GSC/GA4/DB access is needed — the route wires the
 * live pulls, per-section Promise.allSettled degradation, and cache.
 */

// ---------------------------------------------------------------------------
// Section 1 — queryIntegrity
// ---------------------------------------------------------------------------

describe("buildQueryIntegrity", () => {
  const qp = (query: string, path: string, impressions: number, clicks = 0, position = 5): QueryPageRow => ({
    query,
    path,
    impressions,
    clicks,
    position,
  });

  it("flags a query where two URLs each hold >= 10% of its impressions", () => {
    const rows = [qp("crm", "/a", 60), qp("crm", "/b", 40)];
    const out = buildQueryIntegrity(rows);
    expect(out.available).toBe(true);
    expect(out.totalCount).toBe(1);
    const r = out.rows[0]!;
    expect(r.query).toBe("crm");
    expect(r.impressions).toBe(100);
    // sharePct is share of THIS query's impressions across returned URLs.
    expect(r.urls.map((u) => u.path)).toEqual(["/a", "/b"]);
    expect(r.urls[0]!.sharePct).toBe(60);
    expect(r.urls[1]!.sharePct).toBe(40);
    expect(out.note).toMatch(/share of THIS query/i);
  });

  it("ignores a query below the 30-impression floor", () => {
    const rows = [qp("tiny", "/a", 15), qp("tiny", "/b", 10)];
    expect(buildQueryIntegrity(rows).totalCount).toBe(0);
  });

  it("does not flag when a single URL dominates (second URL under 10% share)", () => {
    const rows = [qp("crm", "/a", 95), qp("crm", "/b", 5)];
    expect(buildQueryIntegrity(rows).totalCount).toBe(0);
  });

  it("SUMs impressions per path when GSC splits #anchor variants", () => {
    const rows = [qp("crm", "/a", 30), qp("crm", "/a", 30), qp("crm", "/b", 40)];
    const out = buildQueryIntegrity(rows);
    expect(out.totalCount).toBe(1);
    const a = out.rows[0]!.urls.find((u) => u.path === "/a")!;
    expect(a.impressions).toBe(60);
  });

  it("returns the top 3 URLs and caps output at 15 queries", () => {
    const rows: QueryPageRow[] = [];
    for (let i = 0; i < 20; i++) {
      // Each query has 4 competing URLs, all >= 10% share.
      rows.push(qp(`q${i}`, "/w", 30 + i));
      rows.push(qp(`q${i}`, "/x", 25));
      rows.push(qp(`q${i}`, "/y", 25));
      rows.push(qp(`q${i}`, "/z", 20));
    }
    const out = buildQueryIntegrity(rows);
    expect(out.totalCount).toBe(20);
    expect(out.rows).toHaveLength(15);
    expect(out.rows[0]!.urls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — ctrCurve
// ---------------------------------------------------------------------------

describe("buildCtrCurve", () => {
  const qp = (path: string, impressions: number, clicks: number, position: number): QueryPageRow => ({
    query: "q",
    path,
    impressions,
    clicks,
    position,
  });

  it("classifies a low-CTR page as belowCurve with missedClicks", () => {
    // position 2 → expectedCtr 0.15; actual 0.02 → ratio 0.13 < 0.5.
    const out = buildCtrCurve([qp("/below", 1000, 20, 2)]);
    expect(out.belowCurve).toHaveLength(1);
    expect(out.aboveCurve).toHaveLength(0);
    const r = out.belowCurve[0]!;
    expect(r.path).toBe("/below");
    expect(r.expectedCtr).toBe(0.15);
    expect(r.ratio).toBeLessThan(0.5);
    expect(r.missedClicks).toBe(Math.round(0.15 * 1000 - 20));
  });

  it("classifies a high-CTR page as aboveCurve", () => {
    // position 5 → expectedCtr 0.06; actual 0.2 → ratio ~3.3 > 1.5.
    const out = buildCtrCurve([qp("/above", 500, 100, 5)]);
    expect(out.aboveCurve).toHaveLength(1);
    expect(out.belowCurve).toHaveLength(0);
    expect(out.aboveCurve[0]!.ratio).toBeGreaterThan(1.5);
  });

  it("skips pages under 100 impressions and pages ranking below 10", () => {
    const out = buildCtrCurve([qp("/thin", 50, 0, 2), qp("/deep", 5000, 0, 14)]);
    expect(out.belowCurve).toHaveLength(0);
    expect(out.aboveCurve).toHaveLength(0);
  });

  it("does not classify an on-curve page", () => {
    // position 5, expected 0.06, actual 0.06 → ratio 1.0.
    const out = buildCtrCurve([qp("/ok", 1000, 60, 5)]);
    expect(out.belowCurve).toHaveLength(0);
    expect(out.aboveCurve).toHaveLength(0);
  });

  it("aggregates by page across #anchor rows before judging CTR", () => {
    const out = buildCtrCurve([qp("/p", 600, 6, 2), qp("/p", 600, 6, 2)]);
    // combined: 1200 impr, 12 clicks, ctr 0.01, pos 2, expected 0.15 → below.
    expect(out.belowCurve).toHaveLength(1);
    expect(out.belowCurve[0]!.impressions).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// Section 3 — strikingDistance
// ---------------------------------------------------------------------------

describe("buildStrikingDistance", () => {
  it("keeps position 5-15 with >= 10 impressions and ranks by score", () => {
    const aggs = [
      { query: "a", impressions: 100, clicks: 2, posWeighted: 0, posWeight: 0, bestPath: "/a", bestImpressions: 100, position: 6 },
      { query: "b", impressions: 500, clicks: 3, posWeighted: 0, posWeight: 0, bestPath: "/b", bestImpressions: 500, position: 11 },
      { query: "toofar", impressions: 900, clicks: 1, posWeighted: 0, posWeight: 0, bestPath: "/c", bestImpressions: 900, position: 40 },
      { query: "thin", impressions: 3, clicks: 0, posWeighted: 0, posWeight: 0, bestPath: "/d", bestImpressions: 3, position: 7 },
    ];
    const out = buildStrikingDistance(aggs, "2026-01-01", "2026-01-28");
    expect(out.totalCandidates).toBe(2);
    // score = impressions × (16 − position): b=500*5=2500 > a=100*10=1000.
    expect(out.queries.map((q) => q.query)).toEqual(["b", "a"]);
    expect(out.queries[0]!.page2).toBe(true); // position 11 > 10
    expect(out.windowStart).toBe("2026-01-01");
  });
});

// ---------------------------------------------------------------------------
// Section 4 — queryDiscovery date pick
// ---------------------------------------------------------------------------

describe("pickDiscoveryDates", () => {
  it("returns null with fewer than two distinct dates", () => {
    expect(pickDiscoveryDates([])).toBeNull();
    expect(pickDiscoveryDates(["2026-01-01", "2026-01-01"])).toBeNull();
  });

  it("prefers the most recent pair >= 14 days apart", () => {
    const out = pickDiscoveryDates(["2026-01-01", "2026-01-10", "2026-01-25"]);
    expect(out).toEqual({ now: "2026-01-25", before: "2026-01-10" });
  });

  it("falls back to the two most recent dates when none are 14 days apart", () => {
    const out = pickDiscoveryDates(["2026-01-20", "2026-01-25", "2026-01-27"]);
    expect(out).toEqual({ now: "2026-01-27", before: "2026-01-25" });
  });
});

// ---------------------------------------------------------------------------
// Section 5 — indexingByTemplate
// ---------------------------------------------------------------------------

describe("buildIndexingByTemplate", () => {
  it("groups by section and orders by zero-impression share desc", () => {
    const pages: IndexingPageRow[] = [
      { section: "blog", impressions: 100 },
      { section: "blog", impressions: 0 },
      { section: "blog", impressions: null },
      { section: "product", impressions: 50 },
      { section: "product", impressions: 20 },
    ];
    const out = buildIndexingByTemplate(pages);
    expect(out.available).toBe(true);
    // blog: 2/3 zero ≈ 66.7%; product: 0%. Ordered zero desc → blog first.
    expect(out.sections[0]!.section).toBe("blog");
    expect(out.sections[0]!.zeroImpressionPct).toBeCloseTo(66.7, 1);
    expect(out.sections[1]!.section).toBe("product");
    expect(out.sections[1]!.zeroImpressionPct).toBe(0);
    expect(out.note).toMatch(/proxy for indexing coverage/i);
  });

  it("is unavailable with no pages", () => {
    expect(buildIndexingByTemplate([]).available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sections 6-8 — decision joins
// ---------------------------------------------------------------------------

function jr(over: Partial<JoinPageRow>): JoinPageRow {
  return {
    path: "/p",
    title: "P",
    section: "blog",
    topQuery: "q",
    position: 5,
    impressions: 300,
    clicks: 10,
    keyEvents: 0,
    aiSessions: 0,
    sessions: 100,
    engagedSessions: 60,
    engagementRate: 0.6,
    avgEngagementTime: 30,
    ...over,
  };
}

describe("buildInvestMap", () => {
  it("ranks by keyEvents then engagedSessions and caps at 12", () => {
    const rows: JoinPageRow[] = [];
    for (let i = 0; i < 15; i++) {
      rows.push(jr({ path: `/p${i}`, keyEvents: i, engagedSessions: i * 10 }));
    }
    const out = buildInvestMap(rows);
    expect(out.available).toBe(true);
    expect(out.pages).toHaveLength(12);
    expect(out.pages[0]!.path).toBe("/p14"); // highest keyEvents
    expect(out.pages[0]!.keyEvents).toBe(14);
    expect(out.pages[0]!.topQuery).toBe("q");
  });

  it("breaks keyEvents ties by engagedSessions", () => {
    const rows = [
      jr({ path: "/low", keyEvents: 3, engagedSessions: 10 }),
      jr({ path: "/high", keyEvents: 3, engagedSessions: 90 }),
    ];
    expect(buildInvestMap(rows).pages[0]!.path).toBe("/high");
  });
});

describe("buildTitleRewrites", () => {
  const expected2 = expectedCtrFor(2)!; // 0.15

  it("flags high-impression below-curve pages that convert", () => {
    // impressions 1000 >= 200, pos 2 <= 12, ctr 0.02 < 0.5*0.15=0.075, keyEvents 2 > 0.
    const out = buildTitleRewrites([jr({ path: "/win", impressions: 1000, clicks: 20, position: 2, keyEvents: 2 })]);
    expect(out.pages).toHaveLength(1);
    const r = out.pages[0]!;
    expect(r.path).toBe("/win");
    expect(r.expectedCtr).toBe(expected2);
    expect(r.missedClicks).toBe(Math.round(expected2 * 1000 - 20));
    expect(r.keyEvents).toBe(2);
  });

  it("accepts strong engagement in place of key events", () => {
    const out = buildTitleRewrites([
      jr({ path: "/eng", impressions: 500, clicks: 5, position: 3, keyEvents: 0, engagementRate: 0.7 }),
    ]);
    expect(out.pages).toHaveLength(1);
  });

  it("excludes pages that neither convert nor engage", () => {
    const out = buildTitleRewrites([
      jr({ path: "/dud", impressions: 500, clicks: 5, position: 3, keyEvents: 0, engagementRate: 0.2 }),
    ]);
    expect(out.pages).toHaveLength(0);
  });

  it("excludes thin-impression pages and CTR that already meets the curve", () => {
    const belowVol = jr({ path: "/thin", impressions: 100, clicks: 1, position: 2, keyEvents: 5 });
    const goodCtr = jr({ path: "/ok", impressions: 1000, clicks: 120, position: 2, keyEvents: 5 });
    const out = buildTitleRewrites([belowVol, goodCtr]);
    expect(out.pages).toHaveLength(0);
  });
});

describe("buildWrongIntent", () => {
  it("flags high-click low-engagement zero-conversion pages", () => {
    const out = buildWrongIntent([
      jr({ path: "/mismatch", clicks: 50, engagementRate: 0.2, keyEvents: 0, avgEngagementTime: 8 }),
    ]);
    expect(out.pages).toHaveLength(1);
    const r = out.pages[0]!;
    expect(r.path).toBe("/mismatch");
    expect(r.clicks).toBe(50);
    expect(r.engagementRate).toBe(0.2);
    expect(r.topQuery).toBe("q");
  });

  it("excludes pages with any key events, low clicks, or healthy engagement", () => {
    const converts = jr({ clicks: 50, engagementRate: 0.2, keyEvents: 1 });
    const fewClicks = jr({ clicks: 5, engagementRate: 0.2, keyEvents: 0 });
    const engaged = jr({ clicks: 50, engagementRate: 0.6, keyEvents: 0 });
    const out = buildWrongIntent([converts, fewClicks, engaged]);
    expect(out.pages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Section 9 — bingOnlyQueries
// ---------------------------------------------------------------------------

describe("buildBingOnlyQueries", () => {
  const bq = (query: string, impressions: number, clicks = 0, position: number | null = 8): BingQueryRow => ({
    query,
    impressions,
    clicks,
    position,
  });

  it("keeps Bing queries with >= 50 impressions that Google never showed", () => {
    const gsc = new Set(["known term"]);
    const rows = [bq("bing only", 120, 4, 6), bq("known term", 999, 10, 3), bq("thin", 20)];
    const out = buildBingOnlyQueries(rows, gsc);
    expect(out.available).toBe(true);
    expect(out.queries.map((q) => q.query)).toEqual(["bing only"]);
    expect(out.queries[0]!.position).toBe(6);
  });

  it("excludes GSC-known queries case-insensitively", () => {
    const gsc = new Set(["crm software"]);
    const out = buildBingOnlyQueries([bq("CRM Software", 800)], gsc);
    expect(out.queries).toHaveLength(0);
  });

  it("SUMs impressions across buckets by normalized query", () => {
    const out = buildBingOnlyQueries([bq("widget", 30), bq("Widget", 30)], new Set());
    expect(out.queries).toHaveLength(1);
    expect(out.queries[0]!.impressions).toBe(60);
  });

  it("reports null position when Bing never gave one", () => {
    const out = buildBingOnlyQueries([bq("noposn", 80, 0, null)], new Set());
    expect(out.queries[0]!.position).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section 4 regression — queryDiscovery must not double-count a query that
// appears on URL variants collapsing to one canonical path.
// ---------------------------------------------------------------------------

describe("countDistinctQueriesByPath", () => {
  const host = "example.com";

  it("counts a query once across #anchor / trailing-slash variants of one page", () => {
    const rows = [
      { url: "https://example.com/page", query: "crm" },
      { url: "https://example.com/page/#pricing", query: "crm" },
      { url: "https://example.com/page/", query: "crm" },
    ];
    const out = countDistinctQueriesByPath(rows, host, []);
    // All three variants collapse to /page; "crm" counted once.
    expect(out.get("/page")).toBe(1);
  });

  it("counts distinct queries per canonical path, deduping normalized dupes", () => {
    const rows = [
      { url: "https://example.com/page", query: "crm" },
      { url: "https://example.com/page#a", query: "CRM" }, // same query, different case + anchor
      { url: "https://example.com/page", query: "sales tool" },
      { url: "https://example.com/other", query: "crm" },
    ];
    const out = countDistinctQueriesByPath(rows, host, []);
    expect(out.get("/page")).toBe(2); // crm + sales tool (CRM deduped)
    expect(out.get("/other")).toBe(1);
  });

  it("drops blocklisted paths and blank queries", () => {
    const block = [/^\/admin/];
    const rows = [
      { url: "https://example.com/admin/x", query: "secret" },
      { url: "https://example.com/keep", query: "  " },
      { url: "https://example.com/keep", query: "real" },
    ];
    const out = countDistinctQueriesByPath(rows, host, block);
    expect(out.has("/admin/x")).toBe(false);
    expect(out.get("/keep")).toBe(1); // blank query ignored
  });
});

// ---------------------------------------------------------------------------
// Sections 6-8 regression — a failed live GA4 pull must NEVER zero-fill and
// let the joins draw conclusions from fabricated engagement metrics.
// ---------------------------------------------------------------------------

describe("resolveGa4Sections", () => {
  it("builds all three sections from real rows when the pull succeeds", () => {
    const load: JoinLoad = {
      status: "ok",
      rows: [
        jr({ path: "/converts", keyEvents: 5, engagedSessions: 80 }),
        jr({ path: "/mismatch", clicks: 50, engagementRate: 0.2, keyEvents: 0 }),
      ],
    };
    const { investMap, titleRewrites, wrongIntent } = resolveGa4Sections(load);
    expect(investMap.available).toBe(true);
    expect(titleRewrites.available).toBe(true);
    expect(wrongIntent.available).toBe(true);
    // Real low-engagement zero-conversion page IS flagged when data is real.
    expect(wrongIntent.pages.map((p) => p.path)).toContain("/mismatch");
  });

  it("marks all three unavailable with the 'not synced' note when GA4 never synced", () => {
    const { investMap, titleRewrites, wrongIntent } = resolveGa4Sections({ status: "no-sync" });
    for (const s of [investMap, titleRewrites, wrongIntent]) {
      expect(s.available).toBe(false);
      expect(s.note).toBe("GA4 not synced");
      expect(s.pages).toEqual([]);
    }
  });

  it("does NOT fabricate zero metrics when the live GA4 pull fails", () => {
    // If the failure path zero-filled engagement, a page with 40 clicks would
    // be flagged wrongIntent as 0% engagement / 0 key events. It must not be.
    const { investMap, titleRewrites, wrongIntent } = resolveGa4Sections({
      status: "ga4-unavailable",
    });
    for (const s of [investMap, titleRewrites, wrongIntent]) {
      expect(s.available).toBe(false);
      expect(s.note).toBe("GA4 data unavailable — connect/sync GA4 to unlock these analyses");
      expect(s.pages).toEqual([]);
    }
  });
});
