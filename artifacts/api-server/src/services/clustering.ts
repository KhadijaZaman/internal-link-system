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
 */

export const MIN_COMMON_URLS = 3;
export const MIN_OVERLAP = 0.1;
const LOWER_PERCENTILE = 0.2;
const UPPER_PERCENTILE = 0.9;

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
