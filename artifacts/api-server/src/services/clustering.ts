/**
 * Pure keyword-clustering math for the keyword_clustering job.
 *
 * Port of the operator's Python notebook:
 * - edge between two keywords when they share >= MIN_COMMON_URLS ranking URLs
 *   AND overlap |A∩B| / min(|A|,|B|) >= MIN_OVERLAP
 * - clusters = connected components (union-find + inverted url→keyword index,
 *   never the O(n²) pairwise loop)
 * - cluster topic = keyword with highest average pairwise TF-IDF cosine
 *   similarity (sklearn-style idf), falling back to the shortest keyword
 * - quadrants from medians computed on a percentile-filtered set
 *   (drop bottom 20% / top 10% by impressions)
 *
 * Also exports pure helpers for GSC date-range computation, weekly chunk
 * slicing, multi-chunk aggregation, keyword-state classification, query
 * normalization, and GSC-page clustering — used by keywordClustering.ts and
 * unit-tested independently.
 */

export const MIN_COMMON_URLS = 3;
export const MIN_OVERLAP = 0.1;
const LOWER_PERCENTILE = 0.2;
const UPPER_PERCENTILE = 0.9;

// ─── Classification thresholds ───────────────────────────────────────────────

/** Minimum impressions in the current period for a query to get a non-stable
 *  state classification (zero_click / striking_distance). */
export const MIN_IMPRESSIONS = 10;
/** Ratio threshold for "rising": impressionDelta > RISING_THRESHOLD. */
export const RISING_THRESHOLD = 0.3;
/** Ratio threshold for "displaced": clickDelta < DISPLACED_CLICK_THRESHOLD. */
export const DISPLACED_CLICK_THRESHOLD = -0.3;
/** Ratio threshold for "displaced": |impressionDelta| <= this value. */
export const DISPLACED_IMP_ABS_THRESHOLD = 0.1;
/** CTR below this is "zero_click" (requires MIN_IMPRESSIONS). */
export const ZERO_CLICK_CTR = 0.005;
/** Position range [STRIKING_DISTANCE_LOW..STRIKING_DISTANCE_HIGH] inclusive. */
export const STRIKING_DISTANCE_LOW = 5;
export const STRIKING_DISTANCE_HIGH = 15;

// ─── GSC-page clustering constants ───────────────────────────────────────────

/**
 * A page is suppressed from evidence when it exceeds either 20% of the
 * eligible queries or 25 queries. A small-query floor keeps legitimate compact
 * clusters from being mistaken for hubs.
 */
export const HUB_FIXED_THRESHOLD = 25;
export const HUB_MIN_THRESHOLD = 5;
export const HUB_FRACTION = 0.2;

/**
 * A shared page creates an edge between two queries only when its impressions
 * are >= this fraction of each query's total retained-page impressions.
 */
export const PAGE_SHARE_THRESHOLD = 0.2;

/** Algorithm version tag for the current GSC-page clustering logic. */
export const GSC_PAGE_ALGORITHM_VERSION = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

import type { KeywordState, ClusterGscPageEntry } from "@workspace/db";

export interface GscPeriodMetrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** A pair of current+prior aggregated metrics for a single normalized query. */
export interface AggregatedQueryMetrics {
  query: string;
  current: GscPeriodMetrics;
  /** null when the query had no impressions in the prior period. */
  prior: GscPeriodMetrics | null;
}

// ─── Query normalization ──────────────────────────────────────────────────────

/**
 * Normalize a raw GSC query string for deduplication and filtering.
 *
 * Rules (applied in order):
 *  1. Unicode NFKC normalization (collapses compatibility variants, curly
 *     quotes → straight quotes, ligatures, etc.)
 *  2. Trim leading/trailing whitespace.
 *  3. Collapse internal whitespace runs to a single space.
 *  4. Lowercase.
 *
 * This is the single centralized normalization function. Apply it before:
 *  - deduplication
 *  - brand exclusion
 *  - isOperatorQuery
 *  - query selection
 *  - page matching
 *  - rebuild from stored entries
 */
