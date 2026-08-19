import { describe, it, expect } from "vitest";
import {
  isOperatorQuery,
  computeRunWindow,
  weeklyChunks,
  aggregateGscChunks,
  classifyKeyword,
  aggregateClusterPrior,
  resolveRunWeeks,
  DEFAULT_WEEKS,
  MIN_IMPRESSIONS,
  RISING_THRESHOLD,
  DISPLACED_CLICK_THRESHOLD,
  DISPLACED_IMP_ABS_THRESHOLD,
  ZERO_CLICK_CTR,
  STRIKING_DISTANCE_LOW,
  STRIKING_DISTANCE_HIGH,
} from "./clustering";

// ─── isOperatorQuery ──────────────────────────────────────────────────────────

describe("isOperatorQuery", () => {
  it("flags quoted-phrase queries (AI fan-out scrapes seen in GSC)", () => {
    expect(
      isOperatorQuery('"fintech" "founded in 2020" "backed by" "venture capital"'),
    ).toBe(true);
    expect(
      isOperatorQuery(
        '"bronixengineering.com" content topic clusters depth publishing velocity',
      ),
    ).toBe(true);
    expect(isOperatorQuery('"vc-backed fintech" "founded in 2020" co-founder')).toBe(
      true,
    );
    expect(
      isOperatorQuery('"generative engine visibility" tools or software or platform'),
    ).toBe(true);
    expect(isOperatorQuery("best \u201cai seo\u201d tools")).toBe(true); // curly quotes
  });

  it("flags parenthesized boolean queries", () => {
    expect(
      isOperatorQuery(
        "(fintech companies founded in 2020) and (uk) and (venture capital backed)",
      ),
    ).toBe(true);
    expect(isOperatorQuery("(seo tools) or (marketing software)")).toBe(true);
    expect(isOperatorQuery("(a)|(b)")).toBe(true);
  });

  it("flags search-operator prefixes", () => {
    expect(isOperatorQuery("site:example.com seo")).toBe(true);
    expect(isOperatorQuery("seo tips inurl:blog")).toBe(true);
    expect(isOperatorQuery("intitle:seo checklist")).toBe(true);
    expect(isOperatorQuery("allintitle:ai visibility")).toBe(true);
    expect(isOperatorQuery("filetype:pdf seo guide")).toBe(true);
    expect(isOperatorQuery("-site:reddit.com ai tools")).toBe(true);
  });

  it("keeps legitimate human queries containing and/or", () => {
    expect(isOperatorQuery("pros and cons of ai content")).toBe(false);
    expect(isOperatorQuery("bed and breakfast seo")).toBe(false);
    expect(isOperatorQuery("seo or sem which is better")).toBe(false);
    expect(isOperatorQuery("black and white logo design")).toBe(false);
  });

  it("keeps normal queries, including apostrophes and colons in times", () => {
    expect(isOperatorQuery("startup business ideas 2026")).toBe(false);
    expect(isOperatorQuery("what's the best ai seo tool")).toBe(false);
    expect(isOperatorQuery("how to rank in chatgpt")).toBe(false);
    expect(isOperatorQuery("query fan out")).toBe(false);
    expect(isOperatorQuery("seo checklist (2026)")).toBe(false);
  });
});

// ─── resolveRunWeeks ─────────────────────────────────────────────────────────

