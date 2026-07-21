import { describe, it, expect } from "vitest";
import {
  EXPECTED_CTR,
  CTR_MIN_IMPRESSIONS,
  CTR_UNDERPERFORM_RATIO,
  CANNIBAL_MIN_QUERY_IMPRESSIONS,
  ENGAGEMENT_MIN_SESSIONS,
  LINK_OFF_TOPIC_SIMILARITY,
  expectedCtrFor,
  scoreOf,
  ctrInsight,
  pickCannibalContenders,
  pageVerdicts,
  linkQualityFlags,
} from "./insights";

describe("expectedCtrFor", () => {
  it("returns the benchmark for rounded top-10 positions", () => {
    expect(expectedCtrFor(1)).toBe(0.28);
    expect(expectedCtrFor(1.4)).toBe(0.28);
    expect(expectedCtrFor(2.6)).toBe(EXPECTED_CTR[3]);
    expect(expectedCtrFor(10.4)).toBe(0.022);
  });
  it("returns null outside the top 10", () => {
    expect(expectedCtrFor(10.6)).toBeNull();
    expect(expectedCtrFor(24)).toBeNull();
    expect(expectedCtrFor(0)).toBeNull();
  });
});

describe("scoreOf", () => {
  it("scales with log10 of impressions", () => {
    expect(scoreOf(65, 0)).toBe(65);
    expect(scoreOf(65, 999)).toBe(65 * 4); // 1 + log10(1000) = 4
  });
  it("clamps negative impressions to zero", () => {
    expect(scoreOf(50, -100)).toBe(50);
  });
});

describe("ctrInsight", () => {
  it("flags a top-3 page earning far below the norm", () => {
    const r = ctrInsight(2, 0.02, 1000);
    expect(r.expectedCtr).toBe(0.15);
    expect(r.ctrFlag).toBe("underperforming");
    expect(r.missedClicks).toBe(Math.round(1000 * (0.15 - 0.02)));
  });
  it("does not flag when CTR is at/above the ratio threshold", () => {
    const r = ctrInsight(2, 0.15 * CTR_UNDERPERFORM_RATIO, 1000);
    expect(r.ctrFlag).toBeNull();
    expect(r.missedClicks).toBe(0);
  });
  it("does not flag on thin volume but still reports the benchmark", () => {
    const r = ctrInsight(1, 0.01, CTR_MIN_IMPRESSIONS - 1);
    expect(r.expectedCtr).toBe(0.28);
    expect(r.ctrFlag).toBeNull();
    expect(r.missedClicks).toBe(0);
  });
  it("returns null benchmark outside the top 10", () => {
    const r = ctrInsight(15, 0.01, 5000);
    expect(r.expectedCtr).toBeNull();
    expect(r.ctrFlag).toBeNull();
    expect(r.missedClicks).toBe(0);
  });
});

describe("pageVerdicts", () => {
  const base = {
    position: 5,
    impressions: 5000,
    clicks: 200,
    ctr: 0.04,
    sessions: 300,
    engagementRate: 0.6,
    keyEvents: 4,
    aiSessions: 0,
  };

  it("returns no verdicts for a healthy page", () => {
    expect(pageVerdicts(base)).toEqual([]);
  });

  it("flags low_ctr like ctrInsight", () => {
    expect(pageVerdicts({ ...base, ctr: 0.005, clicks: 25 })).toContain("low_ctr");
  });

  it("flags weak_engagement only when ranking well with enough sessions", () => {
    expect(pageVerdicts({ ...base, engagementRate: 0.2 })).toContain("weak_engagement");
    // position outside top 10 → not "ranking well", no engagement verdict
    expect(pageVerdicts({ ...base, position: 25, engagementRate: 0.2 })).not.toContain(
      "weak_engagement",
    );
    // GA4 outage: sessions 0 suppresses the verdict instead of mass-flagging
    expect(pageVerdicts({ ...base, sessions: 0, engagementRate: 0 })).not.toContain(
      "weak_engagement",
    );
  });

  it("flags no_conversions on real traffic with zero key events", () => {
    expect(pageVerdicts({ ...base, keyEvents: 0 })).toContain("no_conversions");
    expect(pageVerdicts({ ...base, keyEvents: 0, impressions: 500 })).not.toContain(
      "no_conversions",
    );
    expect(
      pageVerdicts({ ...base, keyEvents: 0, sessions: ENGAGEMENT_MIN_SESSIONS - 1 }),
    ).not.toContain("no_conversions");
  });

  it("flags ai_only when AI cites it but Google sends nothing", () => {
    expect(pageVerdicts({ ...base, aiSessions: 9, clicks: 0, ctr: 0 })).toContain("ai_only");
    expect(pageVerdicts({ ...base, aiSessions: 9 })).not.toContain("ai_only");
  });
});

describe("linkQualityFlags", () => {
  it("flags off_topic below the similarity threshold", () => {
    expect(
      linkQualityFlags({ similarity: 0.2, tierViolation: false, anchorBanned: false }),
    ).toEqual(["off_topic"]);
    expect(
      linkQualityFlags({ similarity: LINK_OFF_TOPIC_SIMILARITY, tierViolation: false, anchorBanned: false }),
    ).toEqual([]);
  });

  it("never flags off_topic when similarity is unknown", () => {
    expect(
      linkQualityFlags({ similarity: null, tierViolation: false, anchorBanned: false }),
    ).toEqual([]);
  });

  it("stacks tier_violation and generic_anchor", () => {
    expect(
      linkQualityFlags({ similarity: 0.1, tierViolation: true, anchorBanned: true }),
    ).toEqual(["off_topic", "tier_violation", "generic_anchor"]);
  });
});

describe("pickCannibalContenders", () => {
  const page = (impressions: number, clicks: number, position: number, url = "u") => ({
    url,
    impressions,
    clicks,
    position,
  });

  it("returns [] for a single page", () => {
    expect(pickCannibalContenders([page(500, 10, 3)], 500)).toEqual([]);
  });

  it("returns [] when the query is too small", () => {
    expect(
      pickCannibalContenders(
        [page(40, 2, 3, "a"), page(40, 1, 5, "b")],
        CANNIBAL_MIN_QUERY_IMPRESSIONS - 1,
      ),
    ).toEqual([]);
  });

  it("returns [] when only one page holds a meaningful share", () => {
    // b holds 5% — below the 20% share floor
    expect(pickCannibalContenders([page(900, 20, 2, "a"), page(50, 1, 8, "b")], 1000)).toEqual([]);
  });

  it("excludes contenders ranking beyond position 20", () => {
    expect(pickCannibalContenders([page(400, 10, 3, "a"), page(300, 5, 45, "b")], 1000)).toEqual(
      [],
    );
  });

  it("sorts primary first by clicks then position", () => {
    const a = page(300, 5, 6, "a");
    const b = page(400, 20, 4, "b");
    const c = page(300, 20, 2, "c");
    const out = pickCannibalContenders([a, b, c], 1000);
    expect(out.map((x) => x.url)).toEqual(["c", "b", "a"]); // c wins tie on position
  });
});