export function normalizeQuery(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// ─── Request discrimination / weeks resolution ────────────────────────────────

/** Default weeks used when neither weeks nor days is supplied. */
export const DEFAULT_WEEKS = 12;

/**
 * Resolve the effective number of weeks for a clustering run from the raw
 * request body fields.
 *
 * Discrimination rules (explicit wins over derived):
 *  1. `weeks` explicitly supplied and is a safe integer in [4..52] → use it.
 *  2. `days` explicitly supplied and is a safe integer in [7..180] → convert
 *     to nearest whole weeks, clamped to [4..52].
 *  3. Neither supplied → DEFAULT_WEEKS (12).
 *
 * Fractional values for either field are rejected (returns null).
 * Out-of-range values are rejected (returns null).
 *
 * @returns The resolved integer weeks, or null if validation fails.
 */
export function resolveRunWeeks(rawBody: {
  weeks?: unknown;
  days?: unknown;
}): number | null {
  const weeksRaw = rawBody.weeks;
  const daysRaw = rawBody.days;

  // weeks wins when explicitly supplied
  if (weeksRaw !== undefined) {
    if (
      typeof weeksRaw !== "number" ||
      !Number.isInteger(weeksRaw) ||
      weeksRaw < 4 ||
      weeksRaw > 52
    ) {
      return null; // reject fractional or out-of-range
    }
    return weeksRaw;
  }

  // days fallback when explicitly supplied
  if (daysRaw !== undefined) {
    if (
      typeof daysRaw !== "number" ||
      !Number.isInteger(daysRaw) ||
      daysRaw < 7 ||
      daysRaw > 180
    ) {
      return null; // reject fractional or out-of-range
    }
    const w = Math.round(daysRaw / 7);
    return Math.max(4, Math.min(52, w));
  }

  // Neither supplied — use default
  return DEFAULT_WEEKS;
}

// ─── Date / range helpers ─────────────────────────────────────────────────────

/**
 * Format a Date as ISO YYYY-MM-DD using UTC components.
 * Exported for tests.
 */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the current and prior date windows for a clustering run.
 *
 * Rules (all UTC):
 *  - End date = today − 3 days  (finalized GSC data, 3-day lag)
 *  - Current period = [end − weeks*7 + 1 … end]  (weeks*7 days inclusive)
 *  - Prior period   = [end − weeks*14 … end − weeks*7]  (same length, adjacent)
 *
 * Example with weeks=2, today=2026-08-12:
 *  end          = 2026-08-09
 *  currentStart = 2026-07-27  (end - 13 days = end - 2*7 + 1)
 *  currentEnd   = 2026-08-09
 *  priorEnd     = 2026-07-26  (currentStart - 1)
 *  priorStart   = 2026-07-12  (priorEnd - 13 days)
 *
 * @param weeks  Number of weeks in each period (4–52)
 * @param now    Reference date (default: current UTC date); used by tests
 */
export function computeRunWindow(
  weeks: number,
  now: Date = new Date(),
): { currentStart: string; currentEnd: string; priorStart: string; priorEnd: string } {
  const days = weeks * 7;
  // End = today − 3 days (UTC)
  const endMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ) - 3 * 86_400_000;
  const end = new Date(endMs);

  const currentStartMs = endMs - (days - 1) * 86_400_000;
  const currentStart = new Date(currentStartMs);

  const priorEndMs = currentStartMs - 86_400_000;
  const priorEnd = new Date(priorEndMs);

  const priorStartMs = priorEndMs - (days - 1) * 86_400_000;
  const priorStart = new Date(priorStartMs);

  return {
    currentStart: isoDay(currentStart),
    currentEnd: isoDay(end),
    priorStart: isoDay(priorStart),
    priorEnd: isoDay(priorEnd),
  };
}

/**
 * Slice a date range into non-overlapping 7-day chunks, each represented as
 * { start, end } ISO strings.
 *
 * The last chunk may be shorter than 7 days if the range is not a multiple
 * of 7 (but for our use-case weeks * 7 is always exact).
 *
 * @param startIso  First day of the range (inclusive)
 * @param endIso    Last day of the range (inclusive)
 */
export function weeklyChunks(
  startIso: string,
  endIso: string,
): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  const rangeEndMs = Date.parse(endIso);
  let chunkStartMs = Date.parse(startIso);

  while (chunkStartMs <= rangeEndMs) {
    // end of this chunk = min(chunkStart + 6 days, rangeEnd)
    const chunkEndMs = Math.min(chunkStartMs + 6 * 86_400_000, rangeEndMs);
    chunks.push({
      start: isoDay(new Date(chunkStartMs)),
      end: isoDay(new Date(chunkEndMs)),
    });
    chunkStartMs = chunkEndMs + 86_400_000;
  }
  return chunks;
}

// ─── Raw GSC row type (mirrors GscDimensionRow without the import cycle) ─────

export interface RawGscRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Aggregate multiple GSC chunks (each being an array of rows for one 7-day
 * window) into a Map from normalized query → summed metrics.
 *
 * Aggregation rules:
 *  - clicks and impressions are summed
 *  - CTR is recomputed as clicks / impressions
 *  - position is impression-weighted average
 *
 * Normalization: query keys are NFKC-normalized, trimmed, whitespace-collapsed,
 * and lowercased via normalizeQuery() so variant forms merge.
 *
 * Queries with 0 total impressions across all chunks are retained (they will
 * be filtered by the caller as needed).
 */