describe("resolveRunWeeks", () => {
  // ── Explicit weeks wins ───────────────────────────────────────────────────

  it("{weeks:6} → 6", () => {
    expect(resolveRunWeeks({ weeks: 6 })).toBe(6);
  });

  it("{weeks:4} → 4 (minimum boundary)", () => {
    expect(resolveRunWeeks({ weeks: 4 })).toBe(4);
  });

  it("{weeks:52} → 52 (maximum boundary)", () => {
    expect(resolveRunWeeks({ weeks: 52 })).toBe(52);
  });

  it("weeks wins when both weeks and days supplied: {weeks:6, days:56} → 6", () => {
    expect(resolveRunWeeks({ weeks: 6, days: 56 })).toBe(6);
  });

  it("{weeks:12, days:28} → 12 (weeks wins, days ignored)", () => {
    expect(resolveRunWeeks({ weeks: 12, days: 28 })).toBe(12);
  });

  // ── Legacy days fallback ──────────────────────────────────────────────────

  it("{days:28} → 4 weeks (28/7 = 4)", () => {
    expect(resolveRunWeeks({ days: 28 })).toBe(4);
  });

  it("{days:84} → 12 weeks (84/7 = 12)", () => {
    expect(resolveRunWeeks({ days: 84 })).toBe(12);
  });

  it("{days:90} → 13 weeks (round(90/7) = 13)", () => {
    expect(resolveRunWeeks({ days: 90 })).toBe(13);
  });

  it("{days:7} → 4 weeks minimum clamp (7/7=1 → clamped to 4)", () => {
    expect(resolveRunWeeks({ days: 7 })).toBe(4);
  });

  it("{days:180} → 26 weeks (round(180/7)=26 → clamped to 26)", () => {
    expect(resolveRunWeeks({ days: 180 })).toBe(26);
  });

  // ── Default when neither supplied ────────────────────────────────────────

  it("{} → DEFAULT_WEEKS (12)", () => {
    expect(resolveRunWeeks({})).toBe(DEFAULT_WEEKS);
  });

  it("{country:'usa'} → DEFAULT_WEEKS (unrelated fields don't affect result)", () => {
    expect(resolveRunWeeks({ country: "usa" } as Record<string, unknown>)).toBe(
      DEFAULT_WEEKS,
    );
  });

  // ── Fractional rejection ──────────────────────────────────────────────────

  it("{weeks:4.5} → null (fractional rejected)", () => {
    expect(resolveRunWeeks({ weeks: 4.5 })).toBeNull();
  });

  it("{weeks:0.5} → null", () => {
    expect(resolveRunWeeks({ weeks: 0.5 })).toBeNull();
  });

  it("{days:28.5} → null (fractional days rejected)", () => {
    expect(resolveRunWeeks({ days: 28.5 })).toBeNull();
  });

  it("{days:7.1} → null", () => {
    expect(resolveRunWeeks({ days: 7.1 })).toBeNull();
  });

  // ── Out-of-range rejection ────────────────────────────────────────────────

  it("{weeks:3} → null (below min 4)", () => {
    expect(resolveRunWeeks({ weeks: 3 })).toBeNull();
  });

  it("{weeks:53} → null (above max 52)", () => {
    expect(resolveRunWeeks({ weeks: 53 })).toBeNull();
  });

  it("{days:6} → null (below min 7)", () => {
    expect(resolveRunWeeks({ days: 6 })).toBeNull();
  });

  it("{days:181} → null (above max 180)", () => {
    expect(resolveRunWeeks({ days: 181 })).toBeNull();
  });

  // ── Type safety ────────────────────────────────────────────────────────────

  it("{weeks:'6'} → null (string not accepted)", () => {
    expect(resolveRunWeeks({ weeks: "6" } as Record<string, unknown>)).toBeNull();
  });

  it("{weeks:null} → null (null not accepted)", () => {
    expect(resolveRunWeeks({ weeks: null } as Record<string, unknown>)).toBeNull();
  });

  it("{days:'28'} → null (string not accepted)", () => {
    expect(resolveRunWeeks({ days: "28" } as Record<string, unknown>)).toBeNull();
  });
});

// ─── computeRunWindow ─────────────────────────────────────────────────────────

describe("computeRunWindow", () => {
  // Use a fixed "now" so tests are deterministic: 2026-08-12 UTC
  const now = new Date("2026-08-12T12:00:00Z");

  it("currentEnd is today minus 3 days (UTC)", () => {
    const w = computeRunWindow(4, now);
    expect(w.currentEnd).toBe("2026-08-09"); // 2026-08-12 - 3 = 2026-08-09
  });

  it("current period spans exactly weeks*7 days inclusive (4 weeks = 28 days)", () => {
    const w = computeRunWindow(4, now);
    const start = new Date(w.currentStart).getTime();
    const end = new Date(w.currentEnd).getTime();
    const days = (end - start) / 86_400_000 + 1; // inclusive
    expect(days).toBe(28);
  });

  it("prior period spans the same length as current period", () => {
    const w = computeRunWindow(4, now);
    const priorStart = new Date(w.priorStart).getTime();
    const priorEnd = new Date(w.priorEnd).getTime();
    const currentStart = new Date(w.currentStart).getTime();
    const currentEnd = new Date(w.currentEnd).getTime();
    const priorLen = (priorEnd - priorStart) / 86_400_000 + 1;
    const currentLen = (currentEnd - currentStart) / 86_400_000 + 1;
    expect(priorLen).toBe(currentLen);
  });

  it("priorEnd is exactly one day before currentStart (no gap, no overlap)", () => {
    const w = computeRunWindow(4, now);
    const priorEndMs = new Date(w.priorEnd).getTime();
    const currentStartMs = new Date(w.currentStart).getTime();
    expect(currentStartMs - priorEndMs).toBe(86_400_000);
  });

  it("exact dates for 2-week window", () => {
    // now = 2026-08-12
    // end = 2026-08-09
    // currentStart = end - (2*7 - 1) = end - 13 = 2026-07-27
    // priorEnd = 2026-07-27 - 1 = 2026-07-26
    // priorStart = 2026-07-26 - (2*7 - 1) = 2026-07-26 - 13 = 2026-07-13
    const w = computeRunWindow(2, now);
    expect(w.currentEnd).toBe("2026-08-09");
    expect(w.currentStart).toBe("2026-07-27");
    expect(w.priorEnd).toBe("2026-07-26");
    expect(w.priorStart).toBe("2026-07-13");
  });

  it("handles month boundary correctly (4 weeks, end in August)", () => {
    // now = 2026-08-05, end = 2026-08-02, currentStart = 2026-07-06
    const w = computeRunWindow(4, new Date("2026-08-05T00:00:00Z"));
    expect(w.currentEnd).toBe("2026-08-02");
    expect(w.currentStart).toBe("2026-07-06");
  });

  it("12-week window (default) has 84-day current period", () => {
    const w = computeRunWindow(12, now);
    const start = new Date(w.currentStart).getTime();
    const end = new Date(w.currentEnd).getTime();
    const days = (end - start) / 86_400_000 + 1;
    expect(days).toBe(84);
  });

  it("the two periods together cover exactly 2*weeks*7 days with no gap", () => {
    const w = computeRunWindow(4, now);
    const priorStartMs = new Date(w.priorStart).getTime();
    const currentEndMs = new Date(w.currentEnd).getTime();
    const totalDays = (currentEndMs - priorStartMs) / 86_400_000 + 1;
    expect(totalDays).toBe(56); // 4*7*2
  });
});

