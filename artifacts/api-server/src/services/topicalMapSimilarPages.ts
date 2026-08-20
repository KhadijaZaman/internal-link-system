export const CLUSTER_SIMILARITY_THRESHOLD = 0.42;

export interface EmbeddedSitePage {
  path: string;
  title: string | null;
  embedding: number[];
}

export interface PillarAnchorSet {
  nodeId: number;
  anchorPaths: string[];
}

export interface SimilarClusterPage {
  path: string;
  title: string | null;
  similarity: number;
}

interface PreparedEmbedding {
  vector: number[];
  norm: number;
}

interface PreparedPage {
  title: string | null;
  embeddings: PreparedEmbedding[];
}

function prepareEmbedding(vector: number[]): PreparedEmbedding | null {
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  if (squaredNorm === 0) return null;
  return { vector, norm: Math.sqrt(squaredNorm) };
}

function preparedCosine(a: PreparedEmbedding, b: PreparedEmbedding): number {
  if (a.vector.length === 0 || a.vector.length !== b.vector.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.vector.length; i++) {
    dot += a.vector[i]! * b.vector[i]!;
  }
  return dot / (a.norm * b.norm);
}

/**
 * Relates site pages to every pillar whose existing matched pages are
 * semantically similar. This intentionally uses a lower threshold than the
 * separate 0.65 node-coverage gate: these results describe related pages,
 * not proof that a generated topic is already covered.
 */
export function matchSimilarPagesByPillar(
  pillars: PillarAnchorSet[],
  pages: EmbeddedSitePage[],
  threshold = CLUSTER_SIMILARITY_THRESHOLD,
): Map<number, SimilarClusterPage[]> {
  const pagesByPath = new Map<string, PreparedPage>();
  for (const page of pages) {
    const prepared = prepareEmbedding(page.embedding);
    if (prepared === null) continue;
    const existing = pagesByPath.get(page.path);
    if (existing) {
      existing.embeddings.push(prepared);
      if (existing.title === null && page.title !== null) existing.title = page.title;
    } else {
      pagesByPath.set(page.path, {
        title: page.title,
        embeddings: [prepared],
      });
    }
  }

  const matchesByPillar = new Map<number, SimilarClusterPage[]>();
  for (const pillar of pillars) {
    const anchorPaths = [...new Set(pillar.anchorPaths)];
    const anchorEmbeddings = anchorPaths.flatMap(
      (path) => pagesByPath.get(path)?.embeddings ?? [],
    );
    if (anchorEmbeddings.length === 0) {
      matchesByPillar.set(pillar.nodeId, []);
      continue;
    }

    const matches: SimilarClusterPage[] = [];
    for (const [path, page] of pagesByPath) {
      let bestSimilarity = 0;
      for (const variant of page.embeddings) {
        for (const anchor of anchorEmbeddings) {
          bestSimilarity = Math.max(bestSimilarity, preparedCosine(variant, anchor));
        }
      }
      if (bestSimilarity < threshold) continue;

      matches.push({
        path,
        title: page.title,
        similarity: Math.round(bestSimilarity * 1000) / 1000,
      });
    }

    matches.sort(
      (a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path),
    );
    matchesByPillar.set(pillar.nodeId, matches);
  }

  return matchesByPillar;
}