export function aggregateGscChunks(
  chunks: RawGscRow[][],
): Map<string, GscPeriodMetrics> {
  const acc = new Map<
    string,
    { clicks: number; impressions: number; posSum: number; posWeight: number }
  >();

  for (const rows of chunks) {
    for (const r of rows) {
      const q = normalizeQuery(r.key);
      if (!q) continue;
      const existing = acc.get(q);
      if (existing) {
        existing.clicks += r.clicks;
        existing.impressions += r.impressions;
        existing.posSum += r.position * Math.max(r.impressions, 0);
        existing.posWeight += Math.max(r.impressions, 0);
      } else {
        acc.set(q, {
          clicks: r.clicks,
          impressions: r.impressions,
          posSum: r.position * Math.max(r.impressions, 0),
          posWeight: Math.max(r.impressions, 0),
        });
      }
    }
  }

  const result = new Map<string, GscPeriodMetrics>();
  for (const [q, v] of acc) {
    result.set(q, {
      clicks: Math.round(v.clicks),
      impressions: Math.round(v.impressions),
      ctr: v.impressions > 0 ? v.clicks / v.impressions : 0,
      position: v.posWeight > 0 ? v.posSum / v.posWeight : 0,
    });
  }
  return result;
}

// ─── Keyword state classification ─────────────────────────────────────────────

/**
 * Classify a keyword's performance state based on current vs prior metrics.
 *
 * Precedence (later assignments win, matching pandas semantics):
 *   stable → rising → displaced → zero_click → striking_distance → new
 *
 * Rules:
 *  - "new"               when priorImpressions === 0 (no prior exposure)
 *  - "rising"            impressionDelta > RISING_THRESHOLD (0.30)
 *  - "displaced"         clickDelta < DISPLACED_CLICK_THRESHOLD (-0.30) AND
 *                        |impressionDelta| <= DISPLACED_IMP_ABS_THRESHOLD (0.10)
 *  - "zero_click"        current impressions >= MIN_IMPRESSIONS AND ctr < ZERO_CLICK_CTR
 *  - "striking_distance" current impressions >= MIN_IMPRESSIONS AND
 *                        position in [STRIKING_DISTANCE_LOW, STRIKING_DISTANCE_HIGH]
 *  - "new"               prior impressions === 0 (repeated here so it overwrites anything)
 *
 * When priorImpressions === 0, ratio deltas are null (never Infinity).
 * Low-volume queries (current impressions < MIN_IMPRESSIONS) cannot become
 * zero_click or striking_distance.
 */
export function classifyKeyword(
  current: GscPeriodMetrics,
  prior: GscPeriodMetrics | null,
): {
  state: KeywordState;
  clickDelta: number | null;
  impressionDelta: number | null;
  clickDeltaAbs: number | null;
  impressionDeltaAbs: number | null;
} {
  const priorImpressions = prior?.impressions ?? 0;
  const priorClicks = prior?.clicks ?? 0;

  const clickDeltaAbs = prior !== null ? current.clicks - priorClicks : null;
  const impressionDeltaAbs = prior !== null ? current.impressions - priorImpressions : null;

  // Ratio deltas: null when prior impressions = 0 or no prior data
  const clickDelta =
    prior !== null && priorClicks > 0
      ? (current.clicks - priorClicks) / priorClicks
      : null;
  const impressionDelta =
    prior !== null && priorImpressions > 0
      ? (current.impressions - priorImpressions) / priorImpressions
      : null;

  // Classify using pandas-style precedence (later overwrites earlier)
  let state: KeywordState = "stable";

  // rising
  if (impressionDelta !== null && impressionDelta > RISING_THRESHOLD) {
    state = "rising";
  }

  // displaced
  if (
    clickDelta !== null &&
    impressionDelta !== null &&
    clickDelta < DISPLACED_CLICK_THRESHOLD &&
    Math.abs(impressionDelta) <= DISPLACED_IMP_ABS_THRESHOLD
  ) {
    state = "displaced";
  }

  // zero_click (requires enough volume)
  if (current.impressions >= MIN_IMPRESSIONS && current.ctr < ZERO_CLICK_CTR) {
    state = "zero_click";
  }

  // striking_distance (requires enough volume)
  if (
    current.impressions >= MIN_IMPRESSIONS &&
    current.position >= STRIKING_DISTANCE_LOW &&
    current.position <= STRIKING_DISTANCE_HIGH
  ) {
    state = "striking_distance";
  }

  // new (highest precedence — overwrites everything)
  if (priorImpressions === 0) {
    state = "new";
  }

  return { state, clickDelta, impressionDelta, clickDeltaAbs, impressionDeltaAbs };
}