// ─── weeklyChunks ─────────────────────────────────────────────────────────────

describe("weeklyChunks", () => {
  it("returns one chunk for a 7-day range", () => {
    const chunks = weeklyChunks("2026-07-01", "2026-07-07");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ start: "2026-07-01", end: "2026-07-07" });
  });

  it("returns exactly N chunks for N*7 days (no partial last chunk)", () => {
    // 28 days = 4 weeks
    const chunks = weeklyChunks("2026-07-01", "2026-07-28");
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toEqual({ start: "2026-07-01", end: "2026-07-07" });
    expect(chunks[1]).toEqual({ start: "2026-07-08", end: "2026-07-14" });
    expect(chunks[2]).toEqual({ start: "2026-07-15", end: "2026-07-21" });
    expect(chunks[3]).toEqual({ start: "2026-07-22", end: "2026-07-28" });
  });

  it("chunks are contiguous — no gaps or overlaps", () => {
    const chunks = weeklyChunks("2026-07-01", "2026-08-28");
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = new Date(chunks[i - 1]!.end).getTime();
      const curStart = new Date(chunks[i]!.start).getTime();
      expect(curStart - prevEnd).toBe(86_400_000);
    }
  });

  it("first chunk.start equals the range start", () => {
    const chunks = weeklyChunks("2026-07-12", "2026-08-08");
    expect(chunks[0]!.start).toBe("2026-07-12");
  });

  it("last chunk.end equals the range end", () => {
    const chunks = weeklyChunks("2026-07-12", "2026-08-08");
    expect(chunks[chunks.length - 1]!.end).toBe("2026-08-08");
  });

  it("covers the full range for a 12-week window", () => {
    const w = computeRunWindow(12, new Date("2026-08-12T00:00:00Z"));
    const chunks = weeklyChunks(w.currentStart, w.currentEnd);
    expect(chunks).toHaveLength(12);
    expect(chunks[0]!.start).toBe(w.currentStart);
    expect(chunks[chunks.length - 1]!.end).toBe(w.currentEnd);
  });

  it("handles single-day range", () => {
    const chunks = weeklyChunks("2026-08-01", "2026-08-01");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ start: "2026-08-01", end: "2026-08-01" });
  });
});

// ─── aggregateGscChunks ───────────────────────────────────────────────────────

