/**
 * Pure, shared SEO insight primitives.
 *
 * Single source of truth for the CTR benchmark curve, underperformance
 * thresholds, cannibalization rules, and the opportunity score used by the
 * action queue. Read-time routes (GSC pages/queries, reports) and the action
 * queue recompute must import from here — never re-declare these constants,
 * or the dashboard's inline flags will drift from the Action Queue's.
 */

/**
 * Median organic CTR by rounded position (blended benchmark, conservative to
 * account for SERP features absorbing clicks). Used to spot pages that rank
 * well but under-earn clicks — the classic title/meta rewrite opportunity.
 */
export const EXPECTED_CTR: Record<number, number> = {
  1: 0.28,
  2: 0.15,
  3: 0.1,
  4: 0.075,
  5: 0.06,
  6: 0.045,
  7: 0.035,
  8: 0.03,
  9: 0.025,
  10: 0.022,
};

/** Flag CTR only when it's below this fraction of the position norm. */
export const CTR_UNDERPERFORM_RATIO = 0.5;
/** Impressions needed for a stable CTR read (per week in the action queue; per selected range in read-time reports). */
export const CTR_MIN_IMPRESSIONS = 100;
/** Weekly missed clicks below this aren't worth an action-queue slot. */
export const CTR_MIN_MISSED_CLICKS = 5;
/** Cannibalization: query needs this much volume to matter. */
export const CANNIBAL_MIN_QUERY_IMPRESSIONS = 100;
/** ...and each contender must hold at least this share of it. */
export const CANNIBAL_MIN_SHARE = 0.2;
/** Contenders ranking worse than this aren't really competing. */
export const CANNIBAL_MAX_POSITION = 20;

/** Benchmark CTR for a (fractional) position — null outside the top 10. */
export function expectedCtrFor(position: number): number | null {
  return EXPECTED_CTR[Math.round(position)] ?? null;
}

/**
 * Action-queue opportunity score: weight x (1 + log10(1 + impressions)) so
 * pages with real demand rank first but one huge page can't drown the rest.
 */
export function scoreOf(weight: number, impressions: number): number {
  return Math.round(weight * (1 + Math.log10(1 + Math.max(0, impressions))) * 10) / 10;
}

export interface CtrInsight {
  /** Benchmark CTR for this position, null when outside the top 10. */
  expectedCtr: number | null;
  /** "underperforming" when CTR is far below the position norm on real volume. */
  ctrFlag: "underperforming" | null;
  /** Estimated clicks lost vs the benchmark over the measured window (0 when not flagged). */
  missedClicks: number;
}

/**
 * Per-row CTR verdict for read-time tables. Mirrors the action queue's
 * improve_ctr rules: top-10 position, >= CTR_MIN_IMPRESSIONS volume, CTR
 * below CTR_UNDERPERFORM_RATIO x the position norm.
 */
export function ctrInsight(position: number, ctr: number, impressions: number): CtrInsight {
  const expected = expectedCtrFor(position);
  if (expected === null || impressions <= 0) {
    return { expectedCtr: expected, ctrFlag: null, missedClicks: 0 };
  }
  const underperforming = impressions >= CTR_MIN_IMPRESSIONS && ctr < expected * CTR_UNDERPERFORM_RATIO;
  if (!underperforming) {
    return { expectedCtr: expected, ctrFlag: null, missedClicks: 0 };
  }
  const missed = Math.max(0, Math.round(impressions * (expected - ctr)));
  return { expectedCtr: expected, ctrFlag: "underperforming", missedClicks: missed };
}

/** Engagement rate below this on a well-ranking page means the content disappoints. */
export const WEAK_ENGAGEMENT_RATE = 0.4;
/** GA4 sessions needed before engagement/conversion verdicts are trustworthy. */
export const ENGAGEMENT_MIN_SESSIONS = 20;
/** Impressions needed before "no key events" is a signal rather than noise. */
export const CONVERSION_MIN_IMPRESSIONS = 1000;

export type PageVerdict = "low_ctr" | "weak_engagement" | "no_conversions" | "ai_only";