// ─── Cluster-level prior aggregation ─────────────────────────────────────────

export interface ClusterPriorStats {
  /** null for legacy runs that never collected comparison data. */
  priorTotalClicks: number | null;
  /** null for legacy runs. */
  priorTotalImpressions: number | null;
  /** null for legacy runs. */
  priorBlendedCtr: number | null;
  /** null for legacy runs or when no keyword had a prior position. */
  priorAvgPosition: number | null;
  /** null for legacy runs or when priorTotal denominator is zero. */
  clickDeltaAbs: number | null;
  /** null for legacy runs or when priorTotal denominator is zero. */
  impressionDeltaAbs: number | null;
  /** (currentTotal - priorTotal) / priorTotal for clicks; null if prior = 0 or legacy */
  clickDeltaRatio: number | null;
  /** (currentTotal - priorTotal) / priorTotal for impressions; null if prior = 0 or legacy */
  impressionDeltaRatio: number | null;
  /** Count of keywords for each state in this cluster; null for legacy runs. */
  stateCounts: Record<KeywordState, number> | null;
}

/**
 * Aggregate cluster-level prior stats from an array of keyword entries that
 * already have their prior_* and state fields populated.
 *
 * @param isComparisonRun  Pass `true` for runs that fetched prior GSC data
 *   (identified by `params.window` being present on the run row). Pass `false`
 *   for legacy runs that never collected comparison data — all aggregate
 *   comparison fields will be null regardless of keyword content.
 *
 * Semantics when isComparisonRun = true:
 *  - "new" keywords (state=new, priorImpressions=0) ARE part of the compared run
 *    and contribute priorImpressions=0 / priorClicks=0 to the aggregate prior totals.
 *  - Cluster absolute deltas are computed as `currentTotal − priorTotal` (not by
 *    summing per-keyword deltas), so "new" keywords' full current metrics are
 *    automatically included without any special-case logic.
 *  - Ratio deltas remain null whenever the aggregate priorTotal denominator is zero
 *    (e.g. a cluster that is entirely new queries has priorImpressions=0 in total,
 *    making the ratio undefined, but abs deltas and stateCounts are still returned).
 */
export function aggregateClusterPrior(
  keywords: Array<{
    clicks: number;
    impressions: number;
    priorClicks?: number | null;
    priorImpressions?: number | null;
    priorPosition?: number | null;
    state?: KeywordState | null;
  }>,
  currentTotalClicks: number,
  currentTotalImpressions: number,
  /** True iff this run collected prior GSC data (params.window is present). */
  isComparisonRun = false,
): ClusterPriorStats {
  // Legacy runs: return null for all comparison fields immediately.
  // We use the explicit run-level signal rather than inferring from keyword
  // fields, because an all-new cluster (every keyword state="new",
  // priorImpressions=0) would otherwise be indistinguishable from a legacy
  // run where all prior fields are null.
  const hasPrior = isComparisonRun;

  let priorClicks = 0;
  let priorImpressions = 0;
  let priorPosSum = 0;
  let priorPosWeight = 0;

  if (hasPrior) {
    for (const k of keywords) {
      // Keywords with null prior (absent from comparison) contribute 0 to
      // prior totals. This is correct: their full current metrics will already
      // be reflected in currentTotal, making the abs delta correct.
      priorClicks += k.priorClicks ?? 0;
      priorImpressions += k.priorImpressions ?? 0;
      const pi = k.priorImpressions ?? 0;
      priorPosSum += (k.priorPosition ?? 0) * pi;
      priorPosWeight += pi;
    }
  }

  // Legacy run: return null for every comparison field immediately.
  if (!hasPrior) {
    return {
      priorTotalClicks: null,
      priorTotalImpressions: null,
      priorBlendedCtr: null,
      priorAvgPosition: null,
      clickDeltaAbs: null,
      impressionDeltaAbs: null,
      clickDeltaRatio: null,
      impressionDeltaRatio: null,
      stateCounts: null,
    };
  }

  const stateCounts: Record<KeywordState, number> = {
    new: 0,
    rising: 0,
    displaced: 0,
    zero_click: 0,
    striking_distance: 0,
    stable: 0,
  };
  for (const k of keywords) {
    if (k.state) stateCounts[k.state] = (stateCounts[k.state] ?? 0) + 1;
  }

  // Absolute deltas: current cluster total minus prior cluster total.
  // This naturally includes "new" keywords (priorImpressions=0) so their full
  // current metrics count toward the cluster's growth. No per-keyword delta
  // summing needed — cluster-level subtraction is always correct.
  const clickDeltaAbs = Math.round(currentTotalClicks - priorClicks);
  const impressionDeltaAbs = Math.round(currentTotalImpressions - priorImpressions);

  return {
    priorTotalClicks: Math.round(priorClicks),
    priorTotalImpressions: Math.round(priorImpressions),
    priorBlendedCtr:
      priorImpressions > 0 ? (priorClicks / priorImpressions) * 100 : 0,
    priorAvgPosition:
      priorPosWeight > 0
        ? Number((priorPosSum / priorPosWeight).toFixed(1))
        : null,
    clickDeltaAbs,
    impressionDeltaAbs,
    clickDeltaRatio:
      priorClicks > 0
        ? (currentTotalClicks - priorClicks) / priorClicks
        : null,
    impressionDeltaRatio:
      priorImpressions > 0
        ? (currentTotalImpressions - priorImpressions) / priorImpressions
        : null,
    stateCounts,
  };
}