describe("aggregateGscChunks", () => {
  it("sums clicks and impressions across chunks", () => {
    const result = aggregateGscChunks([
      [{ key: "seo tools", clicks: 10, impressions: 100, ctr: 0.1, position: 5 }],
      [{ key: "seo tools", clicks: 20, impressions: 200, ctr: 0.1, position: 6 }],
    ]);
    const row = result.get("seo tools")!;
    expect(row.clicks).toBe(30);
    expect(row.impressions).toBe(300);
  });

  it("recomputes CTR as clicks/impressions", () => {
    const result = aggregateGscChunks([
      [{ key: "ai seo", clicks: 5, impressions: 50, ctr: 0.1, position: 3 }],
      [{ key: "ai seo", clicks: 15, impressions: 250, ctr: 0.06, position: 4 }],
    ]);
    const row = result.get("ai seo")!;
    // 20 / 300 = 0.0667
    expect(row.ctr).toBeCloseTo(20 / 300, 5);
  });

  it("uses impression-weighted average for position", () => {
    // chunk1: pos=3, impressions=100; chunk2: pos=7, impressions=300
    // weighted = (3*100 + 7*300) / 400 = (300+2100)/400 = 6
    const result = aggregateGscChunks([
      [{ key: "test", clicks: 0, impressions: 100, ctr: 0, position: 3 }],
      [{ key: "test", clicks: 0, impressions: 300, ctr: 0, position: 7 }],
    ]);
    const row = result.get("test")!;
    expect(row.position).toBeCloseTo(6, 5);
  });

  it("normalizes query keys to trimmed lowercase", () => {
    const result = aggregateGscChunks([
      [{ key: "  SEO Tools  ", clicks: 5, impressions: 50, ctr: 0.1, position: 3 }],
      [{ key: "seo tools", clicks: 10, impressions: 100, ctr: 0.1, position: 4 }],
    ]);
    expect(result.has("seo tools")).toBe(true);
    expect(result.get("seo tools")!.clicks).toBe(15);
  });

  it("merges queries from different chunks correctly", () => {
    const result = aggregateGscChunks([
      [
        { key: "keyword a", clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
        { key: "keyword b", clicks: 2, impressions: 20, ctr: 0.1, position: 5 },
      ],
      [
        { key: "keyword a", clicks: 3, impressions: 30, ctr: 0.1, position: 3 },
        { key: "keyword c", clicks: 1, impressions: 5, ctr: 0.2, position: 8 },
      ],
    ]);
    expect(result.size).toBe(3);
    expect(result.get("keyword a")!.impressions).toBe(40);
    expect(result.get("keyword b")!.impressions).toBe(20);
    expect(result.get("keyword c")!.impressions).toBe(5);
  });

  it("returns empty map for empty input", () => {
    expect(aggregateGscChunks([])).toEqual(new Map());
    expect(aggregateGscChunks([[], []])).toEqual(new Map());
  });

  it("skips rows with empty key", () => {
    const result = aggregateGscChunks([
      [{ key: "", clicks: 5, impressions: 50, ctr: 0.1, position: 3 }],
      [{ key: "  ", clicks: 2, impressions: 20, ctr: 0.1, position: 4 }],
    ]);
    expect(result.size).toBe(0);
  });
});

// ─── classifyKeyword ─────────────────────────────────────────────────────────

describe("classifyKeyword", () => {
  const makeCurrent = (
    impressions: number,
    clicks: number,
    position = 1,
  ) => ({
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position,
  });
  const makePrior = makeCurrent;

  // ── "new" — no prior impressions ───────────────────────────────────────────

  it("classifies as 'new' when prior is null", () => {
    const { state } = classifyKeyword(makeCurrent(50, 5), null);
    expect(state).toBe("new");
  });

  it("classifies as 'new' when priorImpressions = 0", () => {
    const { state } = classifyKeyword(makeCurrent(50, 5), makePrior(0, 0));
    expect(state).toBe("new");
  });

  it("ratio deltas are null when priorImpressions = 0", () => {
    const r = classifyKeyword(makeCurrent(50, 5), makePrior(0, 0));
    expect(r.clickDelta).toBeNull();
    expect(r.impressionDelta).toBeNull();
  });

  it("absolute deltas are not null when prior exists (even if priorImpressions = 0)", () => {
    const r = classifyKeyword(makeCurrent(50, 5), makePrior(0, 0));
    expect(r.clickDeltaAbs).toBe(5);
    expect(r.impressionDeltaAbs).toBe(50);
  });

  it("all deltas are null when prior is null (no comparison data)", () => {
    const r = classifyKeyword(makeCurrent(50, 5), null);
    expect(r.clickDelta).toBeNull();
    expect(r.impressionDelta).toBeNull();
    expect(r.clickDeltaAbs).toBeNull();
    expect(r.impressionDeltaAbs).toBeNull();
  });

  // ── "rising" ───────────────────────────────────────────────────────────────

  it("classifies as 'rising' when impressionDelta > 0.30", () => {
    // +40% impressions
    const { state } = classifyKeyword(
      makeCurrent(140, 14),
      makePrior(100, 10),
    );
    expect(state).toBe("rising");
  });

  it("rising requires impressionDelta > threshold (not >=)", () => {
    // exactly 30% — not rising
    const { state } = classifyKeyword(
      makeCurrent(130, 13),
      makePrior(100, 10),
    );
    // 30% exactly: (130-100)/100 = 0.30, not > 0.30 → stable
    expect(state).toBe("stable");
  });

  // ── "displaced" ────────────────────────────────────────────────────────────

  it("classifies as 'displaced' when clicks drop >30% but impressions are stable", () => {
    // clicks: 100 → 60 = -40%; impressions: 100 → 105 = +5% (abs <= 10%)
    // Use position=3 so striking_distance (5-15) doesn't fire and overwrite
    const { state } = classifyKeyword(
      { impressions: 105, clicks: 60, ctr: 60 / 105, position: 3 },
      { impressions: 100, clicks: 100, ctr: 1.0, position: 3 },
    );
    expect(state).toBe("displaced");
  });

  it("does not classify as displaced when impressions also drop >10%", () => {
    // clicks: -50%, impressions: -20% (abs > 10%)
    const { state } = classifyKeyword(
      makeCurrent(80, 25),
      makePrior(100, 50),
    );
    expect(state).not.toBe("displaced");
  });

  // ── "zero_click" ───────────────────────────────────────────────────────────

  it("classifies as 'zero_click' when CTR < 0.005 and impressions >= MIN_IMPRESSIONS", () => {
    // 0/100 CTR = 0 < 0.005
    const { state } = classifyKeyword(
      { impressions: 100, clicks: 0, ctr: 0, position: 1 },
      makePrior(80, 0),
    );
    expect(state).toBe("zero_click");
  });

  it("does not classify as 'zero_click' when impressions < MIN_IMPRESSIONS", () => {
    const { state } = classifyKeyword(
      { impressions: MIN_IMPRESSIONS - 1, clicks: 0, ctr: 0, position: 1 },
      makePrior(5, 0),
    );
    expect(state).not.toBe("zero_click");
  });

  it("does not classify as 'zero_click' when CTR >= 0.005", () => {
    const { state } = classifyKeyword(
      { impressions: 100, clicks: 1, ctr: 0.01, position: 1 },
      makePrior(80, 1),
    );
    expect(state).not.toBe("zero_click");
  });

  // ── "striking_distance" ────────────────────────────────────────────────────

  it("classifies as 'striking_distance' for position 5–15 with enough impressions", () => {
    for (const pos of [5, 8, 10, 15]) {
      const { state } = classifyKeyword(
        { impressions: 50, clicks: 2, ctr: 0.04, position: pos },
        makePrior(40, 1),
      );
      expect(state).toBe("striking_distance");
    }
  });

  it("does not classify as 'striking_distance' when impressions < MIN_IMPRESSIONS", () => {
    const { state } = classifyKeyword(
      { impressions: MIN_IMPRESSIONS - 1, clicks: 0, ctr: 0, position: 10 },
      makePrior(5, 0),
    );
    expect(state).not.toBe("striking_distance");
  });

  it("does not classify as 'striking_distance' for position outside 5–15", () => {
    const { state: s1 } = classifyKeyword(
      { impressions: 50, clicks: 2, ctr: 0.04, position: 4 },
      makePrior(40, 1),
    );
    const { state: s2 } = classifyKeyword(
      { impressions: 50, clicks: 2, ctr: 0.04, position: 16 },
      makePrior(40, 1),
    );
    expect(s1).not.toBe("striking_distance");
    expect(s2).not.toBe("striking_distance");
  });

  // ── "stable" ───────────────────────────────────────────────────────────────

  it("classifies as 'stable' for a normal keyword with existing prior", () => {
    const { state } = classifyKeyword(
      makeCurrent(100, 10, 2),
      makePrior(90, 9),
    );
    expect(state).toBe("stable");
  });

  // ── Precedence (later rules win) ───────────────────────────────────────────

  it("'striking_distance' wins over 'zero_click' (both can match, striking_distance is later)", () => {
    // impressions >= MIN_IMPRESSIONS, ctr < 0.005, position in [5..15]
    // zero_click fires, then striking_distance fires → striking_distance wins
    const { state } = classifyKeyword(
      { impressions: 50, clicks: 0, ctr: 0, position: 10 },
      makePrior(40, 0),
    );
    expect(state).toBe("striking_distance");
  });

  it("'new' wins over everything (highest precedence)", () => {
    // Would be rising (huge impression increase), zero_click (ctr=0, enough impressions)
    // and striking_distance (position 10), but prior = 0 so → new
    const { state } = classifyKeyword(
      { impressions: 200, clicks: 0, ctr: 0, position: 10 },
      makePrior(0, 0),
    );
    expect(state).toBe("new");
  });

  it("'displaced' wins over 'rising' when both conditions would match — but rising requires imp growth so they can't both match", () => {
    // rising: imp up >30%; displaced: click down >30% AND imp stable ≤10%
    // They're mutually exclusive by definition, so just verify displaced works alone.
    // Use position=2 to avoid striking_distance (5-15) overwriting.
    const { state } = classifyKeyword(
      { impressions: 100, clicks: 50, ctr: 0.5, position: 2 },
      { impressions: 95, clicks: 90, ctr: 0.95, position: 3 },
    );
    // impressionDelta = (100-95)/95 ≈ 0.053 (≤10%); clickDelta = (50-90)/90 ≈ -0.44 (<-30%)
    expect(state).toBe("displaced");
  });

  // ── Ratio delta computation ────────────────────────────────────────────────

  it("correctly computes positive impressionDelta ratio", () => {
    const r = classifyKeyword(makeCurrent(150, 15), makePrior(100, 10));
    expect(r.impressionDelta).toBeCloseTo(0.5, 5); // +50%
  });

  it("correctly computes negative clickDelta ratio", () => {
    const r = classifyKeyword(
      { impressions: 100, clicks: 5, ctr: 0.05, position: 5 },
      { impressions: 100, clicks: 10, ctr: 0.1, position: 4 },
    );
    expect(r.clickDelta).toBeCloseTo(-0.5, 5); // -50%
  });

  it("clickDelta is null when priorClicks = 0 but priorImpressions > 0", () => {
    // Prior had impressions but 0 clicks (zero_click keyword previously)
    const r = classifyKeyword(
      { impressions: 100, clicks: 5, ctr: 0.05, position: 3 },
      { impressions: 80, clicks: 0, ctr: 0, position: 4 },
    );
    expect(r.clickDelta).toBeNull();
    // impressionDelta should still be computed
    expect(r.impressionDelta).toBeCloseTo((100 - 80) / 80, 5);
  });
});

// ─── aggregateClusterPrior ────────────────────────────────────────────────────

describe("aggregateClusterPrior", () => {
  // Minimal keyword factory.
  const kw = (
    clicks: number,
    impressions: number,
    priorClicks: number | null,
    priorImpressions: number | null,
    priorPosition: number | null = null,
    state: string = "stable",
  ) => ({
    clicks,
    impressions,
    priorClicks,
    priorImpressions,
    priorPosition,
    state: state as Parameters<typeof aggregateClusterPrior>[0][number]["state"],
  });

  // ── isComparisonRun=true (fresh GSC comparison run) ───────────────────────

  it("sums prior clicks and impressions", () => {
    const keywords = [
      kw(10, 100, 8, 80),
      kw(20, 200, 15, 150),
    ];
    const stats = aggregateClusterPrior(keywords, 30, 300, true);
    expect(stats.priorTotalClicks).toBe(23);
    expect(stats.priorTotalImpressions).toBe(230);
  });

  it("computes prior blended CTR as priorClicks / priorImpressions * 100", () => {
    const keywords = [kw(10, 100, 10, 100)];
    const stats = aggregateClusterPrior(keywords, 10, 100, true);
    expect(stats.priorBlendedCtr).toBeCloseTo(10, 3);
  });

  it("computes impression-weighted prior position", () => {
    // kw1: pos=2, imp=100; kw2: pos=6, imp=300 → weighted = (2*100+6*300)/400 = 5
    const keywords = [
      { clicks: 0, impressions: 100, priorClicks: 0, priorImpressions: 100, priorPosition: 2, state: "stable" as const },
      { clicks: 0, impressions: 300, priorClicks: 0, priorImpressions: 300, priorPosition: 6, state: "stable" as const },
    ];
    const stats = aggregateClusterPrior(keywords, 0, 400, true);
    expect(stats.priorAvgPosition).toBeCloseTo(5, 1);
  });

  it("returns null priorAvgPosition when no keyword had a prior position (all priorImpressions=0)", () => {
    // All "new" keywords have priorImpressions=0 so priorPosWeight=0
    const keywords = [kw(10, 100, 0, 0, null, "new")];
    const stats = aggregateClusterPrior(keywords, 10, 100, true);
    expect(stats.priorAvgPosition).toBeNull();
  });

  it("returns null ratio deltas when priorTotalClicks=0 or priorTotalImpressions=0", () => {
    // "new" keywords have priorImpressions=0 so ratio denominator is zero
    const keywords = [kw(10, 100, 0, 0, null, "new")];
    const stats = aggregateClusterPrior(keywords, 10, 100, true);
    expect(stats.clickDeltaRatio).toBeNull();
    expect(stats.impressionDeltaRatio).toBeNull();
  });

  it("correctly computes ratio deltas when prior > 0", () => {
    const keywords = [kw(30, 300, 20, 200)];
    const stats = aggregateClusterPrior(keywords, 30, 300, true);
    // (30-20)/20 = 0.5; (300-200)/200 = 0.5
    expect(stats.clickDeltaRatio).toBeCloseTo(0.5, 5);
    expect(stats.impressionDeltaRatio).toBeCloseTo(0.5, 5);
  });

  // ── Absolute deltas via currentTotal − priorTotal ─────────────────────────

  it("abs deltas = currentTotal - priorTotal (not per-keyword sum)", () => {
    const keywords = [
      kw(10, 100, 5, 80),   // prior: 5 clicks, 80 imp
      kw(20, 200, 15, 150), // prior: 15 clicks, 150 imp
    ];
    // currentTotal=30/300, priorTotal=20/230
    const stats = aggregateClusterPrior(keywords, 30, 300, true);
    expect(stats.clickDeltaAbs).toBe(10);      // 30 - 20
    expect(stats.impressionDeltaAbs).toBe(70); // 300 - 230
  });

  // ── "new" keyword — prior=0, abs delta includes full current metrics ───────

  it("'new' keyword contributes full current impressions to cluster impressionDeltaAbs", () => {
    // Cluster has one stable keyword (prior=80imp) and one new keyword (prior=0imp).
    // currentTotal = 300 (100 stable + 200 new)
    // priorTotal   = 80  (80 stable + 0 new)
    // impressionDeltaAbs should be 300 - 80 = 220 (includes new keyword's 200)
    const keywords = [
      kw(10, 100, 8, 80, null, "stable"),
      kw(20, 200, 0, 0,  null, "new"),
    ];
    const stats = aggregateClusterPrior(keywords, 30, 300, true);
    expect(stats.impressionDeltaAbs).toBe(220); // 300 - 80
    expect(stats.clickDeltaAbs).toBe(22);       // 30 - 8
  });

  it("'new' keyword: ratio deltas null because aggregate priorImpressions=0 when all prior is zero", () => {
    // Cluster has only "new" keywords — all prior=0
    // priorTotalImpressions=0 → impressionDeltaRatio=null
    const keywords = [
      kw(20, 200, 0, 0, null, "new"),
      kw(10, 100, 0, 0, null, "new"),
    ];
    const stats = aggregateClusterPrior(keywords, 30, 300, true);
    expect(stats.impressionDeltaRatio).toBeNull();
    expect(stats.clickDeltaRatio).toBeNull();
    // But abs delta IS computed: 300 - 0
    expect(stats.impressionDeltaAbs).toBe(300);
    expect(stats.clickDeltaAbs).toBe(30);
  });

  it("mixed cluster: new + stable → ratio computed on aggregate (not null)", () => {
    // stable: cur=100imp/10clk, prior=80imp/8clk
    // new:    cur=50imp/5clk,   prior=0imp/0clk
    // currentTotal=150/15, priorTotal=80/8
    // impressionDeltaRatio = (150-80)/80 = 0.875
    // clickDeltaRatio = (15-8)/8 = 0.875
    const keywords = [
      kw(10, 100, 8, 80, null, "stable"),
      kw(5,  50,  0, 0,  null, "new"),
    ];
    const stats = aggregateClusterPrior(keywords, 15, 150, true);
    expect(stats.impressionDeltaRatio).toBeCloseTo(0.875, 5);
    expect(stats.clickDeltaRatio).toBeCloseTo(0.875, 5);
    expect(stats.impressionDeltaAbs).toBe(70); // 150 - 80
    expect(stats.clickDeltaAbs).toBe(7);       // 15 - 8
  });

  it("counts all 6 states correctly in stateCounts", () => {
    const keywords = [
      kw(10, 100, 0, 0, null, "new"),
      kw(20, 200, 15, 150, null, "rising"),
      kw(5, 80, 8, 82, null, "displaced"),
      kw(0, 50, 0, 45, null, "zero_click"),
      kw(2, 30, 1, 25, null, "striking_distance"),
      kw(15, 120, 14, 110, null, "stable"),
      kw(10, 100, 8, 90, null, "stable"),
    ];
    const stats = aggregateClusterPrior(keywords, 62, 680, true);
    expect(stats.stateCounts!.new).toBe(1);
    expect(stats.stateCounts!.rising).toBe(1);
    expect(stats.stateCounts!.displaced).toBe(1);
    expect(stats.stateCounts!.zero_click).toBe(1);
    expect(stats.stateCounts!.striking_distance).toBe(1);
    expect(stats.stateCounts!.stable).toBe(2);
  });

  it("returns zero for states with no keywords", () => {
    const keywords = [kw(10, 100, 8, 80, null, "stable")];
    const stats = aggregateClusterPrior(keywords, 10, 100, true);
    expect(stats.stateCounts!.new).toBe(0);
    expect(stats.stateCounts!.rising).toBe(0);
    expect(stats.stateCounts!.displaced).toBe(0);
    expect(stats.stateCounts!.zero_click).toBe(0);
    expect(stats.stateCounts!.striking_distance).toBe(0);
  });

  it("handles mixed keywords — some with prior, some with null prior", () => {
    // One keyword with prior data, one without (null priorImpressions).
    // The null-prior keyword contributes 0 to prior totals.
    // currentTotal=30/300, priorTotal=8/80
    const keywords = [
      kw(10, 100, 8, 80, null, "stable"),
      kw(20, 200, null, null), // no prior fields — contributes 0 to prior totals
    ];
    const stats = aggregateClusterPrior(keywords, 30, 300, true);
    expect(stats.priorTotalClicks).toBe(8);
    expect(stats.priorTotalImpressions).toBe(80);
    // Abs delta includes the full current of the null-prior keyword (treated as 0 prior)
    expect(stats.impressionDeltaAbs).toBe(220); // 300 - 80
    expect(stats.clickDeltaAbs).toBe(22);       // 30 - 8
  });

  // ── isComparisonRun=false (legacy run — params.window absent) ────────────
  // These tests encode the invariant that the run-level signal (params.window)
  // is the authoritative gate, NOT keyword-level prior field presence.

  it("legacy run: isComparisonRun=false → all comparison fields null regardless of keyword content", () => {
    // Keywords have prior data but isComparisonRun=false (simulates legacy run
    // that happened to store prior fields — shouldn't happen in practice but
    // the gate must be airtight).
    const keywords = [kw(10, 100, 8, 80, null, "stable")];
    const stats = aggregateClusterPrior(keywords, 10, 100, false);
    expect(stats.priorTotalClicks).toBeNull();
    expect(stats.priorTotalImpressions).toBeNull();
    expect(stats.priorBlendedCtr).toBeNull();
    expect(stats.priorAvgPosition).toBeNull();
    expect(stats.clickDeltaAbs).toBeNull();
    expect(stats.impressionDeltaAbs).toBeNull();
    expect(stats.clickDeltaRatio).toBeNull();
    expect(stats.impressionDeltaRatio).toBeNull();
    expect(stats.stateCounts).toBeNull();
  });

  it("legacy run: default isComparisonRun (omitted = false) → all comparison fields null", () => {
    // The default value is false, so omitting the parameter gives legacy behavior.
    const keywords = [kw(10, 100, 8, 80)];
    const stats = aggregateClusterPrior(keywords, 10, 100);
    expect(stats.priorTotalClicks).toBeNull();
    expect(stats.stateCounts).toBeNull();
  });

  // ── All-new fresh cluster (the original bug) ──────────────────────────────
  // A fresh comparison run where every keyword is "new" (priorImpressions=0).
  // This was previously indistinguishable from a legacy run at the keyword
  // level (all prior fields look "zero"), but the run-level signal
  // (isComparisonRun=true) now correctly produces real aggregates.

  it("all-new fresh cluster: isComparisonRun=true → prior totals=0, abs deltas=current totals, stateCounts populated", () => {
    const keywords = [
      kw(20, 200, 0, 0, null, "new"),
      kw(10, 100, 0, 0, null, "new"),
    ];
    const stats = aggregateClusterPrior(keywords, 30, 300, true);
    // Prior totals are zero (all keywords are new)
    expect(stats.priorTotalClicks).toBe(0);
    expect(stats.priorTotalImpressions).toBe(0);
    // Abs deltas = currentTotal - priorTotal = currentTotal - 0
    expect(stats.clickDeltaAbs).toBe(30);
    expect(stats.impressionDeltaAbs).toBe(300);
    // Ratio deltas null (denominator = 0)
    expect(stats.clickDeltaRatio).toBeNull();
    expect(stats.impressionDeltaRatio).toBeNull();
    // stateCounts is populated (not null)
    expect(stats.stateCounts).not.toBeNull();
    expect(stats.stateCounts!.new).toBe(2);
    expect(stats.stateCounts!.stable).toBe(0);
  });

  it("all-new fresh cluster: isComparisonRun=false would suppress all fields (legacy gate holds)", () => {
    // Same cluster data, but run has no params.window → must look like legacy
    const keywords = [
      kw(20, 200, 0, 0, null, "new"),
      kw(10, 100, 0, 0, null, "new"),
    ];
    const stats = aggregateClusterPrior(keywords, 30, 300, false);
    expect(stats.priorTotalClicks).toBeNull();
    expect(stats.impressionDeltaAbs).toBeNull();
    expect(stats.stateCounts).toBeNull();
  });
});

// ─── Integration: computeRunWindow + weeklyChunks coverage ───────────────────

describe("computeRunWindow + weeklyChunks full coverage", () => {
  it("chunks for current period cover exactly the current period for any weeks 4–52", () => {
    const now = new Date("2026-08-12T00:00:00Z");
    for (const weeks of [4, 8, 12, 26, 52]) {
      const w = computeRunWindow(weeks, now);
      const chunks = weeklyChunks(w.currentStart, w.currentEnd);
      expect(chunks).toHaveLength(weeks);
      expect(chunks[0]!.start).toBe(w.currentStart);
      expect(chunks[chunks.length - 1]!.end).toBe(w.currentEnd);
    }
  });

  it("chunks for prior period cover exactly the prior period", () => {
    const now = new Date("2026-08-12T00:00:00Z");
    const w = computeRunWindow(4, now);
    const chunks = weeklyChunks(w.priorStart, w.priorEnd);
    expect(chunks[0]!.start).toBe(w.priorStart);
    expect(chunks[chunks.length - 1]!.end).toBe(w.priorEnd);
  });
});