/**
 * Cross-source page verdicts for the Page Report (GSC ranking + GA4
 * behavior). Each verdict names a specific, actionable mismatch:
 * - low_ctr: ranks top-10 but the snippet loses the click (same rule as ctrInsight)
 * - weak_engagement: Google ranks it well, visitors bounce fast — content gap
 * - no_conversions: real search traffic, zero key events — missing CTA/intent mismatch
 * - ai_only: AI assistants cite it but Google sends nothing — snippet/SERP problem
 * GA4-dependent verdicts are gated on ENGAGEMENT_MIN_SESSIONS so a GA4 outage
 * (sessions=0) silently suppresses them instead of mass-flagging.
 */
export function pageVerdicts(row: {
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  sessions: number;
  engagementRate: number;
  keyEvents: number;
  aiSessions: number;
}): PageVerdict[] {
  const out: PageVerdict[] = [];
  if (ctrInsight(row.position, row.ctr, row.impressions).ctrFlag === "underperforming") {
    out.push("low_ctr");
  }
  if (
    row.impressions >= CTR_MIN_IMPRESSIONS &&
    expectedCtrFor(row.position) !== null &&
    row.sessions >= ENGAGEMENT_MIN_SESSIONS &&
    row.engagementRate < WEAK_ENGAGEMENT_RATE
  ) {
    out.push("weak_engagement");
  }
  if (
    row.impressions >= CONVERSION_MIN_IMPRESSIONS &&
    row.sessions >= ENGAGEMENT_MIN_SESSIONS &&
    row.keyEvents === 0
  ) {
    out.push("no_conversions");
  }
  if (row.aiSessions > 0 && row.clicks === 0) {
    out.push("ai_only");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Existing-link quality (audit_link_quality job). Thresholds follow the
// Similarity Explorer scale for text-embedding-3-small cosines (compressed
// range): <0.35 between two articles means they share almost no topical
// ground, so a content link between them is off-topic.
// ---------------------------------------------------------------------------
export const LINK_OFF_TOPIC_SIMILARITY = 0.35;

export type LinkQualityFlag = "off_topic" | "tier_violation" | "generic_anchor";

/**
 * Flags for one existing content link. Pure — callers resolve embeddings/
 * tiers and pass the results in. `tierViolation` and `anchorBanned` are
 * pre-computed by the caller (tierAllowed / isBannedAnchor from
 * semanticScorer) so this stays dependency-free and unit-testable.
 */
export function linkQualityFlags(edge: {
  /** source→target embedding cosine; null when either embedding is missing. */
  similarity: number | null;
  /** true when both tiers are known AND the donor→receiver flow is disallowed. */
  tierViolation: boolean;
  /** true when the anchor text is a banned/generic anchor. */
  anchorBanned: boolean;
}): LinkQualityFlag[] {
  const out: LinkQualityFlag[] = [];
  if (edge.similarity !== null && edge.similarity < LINK_OFF_TOPIC_SIMILARITY) {
    out.push("off_topic");
  }
  if (edge.tierViolation) out.push("tier_violation");
  if (edge.anchorBanned) out.push("generic_anchor");
  return out;
}

export interface CannibalCandidate {
  impressions: number;
  clicks: number;
  position: number;
}

/**
 * Given all pages competing on one query (plus the query's TOTAL impressions
 * across all pages, pre-filtering), return the real contenders sorted
 * primary-first (most clicks, then better position). Returns [] when the
 * query is too small or fewer than two pages hold a meaningful share —
 * i.e. an empty result means "not cannibalized".
 */
export function pickCannibalContenders<T extends CannibalCandidate>(
  candidates: T[],
  queryTotalImpressions: number,
): T[] {
  if (candidates.length < 2) return [];
  if (queryTotalImpressions < CANNIBAL_MIN_QUERY_IMPRESSIONS) return [];
  const contenders = candidates.filter(
    (x) =>
      x.impressions / queryTotalImpressions >= CANNIBAL_MIN_SHARE &&
      x.position <= CANNIBAL_MAX_POSITION,
  );
  if (contenders.length < 2) return [];
  return contenders
    .slice()
    .sort((a, b) => b.clicks - a.clicks || a.position - b.position);
}