// ─── Union-Find (SERP overlap clustering) ────────────────────────────────────

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[i] !== root) {
      const next = this.parent[i]!;
      this.parent[i] = root;
      i = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * Group keywords into clusters by SERP URL overlap.
 * Returns arrays of keyword indices; singletons are NOT returned as clusters —
 * the caller treats them as unclustered.
 */
export function buildClusters(urlSets: Array<Set<string>>): number[][] {
  const n = urlSets.length;
  const uf = new UnionFind(n);

  // Inverted index: url -> keyword indices ranking for it.
  const urlToKeywords = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    for (const url of urlSets[i]!) {
      const list = urlToKeywords.get(url);
      if (list) list.push(i);
      else urlToKeywords.set(url, [i]);
    }
  }

  // Count common URLs only for pairs that share at least one URL.
  const pairCounts = new Map<number, number>();
  for (const list of urlToKeywords.values()) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const key = list[a]! * n + list[b]!;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  for (const [key, common] of pairCounts) {
    if (common < MIN_COMMON_URLS) continue;
    const i = Math.floor(key / n);
    const j = key % n;
    const overlap = common / Math.min(urlSets[i]!.size, urlSets[j]!.size);
    if (overlap >= MIN_OVERLAP) uf.union(i, j);
  }

  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const list = components.get(root);
    if (list) list.push(i);
    else components.set(root, [i]);
  }
  return [...components.values()].filter((c) => c.length >= 2);
}

/**
 * Detect Google search-operator / boolean queries that show up in GSC data
 * (mostly AI-agent "fan-out" searches, e.g. `"fintech" "founded in 2020"` or
 * `(fintech companies) and (uk)`). These are not human keywords: they pollute
 * clusters and produce topic labels full of inverted commas, so they are
 * excluded from clustering entirely.
 *
 * Detection is structural on purpose — a bare " and " / " or " test would
 * wrongly drop legitimate queries like "pros and cons of x".
 *
 * The input query should already be NFKC-normalized (via normalizeQuery) so
 * that curly/smart quotes are canonicalized to straight ASCII quotes before
 * the double-quote check fires. The regex also catches the original Unicode
 * curly quotes as a belt-and-suspenders fallback.
 */
const OPERATOR_PREFIX_RE =
  /(?:^|\s|-)(?:site|inurl|allinurl|intitle|allintitle|intext|allintext|filetype|related|cache):/;
const BOOLEAN_STRUCTURE_RE = /\)\s*(?:and|or|\||&)\s*\(/;

export function isOperatorQuery(query: string): boolean {
  const q = query.toLowerCase();
  // After NFKC normalization, curly quotes become straight quotes (\u201c → ").
  // The ASCII double-quote check handles the normalized form; the Unicode
  // check is a belt-and-suspenders fallback for un-normalized input.
  if (q.includes('"') || /[\u201c\u201d\u00ab\u00bb]/.test(q)) return true;
  if (OPERATOR_PREFIX_RE.test(q)) return true;
  if (BOOLEAN_STRUCTURE_RE.test(q)) return true;
  return false;
}

// ─── Query eligibility pipeline ──────────────────────────────────────────────

/**
 * Result returned by selectEligibleQueries.
 */
export interface EligibleQueryResult {
  /** Queries that passed all filters, in input order, up to `limit`. */
  queries: string[];
  /** Number of input entries that were dropped because they deduplicated to an
   *  already-seen normalized form (NFKC/case/whitespace equivalents). */
  duplicatesRemoved: number;
  /** Number of input entries dropped by the brand-token check. */
  brandFiltered: number;
  /** Number of input entries dropped by isOperatorQuery. */
  operatorFiltered: number;
}

/**
 * Centralized query eligibility pipeline shared by fresh runs and rebuilds.
 *
 * For each item in `input` (consumed in order):
 *  1. **Normalize** the query with normalizeQuery() (NFKC, trim, collapse
 *     whitespace, lowercase).
 *  2. **Skip empty** strings after normalization.
 *  3. **Dedupe** — skip if the normalized form was already seen (first-seen
 *     wins, preserving input order).
 *  4. **Brand filter** — if `brandToken` is non-empty, skip queries that
 *     contain it as a substring (brand token should already be normalized
 *     with normalizeQuery before passing in).
 *  5. **Operator filter** — skip queries that isOperatorQuery() flags.
 *  6. **Limit** — stop accepting once `limit` eligible queries are collected
 *     (pass `Infinity` or omit to accept all).
 *
 * Returns the eligible queries (normalized strings) plus per-stage drop counts
 * useful for run stats.
 *
 * @param input       Iterable of objects with at least a `query: string` field.
 * @param brandToken  Already-normalized brand token to exclude, or "" to skip
 *                    brand filtering.  Obtain via
 *                    `normalizeQuery(host.split(".")[0])` when excludeBrand.
 * @param limit       Maximum number of eligible queries to return.
 */
export function selectEligibleQueries(
  input: Iterable<{ query: string }>,
  brandToken: string,
  limit: number = Infinity,
): EligibleQueryResult {
  const queries: string[] = [];
  let duplicatesRemoved = 0;
  let brandFiltered = 0;
  let operatorFiltered = 0;
  const seen = new Set<string>();
  const normalizedBrandToken = normalizeQuery(brandToken);

  for (const item of input) {
    if (queries.length >= limit) break;

    const q = normalizeQuery(item.query);
    if (!q) continue;

    // Dedupe
    if (seen.has(q)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(q);

    // Brand filter
    if (normalizedBrandToken && q.includes(normalizedBrandToken)) {
      brandFiltered++;
      continue;
    }

    // Operator filter
    if (isOperatorQuery(q)) {
      operatorFiltered++;
      continue;
    }

    queries.push(q);
  }

  return { queries, duplicatesRemoved, brandFiltered, operatorFiltered };
}

// ─── GSC page URL canonicalization ───────────────────────────────────────────

/**
 * Canonicalize a GSC page URL for evidence matching:
 *  - Parse as URL (throws on invalid — caller should catch if needed)
 *  - Lowercase hostname
 *  - Remove fragment
 *  - Remove trailing slash from pathname (unless it is the root "/")
 *  - Preserve query string
 *  - Normalize http / https schemes (kept as-is; both forms are kept distinct)
 *
 * Returns the original string on parse error (best-effort).
 */
export function canonicalizePageUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    const search = u.search;
    return `${u.protocol}//${host}${path}${search}`;
  } catch {
    return raw;
  }
}

// ─── GSC query×page aggregation ──────────────────────────────────────────────

export interface RawGscQueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Aggregate multiple weekly GSC query×page chunks into a Map:
 *   normalizedQuery → Map<canonicalPageUrl, ClusterGscPageEntry>
 *
 * Rules:
 *  - Query key: normalizeQuery() (NFKC, trim, collapse whitespace, lowercase)
 *  - Page key: canonicalizePageUrl() (lowercase host, no fragment, no trailing slash)
 *  - clicks/impressions: summed across chunks
 *  - position: impression-weighted average across chunks
 *  - ctr: recomputed as clicks/impressions
 *
 * Rows with empty query or page (after normalization) are skipped.
 * Zero-impression rows are retained here; the caller filters them.
 */
export function aggregateGscQueryPageChunks(
  chunks: RawGscQueryPageRow[][],
): Map<string, Map<string, ClusterGscPageEntry>> {
  // query → page → accumulator
  const acc = new Map<
    string,
    Map<string, { clicks: number; impressions: number; posSum: number; posWeight: number }>
  >();

  for (const rows of chunks) {
    for (const r of rows) {
      const q = normalizeQuery(r.query);
      if (!q) continue;
      const page = canonicalizePageUrl(r.page);
      if (!page) continue;

      let pageMap = acc.get(q);
      if (!pageMap) {
        pageMap = new Map();
        acc.set(q, pageMap);
      }

      const existing = pageMap.get(page);
      if (existing) {
        existing.clicks += r.clicks;
        existing.impressions += r.impressions;
        existing.posSum += r.position * Math.max(r.impressions, 0);
        existing.posWeight += Math.max(r.impressions, 0);
      } else {
        pageMap.set(page, {
          clicks: r.clicks,
          impressions: r.impressions,
          posSum: r.position * Math.max(r.impressions, 0),
          posWeight: Math.max(r.impressions, 0),
        });
      }
    }
  }

  const result = new Map<string, Map<string, ClusterGscPageEntry>>();
  for (const [q, pageMap] of acc) {
    const pages = new Map<string, ClusterGscPageEntry>();
    for (const [page, v] of pageMap) {
      pages.set(page, {
        url: page,
        clicks: Math.round(v.clicks),
        impressions: Math.round(v.impressions),
        position: v.posWeight > 0 ? v.posSum / v.posWeight : 0,
      });
    }
    result.set(q, pages);
  }
  return result;
}

// ─── GSC-page clustering (pure) ──────────────────────────────────────────────

/**
 * Build clusters from GSC query×page evidence.
 *
 * Algorithm:
 *  1. For each query, collect its retained pages (non-zero impressions only).
 *  2. Compute a hub threshold: max(HUB_MIN_THRESHOLD, min(HUB_FIXED_THRESHOLD,
 *     ceil(HUB_FRACTION * N))) where N = number of eligible queries.
 *  3. Remove pages that appear in more queries than the hub threshold.
 *  4. For each query, compute total retained-page impressions.
 *  5. Connect two queries when they share at least one retained page whose
 *     impressions are >= PAGE_SHARE_THRESHOLD of EACH query's total
 *     retained-page impressions.
 *  6. Return connected components of size >= 2 as clusters (arrays of query indices).
 *
 * @param eligibleQueries   Array of query strings (already normalized).
 * @param queryPageEvidence Map from normalized query → Map<canonicalPageUrl, entry>
 *                          (zero-impression pages should already be removed, or
 *                          will be filtered here).
 * @returns Array of components, each being an array of indices into eligibleQueries.
 *          Singletons are omitted (callers treat them as unclustered).
 */
export function buildGscPageClusters(
  eligibleQueries: string[],
  queryPageEvidence: Map<string, Map<string, ClusterGscPageEntry>>,
): number[][] {
  const n = eligibleQueries.length;
  if (n === 0) return [];

  // Step 1: collect retained pages per query (non-zero impressions).
  const queryPages: Array<Map<string, ClusterGscPageEntry>> = eligibleQueries.map((q) => {
    const allPages = queryPageEvidence.get(q);
    if (!allPages) return new Map();
    const retained = new Map<string, ClusterGscPageEntry>();
    for (const [url, entry] of allPages) {
      if (entry.impressions > 0) retained.set(url, entry);
    }
    return retained;
  });

  // Step 2: compute hub threshold.
  const hubThreshold = Math.max(
    HUB_MIN_THRESHOLD,
    Math.min(HUB_FIXED_THRESHOLD, Math.ceil(HUB_FRACTION * n)),
  );

  // Step 3: count how many queries each page appears in.
  const pageQueryCount = new Map<string, number>();
  for (const pages of queryPages) {
    for (const url of pages.keys()) {
      pageQueryCount.set(url, (pageQueryCount.get(url) ?? 0) + 1);
    }
  }

  // Step 4: build per-query retained-page impression totals after hub removal.
  // retainedPages[i] = Map of pages for query i that survived hub suppression.
  const retainedPages: Array<Map<string, ClusterGscPageEntry>> = queryPages.map((pages) => {
    const retained = new Map<string, ClusterGscPageEntry>();
    for (const [url, entry] of pages) {
      if ((pageQueryCount.get(url) ?? 0) <= hubThreshold) {
        retained.set(url, entry);
      }
    }
    return retained;
  });

  // Step 5: total retained-page impressions per query.
  const totalImpressions: number[] = retainedPages.map((pages) => {
    let total = 0;
    for (const entry of pages.values()) total += entry.impressions;
    return total;
  });

  // Step 6: union-find — connect queries sharing a qualifying page.
  const uf = new UnionFind(n);

  // Build inverted index: page → query indices that retained it.
  const pageToQueries = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    for (const url of retainedPages[i]!.keys()) {
      const list = pageToQueries.get(url);
      if (list) list.push(i);
      else pageToQueries.set(url, [i]);
    }
  }

  // For each page shared by ≥2 queries, check the share threshold.
  for (const [url, queryIndices] of pageToQueries) {
    if (queryIndices.length < 2) continue;
    for (let a = 0; a < queryIndices.length; a++) {
      for (let b = a + 1; b < queryIndices.length; b++) {
        const i = queryIndices[a]!;
        const j = queryIndices[b]!;
        const totalI = totalImpressions[i]!;
        const totalJ = totalImpressions[j]!;
        if (totalI === 0 || totalJ === 0) continue;

        const impI = retainedPages[i]!.get(url)?.impressions ?? 0;
        const impJ = retainedPages[j]!.get(url)?.impressions ?? 0;
        const shareI = impI / totalI;
        const shareJ = impJ / totalJ;

        if (shareI >= PAGE_SHARE_THRESHOLD && shareJ >= PAGE_SHARE_THRESHOLD) {
          uf.union(i, j);
        }
      }
    }
  }

  // Collect components of size >= 2.
  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const list = components.get(root);
    if (list) list.push(i);
    else components.set(root, [i]);
  }
  return [...components.values()].filter((c) => c.length >= 2);
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
  "i", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to",
  "was", "what", "when", "where", "which", "who", "why", "will", "with",
  "you", "your", "can", "do", "does", "vs",
]);

function tokenize(kw: string): string[] {
  return kw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Pick the most representative keyword as the cluster topic: highest average
 * pairwise cosine similarity between sklearn-style TF-IDF vectors.
 * Fallback (all-zero vectors / degenerate cluster): shortest keyword.
 */
export function pickTopic(keywords: string[]): string {
  if (keywords.length === 0) return "";
  if (keywords.length === 1) return keywords[0]!;
  const shortest = keywords.reduce((a, b) => (b.length < a.length ? b : a));

  const tokenized = keywords.map(tokenize);
  const df = new Map<string, number>();
  for (const toks of tokenized) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const nDocs = keywords.length;

  // L2-normalized tf-idf vectors; idf = ln((1+n)/(1+df)) + 1 (sklearn default).
  const vectors: Array<Map<string, number>> = tokenized.map((toks) => {
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    let sumSq = 0;
    for (const [t, f] of tf) {
      const idf = Math.log((1 + nDocs) / (1 + (df.get(t) ?? 0))) + 1;
      const w = f * idf;
      vec.set(t, w);
      sumSq += w * w;
    }
    const norm = Math.sqrt(sumSq);
    if (norm > 0) for (const [t, w] of vec) vec.set(t, w / norm);
    return vec;
  });

  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < vectors.length; i++) {
    let total = 0;
    for (let j = 0; j < vectors.length; j++) {
      if (i === j) continue;
      const [small, large] =
        vectors[i]!.size <= vectors[j]!.size
          ? [vectors[i]!, vectors[j]!]
          : [vectors[j]!, vectors[i]!];
      let dot = 0;
      for (const [t, w] of small) {
        const other = large.get(t);
        if (other) dot += w * other;
      }
      total += dot;
    }
    const avg = total / (vectors.length - 1);
    if (avg > bestScore) {
      bestScore = avg;
      bestIdx = i;
    }
  }
  return bestIdx >= 0 ? keywords[bestIdx]! : shortest;
}

export type Quadrant = "opportunities" | "stars" | "niche" | "underperformers";

export interface QuadrantResult {
  quadrants: Quadrant[];
  isOutlier: boolean[];
  medianImpressions: number;
  medianCtr: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base]!;
  const upper = sorted[Math.min(base + 1, sorted.length - 1)]!;
  return lower + rest * (upper - lower);
}

/**
 * Assign a quadrant to every cluster. Medians are computed on the
 * percentile-filtered set (impressions within [p20, p90]); clusters outside
 * that band are flagged as outliers but still get a quadrant.
 */
export function assignQuadrants(
  rows: Array<{ impressions: number; ctrPercent: number }>,
): QuadrantResult {
  const sortedImp = rows.map((r) => r.impressions).sort((a, b) => a - b);
  const lowerBound = quantile(sortedImp, LOWER_PERCENTILE);
  const upperBound = quantile(sortedImp, UPPER_PERCENTILE);

  let filtered = rows.filter(
    (r) => r.impressions >= lowerBound && r.impressions <= upperBound,
  );
  if (filtered.length === 0) filtered = rows;

  const medImp = quantile(
    filtered.map((r) => r.impressions).sort((a, b) => a - b),
    0.5,
  );
  const medCtr = quantile(
    filtered.map((r) => r.ctrPercent).sort((a, b) => a - b),
    0.5,
  );

  const quadrants: Quadrant[] = rows.map((r) => {
    if (r.impressions > medImp && r.ctrPercent < medCtr) return "opportunities";
    if (r.impressions > medImp) return "stars";
    if (r.ctrPercent >= medCtr) return "niche";
    return "underperformers";
  });
  const isOutlier = rows.map(
    (r) => r.impressions < lowerBound || r.impressions > upperBound,
  );
  return { quadrants, isOutlier, medianImpressions: medImp, medianCtr: medCtr };
}
